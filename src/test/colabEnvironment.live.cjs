// Opt-in real VS Code integration fixture for the already-configured native-debug-port path.
// It uses a fresh profile, empty extension directory, and a bundled development extension
// whose manifest has no Jupyter dependency. It never opens Colab, authentication, or user data.
// This does not test the missing-port restart/bootstrap path.
// Usage: node src/test/colabEnvironment.live.cjs <absolute Code.exe> <new evidence directory> [--cleanup-only|--workspace-append-only]
// Cleanup-only establishes the two owned development windows but opens no notebooks.
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
const [codeArg, evidenceArg, mode] = process.argv.slice(2);
if (mode !== undefined && mode !== '--cleanup-only' && mode !== '--workspace-append-only') throw new Error('Unknown fixture mode.');
const cleanupOnly = mode === '--cleanup-only';
const appendOnly = mode === '--workspace-append-only';
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
receipt.cleanupOnly = cleanupOnly;
receipt.workspaceAppendOnly = appendOnly;
let child;
let control;
let client;
let launchOutput = '';
let initialTargetId;
const cleanupNonce = crypto.randomUUID();
const closeMarker = `MCP isolated fixture close ${cleanupNonce}`;
const cleanupAcknowledgementPath = path.join(evidence, 'cleanup-command-ack.json');

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
        activationEvents: [appendOnly ? '*' : 'onStartupFinished']
    }, null, 2));
    await fs.writeFile(path.join(cleanupExtension, 'extension.cjs'), [
        "'use strict';",
        "const vscode = require('vscode');",
        "const fs = require('node:fs');",
        "const crypto = require('node:crypto');",
        `const acknowledgementPath = ${JSON.stringify(cleanupAcknowledgementPath)};`,
        `const nonce = ${JSON.stringify(cleanupNonce)};`,
        'exports.activate = context => {',
        "  const command = 'jupyterMcp.colabEnvironmentLiveFixtureQuit';",
        "  context.subscriptions.push(vscode.commands.registerCommand(command, () => {",
        "    const acknowledgement = { schema: 'colab-environment-live-cleanup-v2', nonce, invocationId: crypto.randomUUID(), sessionId: vscode.env.sessionId, extensionHostPid: process.pid, requestedAt: new Date().toISOString(), command: 'workbench.action.quit' };",
        "    const temporary = acknowledgementPath + '.tmp-' + process.pid;",
        "    fs.writeFileSync(temporary, JSON.stringify(acknowledgement));",
        "    fs.renameSync(temporary, acknowledgementPath);",
        "    return vscode.commands.executeCommand('workbench.action.quit');",
        "  }));",
        '  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999999);',
        `  item.text = ${JSON.stringify(closeMarker)};`,
        '  item.command = command;',
        '  item.show();',
        '  context.subscriptions.push(item);',
        ...(appendOnly ? [
            `  require('./append-probe.cjs').activate(context, ${JSON.stringify({
                nonce: cleanupNonce,
                markerPrefix: 'MCP isolated fixture append ' + cleanupNonce,
                stateDirectory: path.join(evidence, 'append-states'),
                requestPath: path.join(evidence, 'append-request.json'),
                acknowledgmentPath: path.join(evidence, 'append-ack.json'),
                settledPath: path.join(evidence, 'append-settled.json'),
                appendRootUri: pathToFileURL(path.join(evidence, 'later-root')).toString(),
                appendRootName: 'fixture-later-root'
            })});`
        ] : []),
        '};'
    ].join('\n'));
    if (appendOnly) {
        await fs.mkdir(path.join(evidence, 'append-states'));
        await fs.mkdir(path.join(evidence, 'later-root'));
        await fs.copyFile(path.join(ROOT, 'src', 'test', 'colabWorkspaceAppend.helper.cjs'), path.join(cleanupExtension, 'append-probe.cjs'));
    }

    await fs.writeFile(path.join(user, 'settings.json'), JSON.stringify({
        'jupyterMcp.enabled': true,
        'jupyterMcp.transport': 'http',
        'jupyterMcp.port': brokerPort,
        'jupyterMcp.nativeDebugPort': debugPort,
        'security.workspace.trust.enabled': false,
        'workbench.startupEditor': 'none',
        'window.restoreWindows': 'none',
        'window.confirmBeforeClose': 'never',
        'window.confirmSaveUntitledWorkspace': false,
        'telemetry.telemetryLevel': 'off'
    }, null, 2));
    receipt.temporaryProfileSettings = { confirmSaveUntitledWorkspace: false };

    const diskNotebook = path.join(evidence, 'fixture-open.ipynb');
    if (!cleanupOnly && !appendOnly) await fs.writeFile(diskNotebook, JSON.stringify({
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
    assert.strictEqual(prepareReceipt.folderUri, prepareReceipt.workspaceUri, 'initial receipt must expose the exact generated folder');
    assert.strictEqual(new URL(prepareReceipt.folderUri).protocol, 'file:');
    const finalWindowLabel = `${prepareReceipt.expectedWindowLabel} [Colab ${prepareReceipt.preparationId.slice(0, 8)}]`;

    // Re-list throughout the folder-to-untitled-workspace conversion. Replacing the
    // first root restarts the extension host and therefore may replace the broker ID;
    // no operation is routed through a pre-conversion ID.
    const transitions = [];
    receipt.workspaceTransitionListings = transitions;
    let lastTransition;
    const ready = await until(async () => {
        const groups = await listNotebooks();
        assertGroupShape(groups);
        const summary = groups.map(group => ({ windowId: group.windowId, windowLabel: group.windowLabel, notebookCount: group.notebooks.length }));
        const encoded = JSON.stringify(summary);
        if (encoded !== lastTransition && transitions.length < 40) {
            transitions.push(summary);
            lastTransition = encoded;
        }
        const matches = groups.filter(group => group.windowLabel === finalWindowLabel);
        if (matches.length !== 1) return false;
        const owner = matches[0];
        let text;
        try {
            text = await callText('get_colab_environment_preparation', {
                preparationId: prepareReceipt.preparationId,
                windowId: owner.windowId
            });
        } catch {
            return false;
        }
        const value = JSON.parse(text);
        if (value.environmentReady !== true) return false;
        await pause(500);
        const stableGroups = await listNotebooks();
        const stable = stableGroups.filter(group => group.windowLabel === finalWindowLabel);
        if (stable.length !== 1 || stable[0].windowId !== owner.windowId) return false;
        return { text, value, owner: stable[0], groups: stableGroups };
    }, 'Renamed untitled workspace did not become a stable ready broker owner.', 75_000);
    receipt.workspaceListing = ready.groups;
    assert.notStrictEqual(ready.owner.windowId, initialWindowId, 'prepared workspace must have a distinct broker window identity');
    assert.deepStrictEqual(ready.owner.notebooks, []);
    assert.strictEqual(ready.groups.filter(group => group.windowId === initialWindowId).length, 1, 'original empty window must remain uniquely registered');

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
    receipt.readyReceiptRaw = ready.text;
    receipt.readyReceipt = ready.value;
    assert.strictEqual(ready.value.status, 'environment_ready');
    assert.strictEqual(ready.value.runtimeReady, false);
    assert.strictEqual(new URL(ready.value.workspaceUri).protocol, 'untitled:');
    assert.strictEqual(ready.value.folderUri, prepareReceipt.folderUri);
    assert.strictEqual(ready.value.expectedWindowLabel, finalWindowLabel);

    if (appendOnly) {
        const stateDirectory = path.join(evidence, 'append-states');
        const readStates = async () => {
            const names = await fs.readdir(stateDirectory);
            assert.ok(names.length > 0 && names.length <= 8, 'unexpected activation-record count');
            assert.ok(names.every(name => /^activation-[0-9a-f-]{36}\.json$/.test(name)), 'unexpected activation record');
            const values = await Promise.all(names.map(name => fs.readFile(path.join(stateDirectory, name), 'utf8').then(JSON.parse)));
            for (const value of values) {
                assert.strictEqual(value.schema, 'colab-workspace-append-state-v1');
                assert.strictEqual(value.nonce, cleanupNonce);
                assert.strictEqual(value.vscodeVersion, '1.143.0');
                assert.ok(Number.isInteger(value.extensionHostPid) && value.extensionHostPid > 0);
                assert.match(value.activationId, /^[0-9a-f-]{36}$/);
            }
            return values;
        };
        const beforeStates = await readStates();
        const originalRoot = { uri: prepareReceipt.folderUri, name: prepareReceipt.expectedWindowLabel };
        const preparedRoot = { uri: ready.value.folderUri, name: finalWindowLabel };
        const prior = beforeStates.filter(value => value.workspaceUri === null && JSON.stringify(value.roots) === JSON.stringify([originalRoot]));
        const current = beforeStates.filter(value => value.workspaceUri === ready.value.workspaceUri && JSON.stringify(value.roots) === JSON.stringify([preparedRoot]));
        assert.strictEqual(prior.length, 1, 'one original-folder activation must precede conversion');
        assert.strictEqual(current.length, 1, 'one exact prepared-Workspace activation required');
        const liveState = current[0];
        assert.notStrictEqual(prior[0].extensionHostPid, liveState.extensionHostPid, 'first conversion must refresh the extension host');
        assert.notStrictEqual(prior[0].activationId, liveState.activationId);
        assert.ok(Date.parse(prior[0].observedAt) <= Date.parse(liveState.observedAt));
        receipt.folderConversionActivations = { before: prior[0], after: liveState };

        const marker = 'MCP isolated fixture append ' + cleanupNonce + ' ' + liveState.activationId;
        const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
        const pages = targets.filter(item => item.type === 'page' && /workbench(?:\.html)?/.test(item.url));
        assert.strictEqual(pages.length, 2, 'only the two owned fixture windows may remain');
        assert.strictEqual(pages.filter(page => page.id === initialTargetId).length, 1);
        const matches = [];
        for (const page of pages) {
            assert.ok(page.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${debugPort}/`));
            const probe = await connectDebugger(page.webSocketDebuggerUrl);
            try {
                const result = await probe.command('Runtime.evaluate', {
                    expression: `[...document.querySelectorAll('.statusbar-item')].filter(e => e.textContent.trim() === ${JSON.stringify(marker)}).length`,
                    returnByValue: true
                });
                assert.ok(result.result?.value === 0 || result.result?.value === 1);
                if (result.result?.value === 1) matches.push(page);
            } finally { probe.close(); }
        }
        assert.strictEqual(matches.length, 1, 'exact prepared-host marker must bind one renderer');
        assert.notStrictEqual(matches[0].id, initialTargetId);
        const request = {
            schema: 'colab-workspace-append-request-v1', nonce: cleanupNonce,
            activationId: liveState.activationId, extensionHostPid: liveState.extensionHostPid,
            expectedWorkspaceUri: ready.value.workspaceUri, expectedRoot: preparedRoot,
            requestedAt: new Date().toISOString()
        };
        await fs.writeFile(path.join(evidence, 'append-request.json'), JSON.stringify(request), { flag: 'wx' });
        const appendControl = await connectDebugger(matches[0].webSocketDebuggerUrl);
        try {
            const clicked = await appendControl.command('Runtime.evaluate', {
                expression: `(() => {
                    const visible = e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0; };
                    const items = [...document.querySelectorAll('.statusbar-item')].filter(e => visible(e) && e.textContent.trim() === ${JSON.stringify(marker)});
                    if (items.length !== 1) return false;
                    const actions = [...items[0].querySelectorAll('a,button,[role="button"]')].filter(visible);
                    const action = actions.length === 1 ? actions[0] : items[0].matches('a,button,[role="button"]') ? items[0] : undefined;
                    if (!action) return false;
                    action.click(); return true;
                })()`,
                returnByValue: true
            });
            assert.strictEqual(clicked.result?.value, true, 'one exact append action must be dispatched');
        } finally { appendControl.close(); }
        const settled = await until(async () => {
            try { return JSON.parse(await fs.readFile(path.join(evidence, 'append-settled.json'), 'utf8')); }
            catch { return false; }
        }, 'Append did not settle in its original extension host.', 10_000);
        const acknowledgement = JSON.parse(await fs.readFile(path.join(evidence, 'append-ack.json'), 'utf8'));
        assert.strictEqual(acknowledgement.schema, 'colab-workspace-append-ack-v1');
        assert.strictEqual(acknowledgement.nonce, cleanupNonce);
        assert.strictEqual(acknowledgement.accepted, true);
        assert.match(acknowledgement.invocationId, /^[0-9a-f-]{36}$/);
        assert.ok(Date.parse(acknowledgement.requestedAt) >= Date.parse(request.requestedAt));
        assert.strictEqual(acknowledgement.before.schema, liveState.schema);
        assert.strictEqual(acknowledgement.before.nonce, cleanupNonce);
        assert.strictEqual(acknowledgement.before.activationId, liveState.activationId);
        assert.strictEqual(acknowledgement.before.extensionHostPid, liveState.extensionHostPid);
        assert.strictEqual(acknowledgement.before.workspaceUri, liveState.workspaceUri);
        assert.deepStrictEqual(acknowledgement.before.roots, [preparedRoot]);
        assert.strictEqual(settled.schema, 'colab-workspace-append-settled-v1');
        assert.strictEqual(settled.nonce, cleanupNonce);
        assert.strictEqual(settled.invocationId, acknowledgement.invocationId);
        assert.strictEqual(settled.state.schema, liveState.schema);
        assert.strictEqual(settled.state.nonce, cleanupNonce);
        assert.strictEqual(settled.state.vscodeVersion, '1.143.0');
        assert.strictEqual(fileUriKey(acknowledgement.appendedRoot.uri), path.resolve(evidence, 'later-root').toLowerCase());
        assert.strictEqual(acknowledgement.appendedRoot.name, 'fixture-later-root');
        assert.strictEqual(settled.state.activationId, liveState.activationId);
        assert.strictEqual(settled.state.extensionHostPid, liveState.extensionHostPid);
        assert.strictEqual(settled.state.workspaceUri, liveState.workspaceUri);
        assert.deepStrictEqual(settled.state.roots, [preparedRoot, acknowledgement.appendedRoot]);
        const postText = await callText('get_colab_environment_preparation', { preparationId: prepareReceipt.preparationId, windowId: ready.owner.windowId });
        const post = JSON.parse(postText);
        assert.strictEqual(post.status, 'environment_ready');
        assert.strictEqual(post.environmentReady, true);
        assert.strictEqual(post.runtimeReady, false);
        assert.strictEqual(post.workspaceUri, ready.value.workspaceUri);
        assert.strictEqual(post.folderUri, ready.value.folderUri);
        const afterGroups = await listNotebooks();
        assertGroupShape(afterGroups);
        assert.deepStrictEqual(afterGroups.map(group => group.windowId).sort(), ready.groups.map(group => group.windowId).sort());
        assert.ok(afterGroups.every(group => group.notebooks.length === 0));
        assert.deepStrictEqual((await readStates()).map(value => value.activationId).sort(), beforeStates.map(value => value.activationId).sort());
        receipt.workspaceAppend = { request, acknowledgement, settled, afterGroups, readyReceipt: post };
        receipt.assertions = {
            firstConversionRefreshedHost: true, laterAppendPreservedHostAndActivation: true,
            exactWorkspaceAndFirstRootPreserved: true, exactSecondRootAppended: true,
            sameMcpOwnerAndFreshNativeReadiness: true, runtimeReadyFalse: true,
            notebooksOpened: false, noJupyterDependency: true, noSmokeDriver: true
        };
        receipt.passed = true;
        return;
    }

    if (cleanupOnly) {
        receipt.assertions = {
            originalEmptyWindowRetained: true,
            generatedWorkspaceReady: true,
            notebooksOpened: false,
            noJupyterDependency: true,
            noSmokeDriver: true
        };
        receipt.passed = true;
        return;
    }

    const createText = await callText('create_notebook', { title: 'Environment fixture', windowId: ready.owner.windowId });
    receipt.createNotebookResponse = createText;
    const createdMatch = /^Created (file:\/\/\/.*?) and opened it in the editor\.$/.exec(createText);
    assert.ok(createdMatch, 'create_notebook must create a real workspace file');
    const createdUri = createdMatch[1];
    const relativeCreated = path.relative(fileURLToPath(ready.value.folderUri), fileURLToPath(createdUri));
    assert.ok(relativeCreated && !relativeCreated.startsWith('..') && !path.isAbsolute(relativeCreated), 'created notebook must belong to the generated workspace');

    const firstOpenText = await callText('open_notebooks', { uris: [diskNotebookUri], windowId: ready.owner.windowId });
    receipt.firstOpenResponse = firstOpenText;
    assert.match(firstOpenText, /^Opened from disk:/);
    const secondOpenText = await callText('open_notebooks', { uris: [diskNotebookUri], windowId: ready.owner.windowId });
    receipt.secondOpenResponse = secondOpenText;
    assert.match(secondOpenText, /^Already open; preserved live document:/, 'second open must reveal the existing document');

    const finalListing = await until(async () => {
        const groups = await listNotebooks();
        const owner = groups.find(group => group.windowId === ready.owner.windowId);
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
    assert.deepStrictEqual(allNotebookOwners.get(fileUriKey(diskNotebookUri)), [ready.owner.windowId], 'fixture notebook must have one exact owner');
    assert.deepStrictEqual(allNotebookOwners.get(fileUriKey(createdUri)), [ready.owner.windowId], 'created notebook must have one exact owner');
    assert.strictEqual(finalListing.find(group => group.windowId === initialWindowId)?.notebooks.length, 0, 'original window must remain empty');
    assert.strictEqual(finalListing.filter(group => group.windowLabel === finalWindowLabel).length, 1, 'renamed workspace owner label must remain unique');

    receipt.assertions = {
        initialWindowEmpty: true,
        generatedWorkspaceUnique: true,
        transientPreconversionWindowIdNotPinned: true,
        folderPromotedToUntitledWorkspace: true,
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
            const listPages = async () => {
                const targets = await fetch(`http://127.0.0.1:${receipt.debugPort}/json/list`).then(response => response.json());
                return targets.filter(item => item.type === 'page' && /workbench(?:\.html)?/.test(item.url));
            };
            let pages = await listPages();
            if (pages.length < 1 || pages.length > 2 || pages.filter(page => page.id === initialTargetId).length !== 1) throw new Error('owned workbench targets changed before close');
            const ownedIds = new Set(pages.map(page => page.id));
            if (ownedIds.size !== pages.length) throw new Error('duplicate fixture workbench target');
            const acknowledgments = [];
            receipt.quitStages = acknowledgments;
            // NativeHostMainService.quit closes one last-active development window
            // while more than one remains. At most two normal Quit stages are needed.
            for (let stage = 0; stage < 2 && pages.length; stage++) {
                if (pages.some(page => !ownedIds.has(page.id)) || (stage > 0 && pages.length !== 1)) throw new Error('unowned fixture window before quit');
                for (const page of pages) {
                    if (!page.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${receipt.debugPort}/`)) throw new Error('unexpected fixture cleanup endpoint');
                    const binding = await connectDebugger(page.webSocketDebuggerUrl);
                    try {
                        const proof = await binding.command('Runtime.evaluate', {
                            expression: `[...document.querySelectorAll('.statusbar-item')].filter(e => e.textContent.trim() === ${JSON.stringify(closeMarker)}).length`,
                            returnByValue: true
                        });
                        if (proof.result?.value !== 1) throw new Error('fixture cleanup marker not unique');
                    } finally { binding.close(); }
                }
                const quitPage = pages.find(page => page.id === initialTargetId) ?? pages[0];
                const previousCount = pages.length;
                const dispatchTime = Date.now();
                const windowControl = await connectDebugger(quitPage.webSocketDebuggerUrl);
                try {
                    const quit = await windowControl.command('Runtime.evaluate', {
                expression: `(() => {
                    const marker = ${JSON.stringify(closeMarker)};
                    const visible = element => {
                        const style = getComputedStyle(element);
                        const rect = element.getBoundingClientRect();
                        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
                    };
                    const items = [...document.querySelectorAll('.statusbar-item')].filter(element => visible(element) && element.textContent.trim() === marker);
                    if (items.length !== 1) return { ok: false, reason: 'fixture_quit_marker_not_unique', count: items.length };
                    const actions = [...items[0].querySelectorAll('a,button,[role="button"]')].filter(visible);
                    const action = actions.length === 1 ? actions[0] : items[0].matches('a,button,[role="button"]') ? items[0] : undefined;
                    if (!action) return { ok: false, reason: 'fixture_quit_action_not_unique', count: actions.length };
                    action.click();
                    return { ok: true };
                })()`,
                returnByValue: true
            });
                    if (!quit.result?.value?.ok) throw new Error(quit.result?.value?.reason ?? 'fixture quit command unavailable');
                    const acknowledgement = await until(async () => {
                try {
                    const value = JSON.parse(await fs.readFile(cleanupAcknowledgementPath, 'utf8'));
                    if (Date.parse(value.requestedAt) < dispatchTime || acknowledgments.some(item => item.acknowledgment.invocationId === value.invocationId)) return false;
                    return value;
                } catch {
                    return false;
                }
            }, 'Fixture normal quit command was not acknowledged.', 5_000);
            assert.deepStrictEqual(Object.keys(acknowledgement).sort(), ['command', 'extensionHostPid', 'invocationId', 'nonce', 'requestedAt', 'schema', 'sessionId']);
            assert.strictEqual(acknowledgement.schema, 'colab-environment-live-cleanup-v2');
            assert.strictEqual(acknowledgement.nonce, cleanupNonce);
            assert.match(acknowledgement.invocationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
            assert.strictEqual(acknowledgement.command, 'workbench.action.quit');
            // With telemetry disabled sessionId can be a constant placeholder.
            // Ownership is established by the isolated endpoint and fresh marker/nonce.
            assert.strictEqual(typeof acknowledgement.sessionId, 'string');
            assert.ok(acknowledgement.sessionId.length > 0, 'fixture cleanup acknowledgement must identify the exact VS Code session');
            assert.strictEqual(Number.isInteger(acknowledgement.extensionHostPid), true);
            assert.ok(acknowledgement.extensionHostPid > 0);
            assert.strictEqual(Number.isNaN(Date.parse(acknowledgement.requestedAt)), false);
                    acknowledgments.push({ stage: stage + 1, targetId: quitPage.id, windowsBefore: previousCount, acknowledgment: acknowledgement });
                } finally { windowControl.close(); }
                const removalDeadline = Date.now() + 10_000;
                let remainingPages;
                while (Date.now() < removalDeadline) {
                    if (child.exitCode !== null) { remainingPages = []; break; }
                    let remaining;
                    try {
                        remaining = await listPages();
                    } catch {
                        await pause(250);
                        continue;
                    }
                    if (remaining.some(page => !ownedIds.has(page.id)) || new Set(remaining.map(page => page.id)).size !== remaining.length) throw new Error('unowned fixture window during quit');
                    if (remaining.length < previousCount) { remainingPages = remaining; break; }
                    await pause(250);
                }
                if (!remainingPages) throw new Error('Owned fixture window did not disappear after normal quit.');
                pages = remainingPages;
                acknowledgments.at(-1).windowsAfter = pages.length;
            }
            if (pages.length) throw new Error('fixture windows remain after bounded normal quit');
            receipt.quitDispatchAcknowledgement = 'all_stages_acknowledged';
        } catch {
            receipt.quitDispatchAcknowledgement = 'unconfirmed';
            receipt.passed = false;
            receipt.error = receipt.error ?? 'Fixture normal quit dispatch was not acknowledged.';
            process.exitCode = 1;
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
            receipt.error = receipt.error ?? 'Owned isolated VS Code did not exit after normal application quit.';
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
