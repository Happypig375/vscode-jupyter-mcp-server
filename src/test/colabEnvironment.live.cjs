// Opt-in real VS Code integration fixture for the already-configured native-debug-port path.
// It uses a fresh profile, empty extension directory, and a bundled development extension
// whose manifest has no Jupyter dependency. It never opens Colab, authentication, or user data.
// This does not test the missing-port restart/bootstrap path.
// Usage: node src/test/colabEnvironment.live.cjs <absolute Code.exe> <new evidence directory>
'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ROOT = path.resolve(__dirname, '..', '..');
const [codeArg, evidenceArg] = process.argv.slice(2);
if (!codeArg || !path.isAbsolute(codeArg) || !evidenceArg || !path.isAbsolute(evidenceArg)) {
    throw new Error('Explicit absolute Code executable and new evidence directory required.');
}
const code = path.resolve(codeArg);
const evidence = path.resolve(evidenceArg);
const receipt = {
    schema: 'jupyter-mcp-colab-environment-live-v1',
    startedAt: new Date().toISOString(),
    configuredPortBranch: true,
    missingPortRestartTested: false,
    smokeDriverFlag: false,
    realJupyterInstalled: false,
    realColabUsed: false,
    authenticationUsed: false,
    userNotebookUsed: false
};
let child;
let control;
let client;
let launchOutput = '';
let initialTargetId;
const closeMarker = `MCP isolated fixture close ${crypto.randomUUID()}`;

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, label, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await pause(250);
    }
    throw new Error(lastError ? `${label}: ${lastError.message}` : label);
}

async function reservePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Could not reserve a loopback port.'));
                return;
            }
            const port = address.port;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

async function connectDebugger(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('Fixture debugger unavailable.')), { once: true });
    });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        const job = pending.get(message.id);
        if (!job) return;
        pending.delete(message.id);
        clearTimeout(job.timer);
        if (message.error) job.reject(new Error('Fixture debugger command failed.'));
        else job.resolve(message.result);
    });
    return {
        close: () => socket.close(),
        command: (method, params = {}) => new Promise((resolve, reject) => {
            const requestId = ++id;
            const timer = setTimeout(() => {
                pending.delete(requestId);
                reject(new Error('Fixture debugger command timed out.'));
            }, 10_000);
            pending.set(requestId, { resolve, reject, timer });
            socket.send(JSON.stringify({ id: requestId, method, params }));
        })
    };
}

async function connectMcp(port) {
    return until(async () => {
        const candidate = new Client({ name: 'colab-environment-live-fixture', version: '1.0.0' });
        try {
            await candidate.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
            await candidate.listTools();
            return candidate;
        } catch {
            await candidate.close().catch(() => undefined);
            return false;
        }
    }, 'Fixture MCP broker did not become reachable.');
}

async function callText(name, args) {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.length === 1 && result.content[0].type === 'text' ? result.content[0].text : undefined;
    if (result.isError || typeof text !== 'string') throw new Error(`${name} failed: ${typeof text === 'string' ? text.slice(0, 500) : 'invalid MCP response'}`);
    return text;
}

async function listNotebooks() {
    return JSON.parse(await callText('list_notebooks', {}));
}

function assertGroupShape(groups) {
    assert.ok(Array.isArray(groups), 'list_notebooks must return an array');
    for (const group of groups) {
        assert.strictEqual(typeof group.windowId, 'string');
        assert.strictEqual(typeof group.windowLabel, 'string');
        assert.ok(Array.isArray(group.notebooks));
    }
}

function fileUriKey(uri) {
    return path.resolve(fileURLToPath(uri)).toLowerCase();
}

