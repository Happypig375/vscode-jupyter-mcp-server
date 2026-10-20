import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import * as vm from 'vm';
import {
    ColabEnvironmentContextForTest, ColabEnvironmentDependenciesForTest, ColabEnvironmentError,
    ColabEnvironmentReceiptForTest, HELPER_SOURCE_FOR_TEST, ProcessIdentity,
    buildProcessIdentityPowerShellForTest, createColabEnvironmentForTest, initializeColabEnvironment, parseCodeStatusForTest, prepareColabEnvironment,
    resolveInstalledCodeCliForTest, resolveLocalGlobalStoragePathForTest, retryWatchdogReceiptReadForTest, validateDefaultWindowsInstallForTest
} from '../colabEnvironment';
import { fileUri, rawUri, reset, state, userDataUri } from './colabEnvironmentStub';

const PID = 33940;
const COMMIT = '6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1';
const CREATION = '2026-10-20T01:02:03.0000000Z';
const CRASH = 'ca056795-5095-4ecf-8364-307fb2b6ee50';

function status(args = `--crash-reporter-id ${CRASH}`, pid = PID, windows = 1): string {
    const rows = Array.from({ length: windows }, (_, index) => `    1     190   ${28920 + index}  window [${index + 1}] (Welcome - Visual Studio Code)`).join('\n');
    return `Version:          Code 1.142.0 (${COMMIT}, 2026-10-15T03:02:17Z)\nOS Version:       Windows_NT x64 10.0.26100\nProcess Argv:     ${args}\nCPU % Mem MB     PID  Process\n    0      51   ${pid}  code\n${rows}\n`;
}

interface Fixture {
    context: ColabEnvironmentContextForTest;
    deps: ColabEnvironmentDependenciesForTest;
    temp: string;
    root: string;
    identity: ProcessIdentity;
    dispose(): void;
    runScheduledQuit(): Promise<boolean>;
    runQuitWatchdog(): Promise<void>;
    quitCalls: number;
}

