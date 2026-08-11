import * as vscode from 'vscode';
import * as http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerNotebookTools } from './server';

const EXTENSION_VERSION = '0.2.0';
let httpServer: http.Server | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel;

/** Whether the Jupyter extension is installed (kernel-backed tools depend on it). */
function hasJupyter(): boolean {
    return vscode.extensions.getExtension('ms-toolsai.jupyter') !== undefined;
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
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (!e.affectsConfiguration('jupyterMcp')) {
                return;
            }
            const c = vscode.workspace.getConfiguration('jupyterMcp');
            if (!c.get<boolean>('enabled', true)) {
                await stopServer();
                output.appendLine('[jupyter-mcp] disabled via settings; stopped');
                return;
            }
            output.appendLine('[jupyter-mcp] settings changed; restarting');
            await stopServer();
            await startServer();
        }),
        vscode.commands.registerCommand('jupyterMcp.refreshTools', async () => {
            vscode.window.showInformationMessage('Jupyter MCP: notebook tools are fixed; server running.');
        }),
        vscode.commands.registerCommand('jupyterMcp.showStatus', async () => {
            const url = getUrl();
            if (url) {
                await vscode.env.clipboard.writeText(url);
                const pick = await vscode.window.showInformationMessage(
                    `Jupyter MCP server: ${url} (copied to clipboard)`,
                    'Copy again'
                );
                if (pick === 'Copy again') {
                    await vscode.env.clipboard.writeText(url);
                }
            } else {
                vscode.window.showWarningMessage(
                    'Jupyter MCP server is not running in this window.'
                );
            }
        })
    );
}

async function startServer(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('jupyterMcp');
    const transport = cfg.get<string>('transport', 'http');
    const port = cfg.get<number>('port', 51303);

    if (transport === 'stdio') {
        const stdio = new StdioServerTransport();
        const server = new McpServer({ name: 'jupyter-mcp-server', version: EXTENSION_VERSION });
        registerNotebookTools(server, hasJupyter());
        await server.connect(stdio);
        output.appendLine('[jupyter-mcp] stdio transport active');
        return;
    }

    const mine = await tryListen(port);
    if (!mine) {
        output.appendLine(`[jupyter-mcp] port ${port} is already in use; choose a different jupyterMcp.port for this window.`);
        return;
    }
    output.appendLine(`[jupyter-mcp] MCP server listening on ${getUrl()}`);
    updateStatusBar();
}

/** Try to bind the configured loopback port. */
function tryListen(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const srv = http.createServer((req, res) => {
            void (async () => {
                try {
                    // Fresh McpServer per connection (SDK single-transport constraint).
                    const sessionServer = new McpServer({ name: 'jupyter-mcp-server', version: EXTENSION_VERSION });
                    registerNotebookTools(sessionServer, hasJupyter());
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    }
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let parsedBody: unknown;
                    if (raw) {
                        try {
                            parsedBody = JSON.parse(raw);
                        } catch {
                            parsedBody = undefined;
                        }
                    }
                    const transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: undefined,
                        onsessioninitialized: (id) => output.appendLine(`[jupyter-mcp] session: ${id}`)
                    });
                    await sessionServer.connect(transport);
                    await transport.handleRequest(req, res, parsedBody);
                } catch (err) {
                    output.appendLine(`[jupyter-mcp] request error: ${String(err)}`);
                    if (!res.headersSent) {
                        res.writeHead(500);
                        res.end('Internal MCP error');
                    }
                }
            })();
        });
        srv.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                output.appendLine(`[jupyter-mcp] port ${port} is already in use.`);
                resolve(false);
            } else {
                output.appendLine(`[jupyter-mcp] listen error: ${err.message}`);
                resolve(false);
            }
        });
        srv.listen(port, '127.0.0.1', () => {
            httpServer = srv;
            resolve(true);
        });
    });
}

function getUrl(): string | undefined {
    const addr = httpServer?.address();
    if (addr && typeof addr === 'object') {
        return `http://127.0.0.1:${addr.port}/mcp`;
    }
    return undefined;
}

function updateStatusBar(): void {
    const url = getUrl();
    if (!url) {
        return;
    }
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.text = '$(notebook) MCP';
    status.tooltip = `Jupyter MCP Server\n${url}\nClick to copy URL`;
    status.command = 'jupyterMcp.showStatus';
    status.show();
    statusBarItem = status;
}

async function stopServer(): Promise<void> {
    statusBarItem?.dispose();
    statusBarItem = undefined;
    if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        httpServer = undefined;
    }
}

export async function deactivate(): Promise<void> {
    await stopServer();
}