async function main() {
    await fs.access(code);
    await fs.mkdir(evidence); // Refuse to overwrite a prior live run.
    const extension = path.join(evidence, 'extension');
    const cleanupExtension = path.join(evidence, 'cleanup-extension');
    const appData = path.join(evidence, 'appdata');
    const profile = path.join(appData, 'Code');
    const extensions = path.join(evidence, 'extensions');
    const user = path.join(profile, 'User');
    for (const directory of [extension, cleanupExtension, appData, profile, extensions, user, path.join(extension, 'dist')]) {
        await fs.mkdir(directory);
    }

    const brokerPort = await reservePort();
    let debugPort = await reservePort();
    while (debugPort === brokerPort) debugPort = await reservePort();
    Object.assign(receipt, { brokerPort, debugPort, codeExecutable: code });

    const sourceManifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    delete sourceManifest.extensionDependencies;
    sourceManifest.scripts = {};
    sourceManifest.devDependencies = {};
    sourceManifest.dependencies = {};
    await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify(sourceManifest, null, 2));
    await esbuild.build({
        entryPoints: [path.join(ROOT, 'src', 'extension.ts')],
        outfile: path.join(extension, 'dist', 'extension.js'),
        bundle: true,
        external: ['vscode'],
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        sourcemap: true
    });
    const fixtureManifest = JSON.parse(await fs.readFile(path.join(extension, 'package.json'), 'utf8'));
    assert.strictEqual(Object.hasOwn(fixtureManifest, 'extensionDependencies'), false, 'fixture manifest must omit the real Jupyter dependency');
    assert.deepStrictEqual(await fs.readdir(extensions), [], 'isolated extension directory must start empty');

    await fs.writeFile(path.join(cleanupExtension, 'package.json'), JSON.stringify({
        name: 'colab-environment-live-cleanup',
        publisher: 'local-test',
        version: '0.0.1',
        engines: { vscode: '^1.106.0' },
        main: './extension.cjs',
        activationEvents: ['onStartupFinished']
    }, null, 2));
    await fs.writeFile(path.join(cleanupExtension, 'extension.cjs'), [
        "'use strict';",
        "const vscode = require('vscode');",
        'exports.activate = context => {',
        "  const command = 'jupyterMcp.colabEnvironmentLiveFixtureQuit';",
        "  context.subscriptions.push(vscode.commands.registerCommand(command, () => vscode.commands.executeCommand('workbench.action.closeWindow')));",
        '  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999999);',
        `  item.text = ${JSON.stringify(closeMarker)};`,
        '  item.command = command;',
        '  item.show();',
        '  context.subscriptions.push(item);',
        '};'
    ].join('\n'));

    await fs.writeFile(path.join(user, 'settings.json'), JSON.stringify({
        'jupyterMcp.enabled': true,
        'jupyterMcp.transport': 'http',
        'jupyterMcp.port': brokerPort,
        'jupyterMcp.nativeDebugPort': debugPort,
        'security.workspace.trust.enabled': false,
        'workbench.startupEditor': 'none',
        'window.restoreWindows': 'none',
        'window.confirmBeforeClose': 'never',
        'telemetry.telemetryLevel': 'off'
    }, null, 2));

    const diskNotebook = path.join(evidence, 'fixture-open.ipynb');
    await fs.writeFile(diskNotebook, JSON.stringify({
        cells: [{ cell_type: 'markdown', metadata: {}, source: ['# Isolated fixture'] }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5
    }, null, 2));
    const diskNotebookUri = pathToFileURL(diskNotebook).toString();

    child = spawn(code, [
        `--user-data-dir=${profile}`,
        `--extensions-dir=${extensions}`,
        `--extensionDevelopmentPath=${extension}`,
        `--extensionDevelopmentPath=${cleanupExtension}`,
        `--remote-debugging-port=${debugPort}`,
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-telemetry',
        '--new-window'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, APPDATA: appData } });
    receipt.pid = child.pid;
    for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', chunk => {
            if (launchOutput.length < 200_000) launchOutput += chunk.toString();
        });
    }

    const target = await until(async () => {
        try {
            const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
            return targets.find(item => item.type === 'page' && /workbench(?:\.html)?/.test(item.url));
        } catch {
            return false;
        }
    }, 'Fixture workbench debugger target did not appear.');
    assert.ok(target.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${debugPort}/`), 'unexpected debugger endpoint');
    initialTargetId = target.id;
    control = await connectDebugger(target.webSocketDebuggerUrl);
    const smokeProbe = await control.command('Runtime.evaluate', { expression: 'typeof window.driver', returnByValue: true });
    receipt.windowDriverType = smokeProbe.result?.value;
    assert.strictEqual(receipt.windowDriverType, 'undefined', 'fixture unexpectedly exposes the VS Code smoke driver');

    client = await connectMcp(brokerPort);
    const { tools } = await client.listTools();
    const toolNames = tools.map(tool => tool.name);
    receipt.toolNames = toolNames;
    assert.strictEqual(toolNames.filter(name => name === 'open_notebooks').length, 1, 'tool catalog must contain exactly one notebook opener');
    assert.ok(toolNames.includes('prepare_colab_environment'));
    assert.ok(toolNames.includes('get_colab_environment_preparation'));
    assert.strictEqual(toolNames.includes('configure_kernel'), false, 'fixture must not load the real Jupyter dependency');

    const initialListing = await listNotebooks();
    assertGroupShape(initialListing);
    assert.strictEqual(initialListing.length, 1, 'fresh app must expose exactly one empty window');
    assert.strictEqual(initialListing[0].windowLabel, 'Empty window');
    assert.deepStrictEqual(initialListing[0].notebooks, []);
    receipt.initialListing = initialListing;
    const initialWindowId = initialListing[0].windowId;

    const prepareText = await callText('prepare_colab_environment', { windowId: initialWindowId });
    const prepareReceipt = JSON.parse(prepareText);
    receipt.prepareReceiptRaw = prepareText;
    receipt.prepareReceipt = prepareReceipt;
    assert.strictEqual(prepareReceipt.status, 'workspace_open_requested');
    assert.strictEqual(prepareReceipt.environmentReady, false);
    assert.strictEqual(prepareReceipt.runtimeReady, false);
    assert.match(prepareReceipt.expectedWindowLabel, /^colab-bootstrap-[0-9a-f]{8}$/);

    const routed = await until(async () => {
        const groups = await listNotebooks();
        assertGroupShape(groups);
        const matches = groups.filter(group => group.windowLabel === prepareReceipt.expectedWindowLabel);
        return matches.length === 1 ? { groups, owner: matches[0] } : false;
    }, 'Generated workspace window did not register uniquely with the broker.', 60_000);
    receipt.workspaceListing = routed.groups;
    assert.notStrictEqual(routed.owner.windowId, initialWindowId, 'generated workspace must have a distinct broker window identity');
    assert.deepStrictEqual(routed.owner.notebooks, []);
    assert.strictEqual(routed.groups.filter(group => group.windowId === initialWindowId).length, 1, 'original empty window must remain uniquely registered');

    const mismatchText = await callText('get_colab_environment_preparation', {
        preparationId: prepareReceipt.preparationId,
        windowId: initialWindowId
    });
    const mismatchReceipt = JSON.parse(mismatchText);
    receipt.wrongWindowReceiptRaw = mismatchText;
    receipt.wrongWindowReceipt = mismatchReceipt;
    assert.strictEqual(mismatchReceipt.status, 'workspace_mismatch');
    assert.strictEqual(mismatchReceipt.environmentReady, false);
    assert.strictEqual(mismatchReceipt.runtimeReady, false);

    const ready = await until(async () => {
        const text = await callText('get_colab_environment_preparation', {
            preparationId: prepareReceipt.preparationId,
            windowId: routed.owner.windowId
        });
        const value = JSON.parse(text);
        return value.environmentReady === true ? { text, value } : false;
    }, 'Exact generated workspace did not prove fresh native marker readiness.', 45_000);
    receipt.readyReceiptRaw = ready.text;
    receipt.readyReceipt = ready.value;
    assert.strictEqual(ready.value.status, 'environment_ready');
    assert.strictEqual(ready.value.runtimeReady, false);
    assert.strictEqual(ready.value.workspaceUri, prepareReceipt.workspaceUri);
    assert.strictEqual(ready.value.expectedWindowLabel, prepareReceipt.expectedWindowLabel);

    const createText = await callText('create_notebook', { title: 'Environment fixture', windowId: routed.owner.windowId });
    receipt.createNotebookResponse = createText;
    const createdMatch = /^Created (file:\/\/\/.*?) and opened it in the editor\.$/.exec(createText);
    assert.ok(createdMatch, 'create_notebook must create a real workspace file');
    const createdUri = createdMatch[1];
    const relativeCreated = path.relative(fileURLToPath(ready.value.workspaceUri), fileURLToPath(createdUri));
    assert.ok(relativeCreated && !relativeCreated.startsWith('..') && !path.isAbsolute(relativeCreated), 'created notebook must belong to the generated workspace');

    const firstOpenText = await callText('open_notebooks', { uris: [diskNotebookUri], windowId: routed.owner.windowId });
    receipt.firstOpenResponse = firstOpenText;
    assert.match(firstOpenText, /^Opened from disk:/);
    const secondOpenText = await callText('open_notebooks', { uris: [diskNotebookUri], windowId: routed.owner.windowId });
    receipt.secondOpenResponse = secondOpenText;
    assert.match(secondOpenText, /^Already open; preserved live document:/, 'second open must reveal the existing document');

    const finalListing = await until(async () => {
        const groups = await listNotebooks();
        const owner = groups.find(group => group.windowId === routed.owner.windowId);
        return owner?.notebooks.length === 2 ? groups : false;
    }, 'Created and opened notebooks were not both attributed to the generated workspace.');
    receipt.finalListing = finalListing;
    const allNotebookOwners = new Map();
    for (const group of finalListing) {
        for (const notebook of group.notebooks) {
            const key = fileUriKey(notebook.uri);
            const owners = allNotebookOwners.get(key) ?? [];
            owners.push(group.windowId);
            allNotebookOwners.set(key, owners);
        }
    }
    assert.deepStrictEqual(allNotebookOwners.get(fileUriKey(diskNotebookUri)), [routed.owner.windowId], 'fixture notebook must have one exact owner');
    assert.deepStrictEqual(allNotebookOwners.get(fileUriKey(createdUri)), [routed.owner.windowId], 'created notebook must have one exact owner');
    assert.strictEqual(finalListing.find(group => group.windowId === initialWindowId)?.notebooks.length, 0, 'original window must remain empty');
    assert.strictEqual(finalListing.filter(group => group.windowLabel === prepareReceipt.expectedWindowLabel).length, 1, 'workspace owner label must remain unique');

    receipt.assertions = {
        initialWindowEmpty: true,
        generatedWorkspaceUnique: true,
        wrongWindowNotReady: true,
        exactWindowFreshNativeReady: true,
        runtimeReadyFalse: true,
        createdNotebookInGeneratedWorkspace: true,
        existingNotebookOpenedOnceAndRevealed: true,
        notebooksOwnedOnlyByGeneratedWindow: true,
        noDuplicateNotebookOpener: true,
        noSmokeDriver: true,
        noJupyterDependency: true
    };
    receipt.passed = true;
}

main().catch(error => {
    receipt.passed = false;
    receipt.error = String(error?.message ?? error).slice(0, 2000);
    receipt.launchOutputTail = launchOutput.slice(-4000);
    process.exitCode = 1;
}).finally(async () => {
    if (client) await client.close().catch(() => undefined);
    if (control) control.close();
    if (child && initialTargetId) {
        try {
            const targets = await fetch(`http://127.0.0.1:${receipt.debugPort}/json/list`).then(response => response.json());
            const pages = targets
                .filter(item => item.type === 'page' && /workbench(?:\.html)?/.test(item.url))
                .sort((left, right) => Number(left.id === initialTargetId) - Number(right.id === initialTargetId));
            if (pages.length < 1 || pages.filter(page => page.id === initialTargetId).length !== 1) throw new Error('owned workbench targets changed before close');
            let requested = 0;
            for (const page of pages) {
                const windowControl = await connectDebugger(page.webSocketDebuggerUrl);
                const close = await windowControl.command('Runtime.evaluate', {
                    expression: `(() => {
                        const marker = ${JSON.stringify(closeMarker)};
                        const visible = element => {
                            const style = getComputedStyle(element);
                            const rect = element.getBoundingClientRect();
                            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
                        };
                        const items = [...document.querySelectorAll('.statusbar-item')].filter(element => visible(element) && element.textContent.trim() === marker);
                        if (items.length !== 1) return { ok: false, reason: 'fixture_close_marker_not_unique', count: items.length };
                        const actions = [...items[0].querySelectorAll('a,button,[role="button"]')].filter(visible);
                        const action = actions.length === 1 ? actions[0] : items[0].matches('a,button,[role="button"]') ? items[0] : undefined;
                        if (!action) return { ok: false, reason: 'fixture_close_action_not_unique', count: actions.length };
                        action.click();
                        return { ok: true };
                    })()`,
                    returnByValue: true
                });
                const value = close.result?.value;
                if (!value?.ok) throw new Error(value?.reason ?? 'fixture close command unavailable');
                requested++;
                await pause(400);
                windowControl.close();
            }
            receipt.closeRequested = { command: 'workbench.action.closeWindow', windows: requested };
        } catch {
            receipt.closeRequested = 'unconfirmed';
        }
    } else if (child) {
        child.kill();
        receipt.ownedProcessKillRequested = true;
    }
    if (child && initialTargetId) {
        const exited = await Promise.race([
            child.exitCode !== null ? Promise.resolve(true) : new Promise(resolve => child.once('exit', () => resolve(true))),
            pause(15_000).then(() => false)
        ]);
        receipt.closedNormally = exited;
        if (!exited) {
            child.kill();
            receipt.ownedProcessKillRequested = true;
            receipt.passed = false;
            receipt.error = receipt.error ?? 'Owned isolated VS Code did not exit after Browser.close.';
            process.exitCode = 1;
        }
    }
    receipt.finishedAt = new Date().toISOString();
    try {
        await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
    } catch {
        // Evidence creation itself may have failed before the directory existed.
    }
    console.log(JSON.stringify(receipt, null, 2));
});