async function fixture(options: { native?: boolean; restart?: boolean } = {}): Promise<Fixture> {
    reset();
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jupyter-mcp-colab-environment-'));
    const appData = path.join(temp, 'AppData', 'Roaming');
    const localAppData = path.join(temp, 'AppData', 'Local');
    const profile = temp;
    const extensionId = 'hadrian.jupyter-mcp';
    const root = options.restart ? path.join(appData, 'Code', 'User', 'globalStorage', extensionId) : path.join(temp, 'storage');
    const extensionPath = options.restart ? path.join(profile, '.vscode', 'extensions', 'jupyter-mcp-0.5.0') : path.join(temp, 'extension');
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(extensionPath, { recursive: true });
    const disposables: Array<{ dispose(): unknown }> = [];
    const identity = { pid: PID, executablePath: path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'), creationTime: CREATION };
    let quitCalls = 0;
    let scheduledQuit: (() => Promise<boolean>) | undefined;
    let quitWatchdog: (() => Promise<void>) | undefined;
    const result: Fixture = {
        root, temp, identity,
        context: { globalStorageUri: fileUri(root), extensionPath, extension: { id: extensionId }, subscriptions: disposables },
        deps: {
            now: () => 1_800_000_000_000,
            uuid: crypto.randomUUID,
            platform: options.restart ? 'win32' : process.platform,
            execPath: identity.executablePath,
            env: { APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: profile, VSCODE_PID: String(PID) },
            vscodeVersion: '1.142.0',
            probeNative: async () => options.native === true,
            inspectNative: async () => ({ listenerAvailable: options.native === true, workbenchPageCount: options.native ? 1 : null }),
            runCodeStatus: async () => status(),
            inspectProcess: async () => identity,
            reservePort: async () => 59267,
            armHelper: async (_exe, _helper, receiptPath, receipt) => {
                const value = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
                assert.strictEqual(value.preparationId, receipt.preparationId);
                value.status = 'restart_requested'; value.helperArmedAt = Date.now();
                await fs.writeFile(receiptPath, JSON.stringify(value));
            },
            requestQuit: (revalidate, stillAlive) => { scheduledQuit = revalidate; quitWatchdog = stillAlive; }
        },
        get quitCalls() { return quitCalls; },
        runScheduledQuit: async () => {
            if (!scheduledQuit) return false;
            const revalidate = scheduledQuit; scheduledQuit = undefined;
            if (!await revalidate()) return false;
            quitCalls++; return true;
        },
        runQuitWatchdog: async () => { const watchdog = quitWatchdog; quitWatchdog = undefined; await watchdog?.(); },
        dispose: () => { for (const disposable of disposables) disposable.dispose(); }
    };
    state.configuredPort = options.native ? 59267 : 0;
    return result;
}

function parsed(value: string): any { return JSON.parse(value); }
async function rejectsCode(work: () => Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(work, (error: ColabEnvironmentError) => error.code === code);
}

const cases: Array<[string, () => Promise<void>]> = [];
function test(name: string, work: () => Promise<void>): void { cases.push([name, work]); }

function helperHarness(options: {
    approved: boolean;
    observations: Array<'live' | 'changed' | 'exited' | 'error' | 'malformed'>;
    spawnError?: boolean;
    readFailuresAfterArm?: number;
    disarmDuringInspection?: boolean;
}) {
    const id = crypto.randomUUID(), token = crypto.randomUUID(), receiptPath = 'C:\\receipt.json';
    let now = 1_800_000_000_000;
    const receipt: any = { schema: 1, preparationId: id, helperToken: token, status: 'arming_restart', deadline: now + 10_000,
        main: { pid: 123, executablePath: 'C:\\Code.exe', creationTime: CREATION }, executablePath: 'C:\\Code.exe',
        workspacePath: 'C:\\workspace', userDataDir: 'C:\\user', extensionsDir: 'C:\\extensions', port: 59267 };
    const files = new Map<string, Buffer>([[receiptPath, Buffer.from(JSON.stringify(receipt))]]);
    const timers: Array<() => void> = []; const launches: Array<{ executable: string; args: string[]; options: any }> = [];
    let exits = 0; let inspections = 0; let armed = false; let remainingReadFailures = options.readFailuresAfterArm ?? 0;
    const fakeFs = {
        readFileSync: (file: string) => {
            if (armed && remainingReadFailures-- > 0) throw new Error('transient read');
            const value = files.get(file); if (!value) throw new Error('missing'); return value;
        },
        writeFileSync: (file: string, value: string) => { if (files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); files.set(file, Buffer.from(value)); },
        renameSync: (from: string, to: string) => { const value = files.get(from); if (!value) throw new Error('missing temp'); files.delete(from); files.set(to, value); },
        rmSync: (file: string) => { files.delete(file); }
    };
    const fakeCp = {
        spawnSync: () => {
            const observation = options.observations[Math.min(inspections++, options.observations.length - 1)];
            if (options.disarmDuringInspection) {
                const current = JSON.parse(files.get(receiptPath)!.toString('utf8'));
                current.status = 'failed'; current.failure = 'quit_not_confirmed';
                files.set(receiptPath, Buffer.from(JSON.stringify(current)));
            }
            if (observation === 'error') return { status: 1, stdout: '' };
            if (observation === 'malformed') return { status: 0, stdout: 'partial' };
            if (observation === 'changed') return { status: 0, stdout: `C:\\Other.exe\n${CREATION}\n` };
            return observation === 'live' ? { status: 0, stdout: `C:\\Code.exe\n${CREATION}\n` } : { status: 0, stdout: '' };
        },
        spawn: (executable: string, args: string[], spawnOptions: any) => {
            launches.push({ executable, args, options: spawnOptions }); const child: any = new EventEmitter(); child.pid = 777; child.unref = () => undefined;
            timers.push(() => child.emit(options.spawnError ? 'error' : 'spawn', options.spawnError ? new Error('no executable') : undefined));
            return child;
        }
    };
    const fakeProcess: any = { argv: ['node', 'helper', receiptPath, id, token], pid: 456,
        env: { ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '123', VSCODE_IPC_HOOK_CLI: 'old-pipe', PATH: 'sentinel-path' },
        send() { armed = true; }, exit: () => { exits++; } };
    vm.runInNewContext(`(function(){${HELPER_SOURCE_FOR_TEST}\n})()`, {
        require: (name: string) => name === 'fs' ? fakeFs : name === 'child_process' ? fakeCp : require(name),
        process: fakeProcess, Buffer, Date: { now: () => now, parse: Date.parse }, Number,
        setTimeout: (work: () => void) => { timers.push(work); return timers.length; }
    });
    if (options.approved) {
        const current = JSON.parse(files.get(receiptPath)!.toString('utf8')); current.quitDispatchApprovedAt = now; files.set(receiptPath, Buffer.from(JSON.stringify(current)));
    }
    return {
        runTimer: () => { const timer = timers.shift(); assert.ok(timer, 'expected helper timer'); timer!(); },
        get receipt() { return JSON.parse(files.get(receiptPath)!.toString('utf8')); },
        mutateReceipt: (change: (value: any) => void) => { const value = JSON.parse(files.get(receiptPath)!.toString('utf8')); change(value); files.set(receiptPath, Buffer.from(JSON.stringify(value))); },
        failNextReads: (count: number) => { remainingReadFailures = count; },
        advance: (milliseconds: number) => { now += milliseconds; },
        launches, get exits() { return exits; }, get inspections() { return inspections; }
    };
}

test('version-matched status format identifies the exact primary and windows', async () => {
    const result = parseCodeStatusForTest(status('--enable-smoke-test-driver --remote-debugging-port=59267 --crash-reporter-id ' + CRASH), PID);
    assert.strictEqual(result.version, '1.142.0'); assert.strictEqual(result.commit, COMMIT); assert.strictEqual(result.mainPid, PID);
    assert.deepStrictEqual(result.processArgs.slice(0, 2), ['--enable-smoke-test-driver', '--remote-debugging-port=59267']);
    assert.deepStrictEqual(result.windows.map(window => window.id), [1]);
});

test('status parser fails closed for malformed, other-PID, duplicate-primary and multiple-window evidence', async () => {
    assert.throws(() => parseCodeStatusForTest('not status', PID), (error: ColabEnvironmentError) => error.code === 'status_unparseable');
    assert.throws(() => parseCodeStatusForTest(status('', PID + 1), PID), (error: ColabEnvironmentError) => error.code === 'main_process_unverified');
    assert.throws(() => parseCodeStatusForTest(status() + `    0      51   ${PID}  code\n`, PID), (error: ColabEnvironmentError) => error.code === 'main_process_unverified');
    assert.strictEqual(parseCodeStatusForTest(status('', PID, 2), PID).windows.length, 2);
});

test('default Windows installation/profile derivation accepts only the pinned ordinary shape', async () => {
    const temp = path.join('C:\\Users', 'tester'); const appData = path.join(temp, 'AppData', 'Roaming'); const localAppData = path.join(temp, 'AppData', 'Local');
    const input = { platform: 'win32' as NodeJS.Platform, version: '1.142.0', execPath: path.join(temp, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        env: { APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: temp }, globalStoragePath: path.join(appData, 'Code', 'User', 'globalStorage', 'hadrian.jupyter-mcp'),
        extensionPath: path.join(temp, '.vscode', 'extensions', 'jupyter-mcp-0.5.0'), extensionId: 'hadrian.jupyter-mcp', appHost: 'desktop' };
    const actual = validateDefaultWindowsInstallForTest(input);
    assert.strictEqual(actual.userDataDir, path.resolve(appData, 'Code'));
    assert.throws(() => validateDefaultWindowsInstallForTest({ ...input, globalStoragePath: path.join(temp, 'profile', 'globalStorage', 'hadrian.jupyter-mcp') }), /default stable VS Code profile/);
    assert.throws(() => validateDefaultWindowsInstallForTest({ ...input, env: { ...input.env, VSCODE_PORTABLE: '1' } }), /Portable VS Code/);
});

test('read-only preflight reports bounded state and sanitized exact application corroboration', async () => {
    const f = await fixture({ restart: true, native: true });
    try {
        let probeCalls = 0;
        f.deps.probeNative = async () => { probeCalls++; return true; };
        state.folders = [{ name: 'private-project-name', uri: fileUri(path.join(f.temp, 'private-project')) }];
        state.workspaceFile = rawUri('untitled:private-workspace-identity');
        state.notebooks = [
            { uri: fileUri(path.join(f.temp, 'secret-notebook.ipynb')), isUntitled: false, isDirty: true },
            { uri: rawUri('untitled:private-draft.ipynb'), isUntitled: true, isDirty: false }
        ];
        state.documents = [
            { uri: fileUri(path.join(f.temp, 'secret.txt')), isUntitled: false, isDirty: false, getText: () => 'TOP SECRET CONTENT' },
            { uri: rawUri('untitled:private-text'), isUntitled: true, isDirty: true, getText: () => 'ANOTHER SECRET' }
        ];
        state.visibleEditors = [{}];
        state.activeEditor = {};
        state.visibleNotebooks = [{ notebook: state.notebooks[0] }];
        state.activeNotebook = { notebook: state.notebooks[0] };
        state.tabs = [{ label: 'private-tab-title', input: { secret: 'PRIVATE TAB INPUT' }, isDirty: true }];
        state.terminals = [{ name: 'private-shell', creationOptions: { shellPath: 'secret-command' } }];
        state.activeDebugSession = { name: 'private-debug-name' };
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.readOnly, true);
        assert.deepStrictEqual(result.window.workspace, { kind: 'workspace', folderCount: 1 });
        assert.deepStrictEqual(result.window.notebooks, { total: 2, fileBacked: 1, untitled: 1, dirty: 1, visibleEditors: 1, activeEditor: true });
        assert.deepStrictEqual(result.window.textDocuments, { total: 2, fileBacked: 1, untitled: 1, dirty: 1, blocking: 2, visibleEditors: 1, activeEditor: true });
        assert.deepStrictEqual(result.window.tabs, { total: 1, dirty: 1, benignWelcomeOnly: false });
        assert.deepStrictEqual(result.window.terminals, { total: 1 });
        assert.strictEqual(result.window.debugging.active, true);
        assert.strictEqual(result.nativeBinding.listenerAvailable, true);
        assert.strictEqual(result.nativeBinding.workbenchPageCount, 1);
        assert.strictEqual(result.nativeBinding.exactWindowBinding, 'not-established');
        assert.strictEqual(result.application.status, 'verified');
        assert.strictEqual(result.application.commit, COMMIT);
        assert.strictEqual(result.application.mainProcessPid, PID);
        assert.strictEqual(result.application.actualWindowCount, 1);
        assert.ok(result.blockers.includes('automatic_restart_workspace_present'));
        assert.ok(result.blockers.includes('open_document_present'));
        assert.ok(result.blockers.includes('terminal_present'));
        const serialized = JSON.stringify(result);
        for (const secret of ['private-project-name', 'private-workspace-identity', 'secret-notebook', 'TOP SECRET CONTENT', 'ANOTHER SECRET', 'private-tab-title', 'PRIVATE TAB INPUT', 'private-shell', 'secret-command', 'private-debug-name', '--crash-reporter-id']) {
            assert.ok(!serialized.includes(secret), `preflight leaked ${secret}`);
        }
        assert.deepStrictEqual(state.calls, []);
        assert.deepStrictEqual(state.workspaceUpdates, []);
        assert.strictEqual(probeCalls, 0, 'read-only inspection must not run the marker-binding native probe');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('preflight reports an invalid configured native port without probing or mutating', async () => {
    const f = await fixture({ restart: true });
    try {
        state.configuredPort = 70000;
        let nativeInspections = 0, probeCalls = 0;
        f.deps.inspectNative = async () => { nativeInspections++; return { listenerAvailable: true, workbenchPageCount: 1 }; };
        f.deps.probeNative = async () => { probeCalls++; return true; };
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.nativeBinding.source, 'invalid');
        assert.strictEqual(result.nativeBinding.port, null);
        assert.ok(result.blockers.includes('native_port_invalid'));
        assert.ok(result.blockers.includes('native_binding_unavailable'));
        assert.strictEqual(nativeInspections, 0);
        assert.strictEqual(probeCalls, 0);
        assert.strictEqual(f.quitCalls, 0);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('preflight editor-only blockers match the automatic empty-window checks', async () => {
    const f = await fixture({ restart: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        state.visibleNotebooks = [{}];
        let result = parsed(await manager.inspect());
        assert.strictEqual(result.window.notebooks.total, 0);
        assert.strictEqual(result.window.notebooks.visibleEditors, 1);
        assert.ok(result.blockers.includes('open_notebook_present'));

        state.visibleNotebooks = []; state.activeNotebook = {};
        result = parsed(await manager.inspect());
        assert.strictEqual(result.window.notebooks.activeEditor, true);
        assert.ok(result.blockers.includes('open_notebook_present'));

        state.activeNotebook = undefined; state.activeEditor = {};
        result = parsed(await manager.inspect());
        assert.strictEqual(result.window.textDocuments.total, 0);
        assert.strictEqual(result.window.textDocuments.activeEditor, true);
        assert.ok(result.blockers.includes('open_document_present'));
        assert.deepStrictEqual(state.calls, []);
        assert.deepStrictEqual(state.workspaceUpdates, []);
        assert.strictEqual(f.quitCalls, 0);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('preflight reports unsupported identity without invoking restart or exposing paths', async () => {
    const f = await fixture();
    try {
        let statusCalls = 0; f.deps.runCodeStatus = async () => { statusCalls++; return status(); };
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.application.status, 'unsupported');
        assert.strictEqual(result.application.defaultInstall, 'unsupported');
        assert.strictEqual(statusCalls, 0, 'unsupported installation must fail before running the status command');
        assert.strictEqual(f.quitCalls, 0);
        const serialized = JSON.stringify(result);
        assert.ok(!serialized.includes(f.temp));
        assert.ok(result.blockers.includes(result.application.failureCode));
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('preflight rejects a recycled main process across status corroboration', async () => {
    const f = await fixture({ restart: true });
    try {
        let inspections = 0;
        f.deps.inspectProcess = async () => ({
            pid: PID,
            executablePath: f.identity.executablePath,
            creationTime: ++inspections === 1 ? '20261021010101.000000+000' : '20261021010202.000000+000'
        });
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.application.status, 'mismatch');
        assert.strictEqual(result.application.mainProcessIdentity, 'mismatch');
        assert.strictEqual(result.application.failureCode, 'main_process_unverified');
        assert.strictEqual(inspections, 2);
        assert.strictEqual(f.quitCalls, 0);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('local vscode-userdata global storage maps only to the exact default-profile extension root', async () => {
    const temp = path.join('C:\\Users', 'tester'); const appData = path.join(temp, 'AppData', 'Roaming');
    const extensionId = 'Hadrian.Jupyter-Mcp';
    const expected = path.win32.join(appData, 'Code', 'User', 'globalStorage', extensionId.toLowerCase());
    const dependencies = { platform: 'win32' as NodeJS.Platform, env: { APPDATA: appData } };
    const context = { globalStorageUri: userDataUri(expected), extension: { id: extensionId } };
    assert.strictEqual(resolveLocalGlobalStoragePathForTest(context, dependencies).toLowerCase(), expected.toLowerCase());
    for (const uri of [
        userDataUri(expected, 'remote-authority'),
        userDataUri(path.win32.join(appData, 'Code', 'User', 'globalStorage', 'another.extension')),
        rawUri('vscode-userdata:relative/globalStorage/hadrian.jupyter-mcp'),
        rawUri('vscode-userdata:/C:/Users/tester/AppData/Roaming/Code/User/globalStorage/../hadrian.jupyter-mcp'),
        rawUri('memfs:/C:/Users/tester/AppData/Roaming/Code/User/globalStorage/hadrian.jupyter-mcp')
    ]) {
        assert.throws(() => resolveLocalGlobalStoragePathForTest({ ...context, globalStorageUri: uri }, dependencies),
            (error: ColabEnvironmentError) => error.code === 'local_storage_required');
    }
});

test('manager accepts the proven local vscode-userdata representation', async () => {
    if (process.platform !== 'win32') return;
    const f = await fixture({ restart: true });
    try {
        f.context.globalStorageUri = userDataUri(f.root);
        const manager = createColabEnvironmentForTest(f.context, f.deps);
        await manager.initialize();
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('failed initialization never publishes a partially initialized global manager', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jupyter-mcp-failed-environment-'));
    try {
        const storageFile = path.join(temp, 'not-a-directory'); await fs.writeFile(storageFile, 'x');
        const context = { globalStorageUri: fileUri(storageFile), extensionPath: temp, extension: { id: 'hadrian.jupyter-mcp' }, subscriptions: [] } as any;
        await assert.rejects(() => initializeColabEnvironment(context));
        await rejectsCode(() => prepareColabEnvironment(), 'environment_not_initialized');
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('normal status invocation resolves the versioned CLI only through the pinned code.cmd shape', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jupyter-mcp-code-cli-'));
    try {
        const executable = path.join(temp, 'Code.exe'), cli = path.join(temp, '6d62b1d5da', 'resources', 'app', 'out', 'cli.js');
        await fs.mkdir(path.dirname(cli), { recursive: true }); await fs.mkdir(path.join(temp, 'bin'), { recursive: true });
        await fs.writeFile(cli, '');
        await fs.writeFile(path.join(temp, 'bin', 'code.cmd'), '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\6d62b1d5da\\resources\\app\\out\\cli.js" %*\r\n');
        assert.strictEqual(await resolveInstalledCodeCliForTest(executable), path.resolve(cli));
        await fs.writeFile(path.join(temp, 'bin', 'code.cmd'), 'Code.exe --status');
        await rejectsCode(() => resolveInstalledCodeCliForTest(executable), 'status_unavailable');
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('a native port without a workspace opens an isolated folder and never claims readiness alone', async () => {
    const f = await fixture({ native: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const initial = parsed(await manager.prepare());
        assert.strictEqual(initial.status, 'workspace_open_requested'); assert.strictEqual(initial.environmentReady, false); assert.strictEqual(initial.runtimeReady, false);
        assert.match(initial.expectedWindowLabel, /^colab-bootstrap-[0-9a-f]{8}$/);
        assert.strictEqual(state.calls[0][0], 'vscode.openFolder');
        const stillWrong = parsed(await manager.get(initial.preparationId)); assert.strictEqual(stillWrong.environmentReady, false);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('readiness requires the exact generated workspace, nonce marker and a fresh native bind', async () => {
    const f = await fixture({ native: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const initial = parsed(await manager.prepare()); const uri = (state.calls[0][1] as any);
        state.folders = [{ name: initial.expectedWindowLabel, uri }];
        const receiptPath = path.join(f.root, 'colab-environment-receipts', `${initial.preparationId}.json`);
        const receipt: ColabEnvironmentReceiptForTest = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
        const markerPath = path.join(receipt.workspacePath!, 'jupyter-mcp-environment.json');
        await fs.writeFile(markerPath, JSON.stringify({ schema: 1, preparationId: receipt.preparationId, nonce: crypto.randomUUID() }));
        assert.strictEqual(parsed(await manager.get(initial.preparationId)).environmentReady, false);
        await fs.writeFile(markerPath, JSON.stringify({ schema: 1, preparationId: receipt.preparationId, nonce: receipt.nonce }));
        assert.strictEqual(parsed(await manager.get(initial.preparationId)).environmentReady, false);
        assert.strictEqual(state.workspaceUpdates.length, 0, 'polling must not convert a folder');
        await manager.initialize();
        assert.strictEqual(state.workspaceUpdates.length, 1);
        state.workspaceFile = rawUri('untitled:123456');
        state.folders[0].name = receipt.folderPreparation!.preparedName;
        const ready = parsed(await manager.get(initial.preparationId));
        assert.strictEqual(ready.status, 'environment_ready'); assert.strictEqual(ready.environmentReady, true);
        assert.strictEqual(ready.workspaceUri, state.workspaceFile.toString()); assert.strictEqual(ready.folderUri, uri.toString());
        f.deps.probeNative = async () => false;
        const stale = parsed(await manager.get(initial.preparationId));
        assert.strictEqual(stale.status, 'native_binding_unavailable'); assert.strictEqual(stale.environmentReady, false);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('remote and dirty windows fail before helper arming or quit', async () => {
    const f = await fixture({ restart: true }); const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
    try {
        state.remoteName = 'ssh-remote'; await rejectsCode(() => manager.prepare(), 'remote_host_unsupported'); state.remoteName = undefined;
        state.documents = [{ isDirty: true, isUntitled: false, uri: fileUri(path.join(f.root, 'dirty.txt')) }];
        await rejectsCode(() => manager.prepare(), 'open_document_present'); assert.strictEqual(f.quitCalls, 0);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('close-confirmation ambiguity and active debugging refuse automatic restart', async () => {
    for (const [configure, code] of [
        [() => { state.confirmBeforeClose = 'always'; }, 'close_confirmation_unsupported'],
        [() => { state.confirmBeforeClose = undefined; }, 'close_confirmation_unsupported'],
        [() => { state.activeDebugSession = { id: 'debug' }; }, 'debug_session_present']
    ] as const) {
        const f = await fixture({ restart: true }); configure();
        try {
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            await rejectsCode(() => manager.prepare(), code); assert.strictEqual(f.quitCalls, 0);
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('configured port takes precedence over an otherwise working environment port', async () => {
    const f = await fixture({ restart: true });
    state.configuredPort = 50001;
    f.deps.env.JUPYTER_MCP_NATIVE_DEBUG_PORT = '59267';
    const probed: number[] = [];
    f.deps.probeNative = async port => { probed.push(port); return port === 59267; };
    f.deps.reservePort = async requested => { assert.strictEqual(requested, 50001); return 50001; };
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.prepare());
        assert.deepStrictEqual(probed, [50001]);
        assert.strictEqual(result.status, 'restart_requested');
        assert.strictEqual(result.environmentReady, false);
        const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'colab-environment-receipts', `${result.preparationId}.json`), 'utf8'));
        assert.strictEqual(receipt.port, 50001);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('unknown startup arguments and multiple windows fail closed', async () => {
    for (const [output, code] of [
        [status('--unexpected'), 'startup_arguments_unsupported'],
        [status('--new-window --new-window'), 'startup_arguments_unsupported'],
        [status('C:\\user-file.txt --new-window'), 'startup_arguments_unsupported'],
        [status('', PID, 2), 'window_count_unsupported']
    ] as const) {
        const f = await fixture({ restart: true }); f.deps.runCodeStatus = async () => output;
        try { const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize(); await rejectsCode(() => manager.prepare(), code); assert.strictEqual(f.quitCalls, 0); }
        finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('one benign --new-window flag remains eligible for the bounded empty-window path', async () => {
    for (const args of ['--new-window', `--new-window --crash-reporter-id ${CRASH}`, `--crash-reporter-id ${CRASH} --new-window`]) {
        const f = await fixture({ restart: true }); f.deps.runCodeStatus = async () => status(args);
        try {
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            assert.strictEqual(parsed(await manager.prepare()).status, 'restart_requested');
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('helper spawn failure and disposal cancellation never request quit', async () => {
    for (const cancelled of [false, true]) {
        const f = await fixture({ restart: true });
        f.deps.armHelper = async () => { if (cancelled) f.dispose(); throw new Error('spawn refused'); };
        try {
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            await rejectsCode(() => manager.prepare(), cancelled ? 'cancelled' : 'helper_arm_failed'); assert.strictEqual(f.quitCalls, 0);
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('quit is requested only after helper acknowledgment and unchanged exact process identity', async () => {
    const accepted = await fixture({ restart: true });
    try {
        const manager = createColabEnvironmentForTest(accepted.context, accepted.deps); await manager.initialize();
        const result = parsed(await manager.prepare()); assert.strictEqual(result.status, 'restart_requested'); assert.strictEqual(accepted.quitCalls, 0);
        assert.strictEqual(await accepted.runScheduledQuit(), true); assert.strictEqual(accepted.quitCalls, 1);
    } finally { accepted.dispose(); await fs.rm(accepted.temp, { recursive: true, force: true }); }
    const changed = await fixture({ restart: true }); let observations = 0;
    changed.deps.inspectProcess = async () => ++observations === 1 ? changed.identity : { ...changed.identity, creationTime: 'changed' };
    try {
        const manager = createColabEnvironmentForTest(changed.context, changed.deps); await manager.initialize();
        await rejectsCode(() => manager.prepare(), 'helper_arm_failed'); assert.strictEqual(changed.quitCalls, 0);
    } finally { changed.dispose(); await fs.rm(changed.temp, { recursive: true, force: true }); }
});

test('delayed quit dispatch rechecks the empty window and records changed preflight without quitting', async () => {
    const f = await fixture({ restart: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.prepare()); state.documents = [{ isDirty: true, isUntitled: false, uri: fileUri(path.join(f.temp, 'late.txt')) }];
        assert.strictEqual(await f.runScheduledQuit(), false); assert.strictEqual(f.quitCalls, 0);
        const final = parsed(await manager.get(result.preparationId)); assert.strictEqual(final.status, 'failed'); assert.strictEqual(final.failure, 'quit_preflight_changed');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('debugging started before deferred quit prevents the restart', async () => {
    const f = await fixture({ restart: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.prepare()); state.activeDebugSession = { id: 'late-debug' };
        assert.strictEqual(await f.runScheduledQuit(), false); assert.strictEqual(f.quitCalls, 0);
        const final = parsed(await manager.get(result.preparationId)); assert.strictEqual(final.status, 'failed'); assert.strictEqual(final.failure, 'quit_preflight_changed');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('a surviving extension host conservatively disarms an unconfirmed quit', async () => {
    const f = await fixture({ restart: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.prepare());
        assert.strictEqual(await f.runScheduledQuit(), true); assert.strictEqual(f.quitCalls, 1);
        await f.runQuitWatchdog();
        const final = parsed(await manager.get(result.preparationId));
        assert.strictEqual(final.status, 'failed'); assert.strictEqual(final.failure, 'quit_not_confirmed');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('shutdown disposal preserves the request while a same-main owner reload disarms it', async () => {
    const f = await fixture({ restart: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.prepare()); assert.strictEqual(await f.runScheduledQuit(), true);
        f.dispose(); await f.runQuitWatchdog();
        const receiptPath = path.join(f.root, 'colab-environment-receipts', `${result.preparationId}.json`);
        assert.strictEqual(JSON.parse(await fs.readFile(receiptPath, 'utf8')).status, 'restart_requested');
        const reloadedContext = { ...f.context, subscriptions: [] as Array<{ dispose(): unknown }> };
        const reloaded = createColabEnvironmentForTest(reloadedContext, f.deps); await reloaded.initialize();
        const final = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
        assert.strictEqual(final.status, 'failed'); assert.strictEqual(final.failure, 'owner_reloaded');
    } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('watchdog receipt reads retry transient failures within a fixed bound', async () => {
    let reads = 0, waits = 0;
    const recovered = await retryWatchdogReceiptReadForTest(async () => {
        if (++reads === 1) throw new Error('transient read');
        if (reads === 2) return undefined;
        return 'receipt';
    }, () => true, async () => { waits++; }, 5);
    assert.strictEqual(recovered, 'receipt'); assert.strictEqual(reads, 3); assert.strictEqual(waits, 2);
    reads = 0; waits = 0;
    const bounded = await retryWatchdogReceiptReadForTest(async () => { reads++; throw new Error('persistent read'); }, () => true, async () => { waits++; }, 3);
    assert.strictEqual(bounded, undefined); assert.strictEqual(reads, 3); assert.strictEqual(waits, 2);
    let active = true;
    const disposedDuringRead = await retryWatchdogReceiptReadForTest(async () => { active = false; return 'stale receipt'; }, () => active, async () => undefined, 3);
    assert.strictEqual(disposedDuringRead, undefined);
});

test('a second app window opened before deferred quit prevents the restart', async () => {
    const f = await fixture({ restart: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.prepare());
        f.deps.runCodeStatus = async () => status('', PID, 2);
        assert.strictEqual(await f.runScheduledQuit(), false);
        assert.strictEqual(f.quitCalls, 0);
        assert.strictEqual(parsed(await manager.get(result.preparationId)).failure, 'quit_preflight_changed');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('fixed helper has no forced termination and an invalid token cannot mutate a receipt', async () => {
    assert.doesNotMatch(HELPER_SOURCE_FOR_TEST, /taskkill|Stop-Process|\.kill\s*\(/i);
    assert.doesNotMatch(HELPER_SOURCE_FOR_TEST, /ErrorAction SilentlyContinue/);
    assert.match(HELPER_SOURCE_FOR_TEST, /ErrorAction Stop/);
    assert.match(HELPER_SOURCE_FOR_TEST, /if\(p\).*return setTimeout\(poll,250\)/);
    assert.match(HELPER_SOURCE_FOR_TEST, /quit_not_confirmed/);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jupyter-mcp-helper-'));
    try {
        const helper = path.join(temp, 'helper.cjs'), receiptPath = path.join(temp, 'receipt.json');
        const id = crypto.randomUUID(), token = crypto.randomUUID();
        const receipt = { schema: 1, preparationId: id, helperToken: token, status: 'arming_restart' };
        await fs.writeFile(helper, HELPER_SOURCE_FOR_TEST); await fs.writeFile(receiptPath, JSON.stringify(receipt));
        const child = spawnSync(process.execPath, [helper, receiptPath, id, crypto.randomUUID()], { timeout: 5_000 });
        assert.strictEqual(child.status, 0); assert.deepStrictEqual(JSON.parse(await fs.readFile(receiptPath, 'utf8')), receipt);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('PowerShell identity query distinguishes a missing process from a CIM failure', async () => {
    if (process.platform !== 'win32') return;
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const absent = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', buildProcessIdentityPowerShellForTest(2_147_483_647)], { encoding: 'utf8' });
    assert.strictEqual(absent.status, 0); assert.strictEqual(absent.stdout.trim(), '');
    const failed = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', buildProcessIdentityPowerShellForTest(2_147_483_647, 'JupyterMcpMissingCimClass')], { encoding: 'utf8' });
    assert.strictEqual(failed.status, 17); assert.notStrictEqual(failed.stderr.trim(), '');
});

test('an explicit existing folder survives restart preparation without writing into it', async () => {
    const f = await fixture({ restart: true });
    const folder = path.join(f.temp, 'user-project'); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'sentinel.txt'), 'preserve');
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.prepare(fileUri(folder).toString()));
        assert.strictEqual(result.status, 'restart_requested');
        assert.strictEqual(result.workspaceUri, fileUri(await fs.realpath(folder)).toString());
        assert.strictEqual(result.expectedWindowLabel, 'user-project');
        const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'colab-environment-receipts', `${result.preparationId}.json`), 'utf8'));
        assert.strictEqual(receipt.generatedWorkspace, false); assert.strictEqual(receipt.workspacePath, await fs.realpath(folder));
        assert.deepStrictEqual(await fs.readdir(folder), ['sentinel.txt']);
        assert.strictEqual(await fs.readFile(path.join(folder, 'sentinel.txt'), 'utf8'), 'preserve');
        assert.strictEqual(await f.runScheduledQuit(), true);
        state.folders = [{ uri: fileUri(await fs.realpath(folder)), name: 'user-project' }];
        f.deps.probeNative = async () => true;
        state.trusted = false;
        const untrusted = parsed(await manager.get(result.preparationId));
        assert.strictEqual(untrusted.environmentReady, false); assert.strictEqual(untrusted.status, 'workspace_untrusted');
        state.trusted = true;
        f.deps.env.VSCODE_PID = String(PID + 1); // the normal-quit bootstrap launched a different main process
        await manager.initialize();
        assert.strictEqual(state.workspaceUpdates.length, 1);
        state.workspaceFile = rawUri('untitled:654321');
        state.folders[0].name = receipt.folderPreparation.preparedName;
        const ready = parsed(await manager.get(result.preparationId));
        assert.strictEqual(ready.environmentReady, true); assert.strictEqual(ready.runtimeReady, false);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('a configured native empty window opens only the explicitly requested folder', async () => {
    const f = await fixture({ native: true });
    const folder = path.join(f.temp, 'project'); await fs.mkdir(folder);
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.prepare(fileUri(folder).toString()));
        assert.strictEqual(result.status, 'workspace_open_requested');
        assert.strictEqual(state.calls.length, 1); assert.strictEqual(state.calls[0][0], 'vscode.openFolder');
        assert.strictEqual(state.calls[0][1].toString(), result.workspaceUri);
        assert.deepStrictEqual(await fs.readdir(folder), []);
        const other = path.join(f.temp, 'other'); await fs.mkdir(other);
        await rejectsCode(() => manager.prepare(fileUri(other).toString()), 'preparation_target_mismatch');
        assert.strictEqual(state.calls.length, 1);
        state.folders = [{ uri: fileUri(await fs.realpath(folder)), name: 'project' }];
        await rejectsCode(() => manager.prepare(fileUri(other).toString()), 'preparation_target_mismatch');
        const requested = parsed(await manager.prepare(fileUri(folder).toString()));
        assert.strictEqual(requested.status, 'workspace_conversion_requested'); assert.strictEqual(requested.environmentReady, false);
        assert.strictEqual(state.workspaceUpdates.length, 1);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('folder selection rejects remote, malformed, unavailable and non-directory targets before launch', async () => {
    const f = await fixture({ restart: true });
    const file = path.join(f.temp, 'file.txt'); await fs.writeFile(file, 'preserve');
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        for (const uri of ['https://example.com/', 'colab://server/content', 'file://server/share', 'relative', `${fileUri(f.temp)}?q=1`, `${fileUri(f.temp)}#fragment`]) {
            await rejectsCode(() => manager.prepare(uri), 'folder_uri_invalid');
        }
        await rejectsCode(() => manager.prepare(fileUri(file).toString()), 'folder_not_directory');
        await rejectsCode(() => manager.prepare(fileUri(path.join(f.temp, 'missing')).toString()), 'folder_unavailable');
        assert.strictEqual(f.quitCalls, 0); assert.deepStrictEqual(state.calls, []);
        assert.deepStrictEqual(await fs.readdir(path.join(f.root, 'colab-environment-receipts')), []);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('one-root conversion is durable, read-only to poll, and survives activation before later mounts', async () => {
    const f = await fixture({ native: true });
    try {
        const folder = path.join(f.temp, 'project'); await fs.mkdir(folder);
        state.folders = [{ uri: fileUri(folder), name: 'project' }];
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const requested = parsed(await manager.prepare());
        assert.strictEqual(requested.status, 'workspace_conversion_requested'); assert.strictEqual(requested.environmentReady, false);
        assert.strictEqual(state.workspaceUpdates.length, 1);
        assert.deepStrictEqual(state.workspaceUpdates[0].slice(0, 2), [0, 1]);
        assert.strictEqual(state.workspaceUpdates[0][2].uri, state.folders[0].uri);
        assert.notStrictEqual(state.workspaceUpdates[0][2].name, 'project');
        const receiptPath = path.join(f.root, 'colab-environment-receipts', `${requested.preparationId}.json`);
        const persisted = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
        assert.strictEqual(persisted.folderPreparation.requestedAt, f.deps.now());
        await manager.get(requested.preparationId); await manager.prepare(); await manager.initialize();
        assert.strictEqual(state.workspaceUpdates.length, 1, 'an unacknowledged conversion is never replayed');
        state.workspaceFile = rawUri('untitled:owned-workspace'); state.folders[0].name = state.workspaceUpdates[0][2].name;
        const activated = createColabEnvironmentForTest({ ...f.context, subscriptions: [] }, f.deps); await activated.initialize();
        const ready = parsed(await activated.get(requested.preparationId));
        assert.strictEqual(ready.environmentReady, true); assert.strictEqual(ready.runtimeReady, false);
        assert.strictEqual(ready.workspaceUri, 'untitled:owned-workspace'); assert.strictEqual(ready.expectedWindowLabel, state.folders[0].name);
        const pinned = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
        assert.strictEqual(pinned.folderPreparation.workspaceFileUri, 'untitled:owned-workspace');
        state.folders.push({ uri: rawUri('colab://owned/content'), name: 'm12345678' });
        assert.strictEqual(parsed(await activated.get(requested.preparationId)).environmentReady, true);
        assert.strictEqual(state.workspaceUpdates.length, 1);
        state.workspaceFile = rawUri('untitled:different-workspace');
        assert.strictEqual(parsed(await activated.get(requested.preparationId)).environmentReady, false);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('conversion refuses restored work and retains the blocker without closing or saving it', async () => {
    for (const [configure, code] of [
        [() => { state.notebooks = [{}]; }, 'open_notebook_present'],
        [() => { state.terminals = [{}]; }, 'terminal_present'],
        [() => { state.documents = [{ isDirty: true }]; }, 'open_document_present'],
        [() => { state.activeDebugSession = {}; }, 'debug_session_present'],
        [() => { state.tabs = [{ label: 'draft', isDirty: true }]; }, 'editor_present']
    ] as const) {
        const f = await fixture({ native: true });
        try {
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            const initial = parsed(await manager.prepare());
            state.folders = [{ uri: state.calls[0][1], name: initial.expectedWindowLabel }]; configure();
            await manager.initialize();
            const final = parsed(await manager.get(initial.preparationId));
            assert.strictEqual(final.status, 'failed'); assert.strictEqual(final.failure, code);
            assert.strictEqual(state.workspaceUpdates.length, 0); assert.strictEqual(state.calls.length, 1);
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('API rejection is terminal and concurrent preparations dispatch conversion once', async () => {
    const f = await fixture({ native: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const initial = parsed(await manager.prepare());
        state.folders = [{ uri: state.calls[0][1], name: initial.expectedWindowLabel }];
        state.workspaceUpdateResult = false;
        await Promise.all([manager.prepare(), manager.prepare()]);
        assert.strictEqual(state.workspaceUpdates.length, 1);
        const final = parsed(await manager.get(initial.preparationId));
        assert.strictEqual(final.status, 'failed'); assert.strictEqual(final.failure, 'workspace_conversion_rejected');
        await manager.initialize(); assert.strictEqual(state.workspaceUpdates.length, 1);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('conversion rejects work introduced during native probing and never dispatches from receipt reads', async () => {
    const f = await fixture({ native: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const initial = parsed(await manager.prepare());
        state.folders = [{ uri: state.calls[0][1], name: initial.expectedWindowLabel }];
        await manager.get(initial.preparationId); assert.strictEqual(state.workspaceUpdates.length, 0);
        f.deps.probeNative = async () => { state.terminals = [{}]; return true; };
        await manager.initialize();
        const final = parsed(await manager.get(initial.preparationId));
        assert.strictEqual(final.failure, 'terminal_present'); assert.strictEqual(state.workspaceUpdates.length, 0);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('conversion readback requires the exact renamed root in a one-root untitled workspace', async () => {
    const f = await fixture({ native: true });
    try {
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const initial = parsed(await manager.prepare());
        const root = { uri: state.calls[0][1], name: initial.expectedWindowLabel };
        state.folders = [root]; await manager.initialize();
        state.workspaceFile = fileUri(path.join(f.temp, 'unrelated.code-workspace'));
        root.name = state.workspaceUpdates[0][2].name;
        assert.strictEqual(parsed(await manager.get(initial.preparationId)).environmentReady, false);
        state.workspaceFile = rawUri('untitled:owned');
        state.folders.push({ uri: rawUri('colab://unverified/content'), name: 'unexpected' });
        assert.strictEqual(parsed(await manager.get(initial.preparationId)).environmentReady, false);
        state.folders = [root]; root.name = 'wrong-name';
        assert.strictEqual(parsed(await manager.get(initial.preparationId)).environmentReady, false);
        root.name = state.workspaceUpdates[0][2].name;
        f.deps.probeNative = async () => { root.name = 'changed-during-probe'; return true; };
        assert.strictEqual(parsed(await manager.get(initial.preparationId)).environmentReady, false);
        assert.strictEqual(state.workspaceUpdates.length, 1);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('existing configured workspaces are reused with their actual folder labels', async () => {
    const f = await fixture({ native: true });
    try {
        const folder = path.join(f.temp, 'project'); await fs.mkdir(folder);
        state.folders = [{ uri: fileUri(await fs.realpath(folder)), name: 'project' }];
        state.workspaceFile = rawUri('untitled:already-existing');
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.prepare(fileUri(folder).toString()));
        assert.strictEqual(result.environmentReady, true); assert.strictEqual(result.expectedWindowLabel, 'project');
        assert.strictEqual(state.workspaceUpdates.length, 0);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('fixed helper waits for quit approval and exact original exit before acknowledging app launch', async () => {
    const beforeApproval = helperHarness({ approved: false, observations: ['exited'] });
    beforeApproval.runTimer();
    assert.strictEqual(beforeApproval.inspections, 0); assert.strictEqual(beforeApproval.launches.length, 0);
    assert.strictEqual(beforeApproval.receipt.status, 'restart_requested');

    const approved = helperHarness({ approved: true, observations: ['live', 'exited'] });
    approved.runTimer();
    assert.strictEqual(approved.inspections, 1); assert.strictEqual(approved.launches.length, 0);
    approved.runTimer();
    assert.strictEqual(approved.inspections, 2); assert.strictEqual(approved.launches.length, 1);
    assert.strictEqual(approved.receipt.status, 'restart_requested', 'spawn creation is not acknowledged before its spawn event');
    approved.runTimer();
    assert.strictEqual(approved.receipt.status, 'app_launched'); assert.strictEqual(approved.receipt.launchPid, 777);
    assert.strictEqual(approved.launches[0]!.executable, 'C:\\Code.exe');
    assert.deepStrictEqual(Array.from(approved.launches[0]!.args.slice(-2)), ['--remote-debugging-port=59267', 'C:\\workspace']);
    assert.strictEqual(approved.launches[0]!.options.windowsHide, false, 'the user-facing editor must be visible');
    assert.strictEqual(approved.launches[0]!.options.detached, true);
    assert.strictEqual(approved.launches[0]!.options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.strictEqual(approved.launches[0]!.options.env.VSCODE_PID, undefined);
    assert.strictEqual(approved.launches[0]!.options.env.VSCODE_IPC_HOOK_CLI, undefined);
    assert.strictEqual(approved.launches[0]!.options.env.PATH, 'sentinel-path');
    assert.strictEqual(approved.launches[0]!.options.env.JUPYTER_MCP_NATIVE_DEBUG_PORT, '59267');

    const failed = helperHarness({ approved: true, observations: ['exited'], spawnError: true });
    failed.runTimer(); failed.runTimer();
    assert.strictEqual(failed.receipt.status, 'failed'); assert.strictEqual(failed.receipt.failure, 'app_launch_failed');
    assert.strictEqual(failed.receipt.launchPid, undefined);
});

test('fixed helper retries unknown receipt/process observations but permanently rejects changed identity', async () => {
    const transient = helperHarness({ approved: true, readFailuresAfterArm: 1, observations: ['error', 'malformed', 'live', 'exited'] });
    transient.runTimer();
    assert.strictEqual(transient.inspections, 0); assert.strictEqual(transient.launches.length, 0);
    transient.runTimer(); transient.runTimer(); transient.runTimer();
    assert.strictEqual(transient.inspections, 3); assert.strictEqual(transient.launches.length, 0);
    transient.runTimer();
    assert.strictEqual(transient.launches.length, 1); assert.strictEqual(transient.receipt.status, 'restart_requested');
    transient.failNextReads(1); transient.runTimer();
    assert.strictEqual(transient.receipt.status, 'restart_requested');
    transient.runTimer();
    assert.strictEqual(transient.receipt.status, 'app_launched');

    const changed = helperHarness({ approved: true, observations: ['changed'] });
    changed.runTimer();
    assert.strictEqual(changed.receipt.status, 'failed'); assert.strictEqual(changed.receipt.failure, 'main_process_identity_changed');
    assert.strictEqual(changed.launches.length, 0);

    const bounded = helperHarness({ approved: true, observations: ['error'] });
    bounded.advance(10_001); bounded.runTimer();
    assert.strictEqual(bounded.receipt.status, 'failed'); assert.strictEqual(bounded.receipt.failure, 'quit_not_confirmed');
    assert.strictEqual(bounded.launches.length, 0);
});

test('cancelled or unconfirmed receipts stay disarmed after a later original-process exit', async () => {
    for (const failure of ['cancelled', 'quit_not_confirmed']) {
        const helper = helperHarness({ approved: true, observations: ['exited'] });
        helper.mutateReceipt(receipt => { receipt.status = 'failed'; receipt.failure = failure; });
        helper.runTimer();
        assert.strictEqual(helper.inspections, 0); assert.strictEqual(helper.launches.length, 0); assert.strictEqual(helper.receipt.failure, failure);
    }
});

test('helper rechecks a watchdog disarm after observing the original process exit', async () => {
    const helper = helperHarness({ approved: true, observations: ['exited'], disarmDuringInspection: true });
    helper.runTimer();
    assert.strictEqual(helper.inspections, 1); assert.strictEqual(helper.launches.length, 0);
    assert.strictEqual(helper.receipt.status, 'failed'); assert.strictEqual(helper.receipt.failure, 'quit_not_confirmed');
});

test('fixed helper times out against a still-live original process without launching a second app', async () => {
    if (process.platform !== 'win32') return;
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jupyter-mcp-helper-veto-'));
    try {
        const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}";$p.ExecutablePath;$p.CreationDate.ToUniversalTime().ToString('o')`;
        const lines = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
            .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        assert.strictEqual(lines.length, 2); assert.strictEqual(path.resolve(lines[0]).toLowerCase(), path.resolve(process.execPath).toLowerCase());
        const helper = path.join(temp, 'helper.cjs'), receiptPath = path.join(temp, 'receipt.json');
        const id = crypto.randomUUID(), token = crypto.randomUUID();
        const receipt = { schema: 1, preparationId: id, helperToken: token, status: 'arming_restart', deadline: Date.now() + 5_000,
            main: { pid: process.pid, executablePath: process.execPath, creationTime: lines[1] }, executablePath: process.execPath,
            workspacePath: temp, userDataDir: temp, extensionsDir: temp, port: 59267, quitDispatchApprovedAt: Date.now() };
        await fs.writeFile(helper, HELPER_SOURCE_FOR_TEST); await fs.writeFile(receiptPath, JSON.stringify(receipt));
        const child = spawnSync(process.execPath, [helper, receiptPath, id, token], { timeout: 15_000 });
        assert.strictEqual(child.status, 0);
        const final = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
        assert.strictEqual(final.status, 'failed'); assert.strictEqual(final.failure, 'quit_not_confirmed'); assert.strictEqual(final.launchPid, undefined);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

async function main(): Promise<void> {
    let passed = 0;
    for (const [name, work] of cases) { await work(); console.log('PASS ' + name); passed++; }
    console.log(`${passed} Colab environment tests passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
