import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrokerCoordinator, BrokerRole, NotebookRouter } from './broker';
import { executeLocalOperation } from './localOperations';
import { listOpenNotebooks } from './notebookOps';
import { registerNotebookTools } from './server';
import { isNotebookRef, notebookRefFor } from './notebookRefs';
import packageJson from '../package.json';

// Derive the MCP handshake version from the packaged extension metadata.
const EXTENSION_VERSION = packageJson.version;
let coordinator: BrokerCoordinator | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel;

function hasJupyter(): boolean {
    return vscode.extensions.getExtension('ms-toolsai.jupyter') !== undefined;
}

function windowLabel(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length) return folders.map((folder) => folder.name).join(', ');
    return 'Empty window';
}

function localRouter(): NotebookRouter {
    const windowId = crypto.randomUUID();
    const windowLabelValue = windowLabel();
    return {
        windowId,
        windowLabel: windowLabelValue,
        async listNotebooks() {
            return [{ windowId, windowLabel: windowLabelValue,
                notebooks: listOpenNotebooks().map((uri) => ({ notebookRef: notebookRefFor(windowId, uri), uri })) }];
        },
        async invokeNotebook(operation, notebookRef, args) {
            const uri = await resolveLocalNotebook(notebookRef);
            return executeLocalOperation(operation, { ...args, notebookRef: uri });
        },
        async invokeNotebooks(operation, notebookRefs, args = {}) {
            const refs = await Promise.all(notebookRefs.map((ref) => resolveLocalNotebook(ref)));
            return executeLocalOperation(operation, { ...args, notebookRefs: refs });
        },
        async invokeWindow(operation, args, targetWindowId = windowId) {
            if (targetWindowId !== windowId) throw new Error(`VS Code window '${targetWindowId}' is not available over stdio.`);
            return executeLocalOperation(operation, args);
        }
    };

    async function resolveLocalNotebook(ref: string): Promise<string> {
        const uris = listOpenNotebooks();
        if (isNotebookRef(ref)) {
            const matches = uris.filter((uri) => notebookRefFor(windowId, uri) === ref);
            if (matches.length !== 1) throw new Error(`Notebook reference '${ref}' is unknown, stale, or malformed.`);
            return matches[0];
        }
        if (ref.startsWith('nb_')) throw new Error(`Malformed notebook reference '${ref}'. Use a notebookRef from list_notebooks.`);
        const matches = uris.filter((uri) => uri.toLowerCase() === ref.toLowerCase());
        if (matches.length !== 1) throw new Error(`No connected VS Code window has notebook '${ref}' open.`);
        return matches[0];
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    output = vscode.window.createOutputChannel('Jupyter MCP Server');
    context.subscriptions.push(output);

    const cfg = vscode.workspace.getConfiguration('jupyterMcp');
    if (!cfg.get<boolean>('enabled', true)) {
        output.appendLine('[jupyter-mcp] disabled via jupyterMcp.enabled');
        return;
    }

    await startServer();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (!event.affectsConfiguration('jupyterMcp')) return;
            const current = vscode.workspace.getConfiguration('jupyterMcp');
            if (!current.get<boolean>('enabled', true)) {
                await stopServer();
                output.appendLine('[jupyter-mcp] disabled via settings; stopped');
                return;
            }
            output.appendLine('[jupyter-mcp] settings changed; restarting');
            await stopServer();
            await startServer();
        }),
        vscode.commands.registerCommand('jupyterMcp.refreshTools', async () => {
            vscode.window.showInformationMessage('Jupyter MCP: broker and notebook tools are running.');
        }),
        vscode.commands.registerCommand('jupyterMcp.showStatus', async () => {
            const url = coordinator?.url;
            if (!url) {
                vscode.window.showWarningMessage('Jupyter MCP broker is not reachable from this window.');
                return;
            }
            await vscode.env.clipboard.writeText(url);
            const pick = await vscode.window.showInformationMessage(`Jupyter MCP server: ${url} (copied to clipboard)`, 'Copy again');
            if (pick === 'Copy again') await vscode.env.clipboard.writeText(url);
        })
    );
}

async function startServer(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('jupyterMcp');
    const transport = cfg.get<string>('transport', 'http');
    const jupyter = hasJupyter();

    if (transport === 'stdio') {
        const stdio = new StdioServerTransport();
        const server = new McpServer({ name: 'jupyter-mcp-server', version: EXTENSION_VERSION });
        registerNotebookTools(server, localRouter(), jupyter);
        await server.connect(stdio);
        output.appendLine('[jupyter-mcp] stdio transport active (current window only)');
        return;
    }

    coordinator = new BrokerCoordinator({
        port: cfg.get<number>('port', 51303),
        label: windowLabel(),
        listLocalNotebooks: listOpenNotebooks,
        invokeLocal: executeLocalOperation,
        handleMcpRequest,
        onRoleChanged: updateStatusBar,
        log: (message) => output.appendLine(`[jupyter-mcp] ${message}`)
    });
    await coordinator.start();
}

async function handleMcpRequest(req: http.IncomingMessage, res: http.ServerResponse, router: NotebookRouter): Promise<void> {
    try {
        const sessionServer = new McpServer({ name: 'jupyter-mcp-server', version: EXTENSION_VERSION });
        registerNotebookTools(sessionServer, router, hasJupyter());
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsedBody: unknown;
        if (raw) {
            try { parsedBody = JSON.parse(raw); } catch { parsedBody = undefined; }
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await sessionServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
        output.appendLine(`[jupyter-mcp] MCP request error: ${String(error)}`);
        if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal MCP error');
        }
    }
}

function updateStatusBar(role: BrokerRole, url: string | undefined): void {
    statusBarItem?.dispose();
    statusBarItem = undefined;
    if (!url) return;
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.text = '$(notebook) MCP';
    status.tooltip = `Jupyter MCP Server\n${url}\n${role === 'broker' ? 'Broker owner' : 'Connected peer'}\nClick to copy URL`;
    status.command = 'jupyterMcp.showStatus';
    status.show();
    statusBarItem = status;
}

async function stopServer(): Promise<void> {
    statusBarItem?.dispose();
    statusBarItem = undefined;
    await coordinator?.stop();
    coordinator = undefined;
}

export async function deactivate(): Promise<void> {
    await stopServer();
}
