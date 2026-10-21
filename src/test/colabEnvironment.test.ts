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
    inspectSavedStateMetadataForTest, resolveInstalledCodeCliForTest, resolveLocalGlobalStoragePathForTest, retryWatchdogReceiptReadForTest, validateDefaultWindowsInstallForTest
} from '../colabEnvironment';
import { fileUri, rawUri, reset, state, TabInputNotebook, TabInputText, TabInputWebview, userDataUri } from './colabEnvironmentStub';
import { acquireRestartExclusion, beginLocalOperation, operationGateStateForTest } from '../operationGate';

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

async function fixture(options: { native?: boolean; restart?: boolean; spacedPaths?: boolean } = {}): Promise<Fixture> {
    reset();
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), options.spacedPaths ? 'jupyter mcp colab environment-' : 'jupyter-mcp-colab-environment-'));
    const appData = path.join(temp, 'AppData', 'Roaming');
    const localAppData = path.join(temp, 'AppData', 'Local');
    const profile = temp;
    const extensionId = 'Happypig375.vscode-jupyter-mcp-server';
    const root = options.restart ? path.join(appData, 'Code', 'User', 'globalStorage', extensionId) : path.join(temp, 'storage');
    const extensionPath = options.restart ? path.join(profile, '.vscode', 'extensions', 'jupyter-mcp-0.5.0') : path.join(temp, 'extension');
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(extensionPath, { recursive: true });
    if (options.restart) {
        await fs.mkdir(path.join(appData, 'Code', 'Workspaces'), { recursive: true });
        await fs.writeFile(path.join(appData, 'Code', 'User', 'globalStorage', 'storage.json'), JSON.stringify({
            backupWorkspaces: { workspaces: [{ id: 'configured', configURIPath: 'file:///configured.code-workspace' }], folders: [], emptyWindows: [] }
        }));
    }
    const disposables: Array<{ dispose(): unknown }> = [];
    const identity = { pid: PID, executablePath: path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'), creationTime: CREATION };
    let quitCalls = 0;
    let scheduledQuit: (() => Promise<boolean>) | undefined;
    let quitWatchdog: (() => Promise<void>) | undefined;
    const result: Fixture = {
        root, temp, identity,
        context: {
            globalStorageUri: fileUri(root),
            logUri: fileUri(path.join(appData, 'Code', 'logs', '20261021T010203', 'window1', 'exthost', extensionId)),
            extensionPath, extension: { id: extensionId }, subscriptions: disposables
        },
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
            assertNoActiveKernels: async () => undefined,
            hasBackgroundWork: () => false,
            inspectSavedState: inspectSavedStateMetadataForTest,
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

async function configuredWorkspace(f: Fixture, kind: 'file' | 'untitled' = 'file'): Promise<{ root: any; text: any; notebook: any; workspaceFile: any }> {
    const rootPath = path.join(f.temp, 'project');
    const textPath = path.join(rootPath, 'notes.txt');
    const notebookPath = path.join(rootPath, 'research.ipynb');
    await fs.mkdir(rootPath, { recursive: true });
    await fs.writeFile(textPath, 'invented fixture');
    await fs.writeFile(notebookPath, '{}');
    const root = fileUri(rootPath), textUri = fileUri(textPath), notebookUri = fileUri(notebookPath);
    let workspaceFile: any;
    if (kind === 'file') {
        const workspacePath = path.join(f.temp, 'research.code-workspace');
        await fs.writeFile(workspacePath, '{"folders":[]}');
        workspaceFile = fileUri(workspacePath);
    } else {
        const current = path.join(f.deps.env.APPDATA!, 'Code', 'Workspaces', 'current');
        await fs.mkdir(current, { recursive: true });
        workspaceFile = rawUri(`untitled:${path.join(current, 'workspace.json').replace(/\\/g, '/')}`);
    }
    state.workspaceFile = workspaceFile;
    state.folders = [{ name: 'Research', uri: root }];
    state.documents = [{ uri: textUri, isDirty: false, isUntitled: false, version: 7 }];
    state.notebooks = [{ uri: notebookUri, isDirty: false, isUntitled: false, version: 11, notebookType: 'jupyter-notebook' }];
    state.tabGroups = [{ tabs: [
        { label: 'notes.txt', input: new TabInputText(textUri), isDirty: false },
        { label: 'research.ipynb', input: new TabInputNotebook(notebookUri, 'jupyter-notebook'), isDirty: false }
    ] }];
    return { root, text: textUri, notebook: notebookUri, workspaceFile };
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
    restored?: boolean;
}) {
    const id = crypto.randomUUID(), token = crypto.randomUUID(), receiptPath = 'C:\\receipt.json';
    let now = 1_800_000_000_000;
    const receipt: any = { schema: 1, preparationId: id, nonce: crypto.randomUUID(), helperToken: token, status: 'arming_restart',
        createdAt: now, deadline: now + 120_000, workspaceUri: 'file:///C:/workspace', expectedWindowLabel: 'workspace', generatedWorkspace: true,
        main: { pid: 123, executablePath: 'C:\\Code.exe', creationTime: CREATION }, executablePath: 'C:\\Code.exe',
        workspacePath: 'C:\\workspace', userDataDir: 'C:\\user', extensionsDir: 'C:\\extensions', port: 59267 };
    if (options.restored) Object.assign(receipt, {
        restartMode: 'restore-clean-workspace', restartRequired: true, generatedWorkspace: false, installedCommit: COMMIT,
        workspacePath: undefined, folderPreparation: undefined,
        restorationSnapshot: {
            schema: 1,
            workspace: { uri: receipt.workspaceUri, kind: 'file', roots: [{ uri: 'file:///C:/project', name: 'Research' }] },
            tabGroups: [], documents: { text: [], notebooks: [] },
            savedState: { untitledWorkspaces: [], backupRegistry: { workspaces: 1, folders: 0, emptyWindows: 0 } }
        }
    });
    const files = new Map<string, Buffer>([[receiptPath, Buffer.from(JSON.stringify(receipt))]]);
    files.set(path.join('C:\\user', 'User', 'globalStorage', 'storage.json'), Buffer.from(JSON.stringify({
        backupWorkspaces: { workspaces: [{ id: 'configured', configURIPath: 'file:///configured.code-workspace' }], folders: [], emptyWindows: [] }
    })));
    const timers: Array<() => void> = []; const launches: Array<{ executable: string; args: string[]; options: any }> = [];
    let exits = 0; let inspections = 0; let armed = false; let remainingReadFailures = options.readFailuresAfterArm ?? 0;
    const fakeFs = {
        readFileSync: (file: string) => {
            if (armed && remainingReadFailures-- > 0) throw new Error('transient read');
            const value = files.get(file); if (!value) throw new Error('missing'); return value;
        },
        readdirSync: () => [],
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
        mutateStorage: (change: (value: any) => void) => {
            const storagePath = path.join('C:\\user', 'User', 'globalStorage', 'storage.json');
            const value = JSON.parse(files.get(storagePath)!.toString('utf8')); change(value); files.set(storagePath, Buffer.from(JSON.stringify(value)));
        },
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
        assert.deepStrictEqual(result.application.nativeWindows, [{ id: 1, rendererProcessPid: 28920 }]);
        assert.deepStrictEqual(result.windowIdentity, {
            source: 'extension_log_uri', status: 'verified', sourceVersion: '1.142.0', sourceCommit: COMMIT,
            nativeWindowId: 1, rendererProcessPid: 28920, observedNativeWindowIds: [1], failureCode: null
        });
        assert.ok(result.blockers.includes('automatic_restart_workspace_present'));
        assert.ok(result.blockers.includes('open_document_present'));
        assert.ok(result.blockers.includes('terminal_present'));
        const serialized = JSON.stringify(result);
        for (const secret of ['private-project-name', 'private-workspace-identity', 'secret-notebook', 'TOP SECRET CONTENT', 'ANOTHER SECRET', 'private-tab-title', 'PRIVATE TAB INPUT', 'private-shell', 'secret-command', 'private-debug-name', '--crash-reporter-id', '20261021T010203']) {
            assert.ok(!serialized.includes(secret), `preflight leaked ${secret}`);
        }
        assert.deepStrictEqual(state.calls, []);
        assert.deepStrictEqual(state.workspaceUpdates, []);
        assert.strictEqual(probeCalls, 0, 'read-only inspection must not run the marker-binding native probe');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('window identity uses the exact reviewed logUri and unique current native status row', async () => {
    const f = await fixture({ restart: true });
    try {
        f.context.logUri = fileUri(path.join(f.temp, 'AppData', 'Roaming', 'Code', 'logs', '20261021T020304', 'window2', 'exthost', f.context.extension.id));
        f.deps.runCodeStatus = async () => status(`--crash-reporter-id ${CRASH}`, PID, 2);
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.windowIdentity.status, 'verified');
        assert.strictEqual(result.windowIdentity.nativeWindowId, 2);
        assert.strictEqual(result.windowIdentity.rendererProcessPid, 28921);
        assert.deepStrictEqual(result.windowIdentity.observedNativeWindowIds, [1, 2]);
        assert.ok(!JSON.stringify(result).includes('20261021T020304'));
        assert.deepStrictEqual(state.calls, []);
        assert.strictEqual(f.quitCalls, 0);

        f.context.extension.id = f.context.extension.id.toLowerCase();
        f.context.logUri = fileUri(path.join(f.temp, 'AppData', 'Roaming', 'Code', 'logs', '20261021T020305', 'window2', 'exthost', f.context.extension.id));
        const normalized = parsed(await manager.inspect());
        assert.strictEqual(normalized.windowIdentity.status, 'verified');
        assert.strictEqual(normalized.windowIdentity.nativeWindowId, 2);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('unsupported startup arguments preserve identity evidence while remaining a preparation blocker', async () => {
    const f = await fixture({ restart: true, native: true });
    try {
        f.deps.runCodeStatus = async () => status('--remote-debugging-port=59267 C:\\private-workspace');
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.application.status, 'unsupported');
        assert.strictEqual(result.application.startupArguments, 'unsupported');
        assert.strictEqual(result.application.failureCode, 'startup_arguments_unsupported');
        assert.strictEqual(result.windowIdentity.status, 'verified');
        assert.strictEqual(result.windowIdentity.nativeWindowId, 1);
        assert.ok(result.blockers.includes('startup_arguments_unsupported'));
        assert.ok(!JSON.stringify(result).includes('private-workspace'));
        assert.strictEqual(f.quitCalls, 0);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('window identity fails closed for malformed, ambiguous and unsupported source evidence', async () => {
    const invalidLogUris: Array<[string, (valid: any, appData: string, extensionId: string) => any]> = [
        ['authority', (valid) => rawUri(`file://remote-host${valid.path}`)],
        ['outside root', (_valid, appData, extensionId) => fileUri(path.join(appData, 'Code', 'other-logs', 'session', 'window1', 'exthost', extensionId))],
        ['window zero', (_valid, appData, extensionId) => fileUri(path.join(appData, 'Code', 'logs', 'session', 'window0', 'exthost', extensionId))],
        ['wrong exact suffix', (_valid, appData) => fileUri(path.join(appData, 'Code', 'logs', 'session', 'window1', 'exthost', 'happypig375.vscode-jupyter-mcp-server'))],
        ['extra segment', (_valid, appData, extensionId) => fileUri(path.join(appData, 'Code', 'logs', 'session', 'extra', 'window1', 'exthost', extensionId))],
        ['non-file scheme', (valid) => rawUri(`vscode-remote:${valid.path}`)],
        ['query', (valid) => rawUri(`${valid.toString()}?private=1`)],
        ['fragment', (valid) => rawUri(`${valid.toString()}#private`)],
        ['UNC path', (_valid, _appData, extensionId) => rawUri(`file:////server/share/logs/session/window1/exthost/${extensionId}`)],
        ['dot segment', (valid) => rawUri(valid.toString().replace('/session/window1/', '/session/../session/window1/'))]
    ];
    for (const [name, alter] of invalidLogUris) {
        const f = await fixture({ restart: true });
        try {
            const appData = f.deps.env.APPDATA!;
            const valid = fileUri(path.join(appData, 'Code', 'logs', 'session', 'window1', 'exthost', f.context.extension.id));
            f.context.logUri = valid;
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            const positive = parsed(await manager.inspect());
            assert.strictEqual(positive.windowIdentity.status, 'verified', `${name} must start from an exact-root positive control`);
            assert.strictEqual(positive.windowIdentity.nativeWindowId, 1);

            f.context.logUri = alter(valid, appData, f.context.extension.id);
            const result = parsed(await manager.inspect());
            assert.strictEqual(result.windowIdentity.status, 'unavailable', name);
            assert.strictEqual(result.windowIdentity.failureCode, 'window_identity_log_uri_invalid', name);
            assert.strictEqual(result.windowIdentity.nativeWindowId, null);
            assert.strictEqual(result.windowIdentity.rendererProcessPid, null);
            assert.strictEqual(f.quitCalls, 0);
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }

    const wrongCommit = await fixture({ restart: true });
    try {
        wrongCommit.deps.runCodeStatus = async () => status().replace(COMMIT, 'a'.repeat(40));
        const manager = createColabEnvironmentForTest(wrongCommit.context, wrongCommit.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.windowIdentity.status, 'unsupported');
        assert.strictEqual(result.windowIdentity.failureCode, 'window_identity_commit_unsupported');
    } finally { wrongCommit.dispose(); await fs.rm(wrongCommit.temp, { recursive: true, force: true }); }
});

test('window identity rejects duplicate native rows and a derived ID absent from current status', async () => {
    const duplicate = await fixture({ restart: true });
    try {
        duplicate.deps.runCodeStatus = async () => status() + '    1     190   28921  window [1] (Second)\n';
        const manager = createColabEnvironmentForTest(duplicate.context, duplicate.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.windowIdentity.status, 'mismatch');
        assert.strictEqual(result.windowIdentity.failureCode, 'window_identity_native_rows_invalid');
    } finally { duplicate.dispose(); await fs.rm(duplicate.temp, { recursive: true, force: true }); }

    const absent = await fixture({ restart: true });
    try {
        absent.context.logUri = fileUri(path.join(absent.temp, 'AppData', 'Roaming', 'Code', 'logs', 'session', 'window3', 'exthost', absent.context.extension.id));
        absent.deps.runCodeStatus = async () => status(`--crash-reporter-id ${CRASH}`, PID, 2);
        const manager = createColabEnvironmentForTest(absent.context, absent.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.windowIdentity.status, 'mismatch');
        assert.strictEqual(result.windowIdentity.failureCode, 'window_identity_status_row_mismatch');
    } finally { absent.dispose(); await fs.rm(absent.temp, { recursive: true, force: true }); }
});

test('window identity rejects duplicate renderer PIDs with distinct IDs and more than 64 local rows', async () => {
    const duplicatePid = await fixture({ restart: true });
    try {
        duplicatePid.deps.runCodeStatus = async () => status() + '    1     190   28920  window [2] (Second)\n';
        const manager = createColabEnvironmentForTest(duplicatePid.context, duplicatePid.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.application.actualWindowCount, 2);
        assert.deepStrictEqual(result.application.nativeWindows.map((row: any) => row.id), [1, 2]);
        assert.strictEqual(result.windowIdentity.status, 'mismatch');
        assert.strictEqual(result.windowIdentity.failureCode, 'window_identity_native_rows_invalid');
    } finally { duplicatePid.dispose(); await fs.rm(duplicatePid.temp, { recursive: true, force: true }); }

    const oversized = await fixture({ restart: true });
    try {
        oversized.deps.runCodeStatus = async () => status(`--crash-reporter-id ${CRASH}`, PID, 65);
        const manager = createColabEnvironmentForTest(oversized.context, oversized.deps); await manager.initialize();
        const result = parsed(await manager.inspect());
        assert.strictEqual(result.application.actualWindowCount, 65);
        assert.deepStrictEqual(result.application.nativeWindows, []);
        assert.strictEqual(result.windowIdentity.status, 'mismatch');
        assert.strictEqual(result.windowIdentity.failureCode, 'window_identity_native_rows_invalid');
        assert.deepStrictEqual(result.windowIdentity.observedNativeWindowIds, []);
    } finally { oversized.dispose(); await fs.rm(oversized.temp, { recursive: true, force: true }); }
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
        const context = { globalStorageUri: fileUri(storageFile), logUri: fileUri(path.join(temp, 'logs', 'window1', 'exthost', 'hadrian.jupyter-mcp')), extensionPath: temp, extension: { id: 'hadrian.jupyter-mcp' }, subscriptions: [] } as any;
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

test('restored-workspace mode snapshots configured file and untitled Workspaces without conversion', async () => {
    for (const kind of ['file', 'untitled'] as const) {
        const f = await fixture({ restart: true });
        try {
            await configuredWorkspace(f, kind);
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
            assert.strictEqual(prepared.status, 'restart_requested', kind);
            assert.strictEqual(prepared.restartMode, 'restore-clean-workspace');
            assert.strictEqual(prepared.restartRequired, true);
            assert.strictEqual(prepared.environmentReady, false);
            assert.strictEqual(await f.runScheduledQuit(), true);
            assert.strictEqual(f.quitCalls, 1);
            assert.deepStrictEqual(state.workspaceUpdates, [], 'restored mode never converts a workspace');
            assert.deepStrictEqual(state.calls, [], 'restored mode does not close, save or open resources');
            const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'colab-environment-receipts', `${prepared.preparationId}.json`), 'utf8'));
            assert.strictEqual(receipt.folderPreparation, undefined);
            assert.strictEqual(receipt.workspacePath, undefined);
            assert.strictEqual(receipt.restorationSnapshot.workspace.kind, kind);
            assert.deepStrictEqual(receipt.restorationSnapshot.workspace.roots, [{ uri: state.folders[0].uri.toString(), name: 'Research' }]);
            assert.strictEqual(receipt.restorationSnapshot.tabGroups[0].length, 2);
            assert.deepStrictEqual(receipt.restorationSnapshot.savedState.backupRegistry, { workspaces: 1, folders: 0, emptyWindows: 0 });
            assert.ok(Number.isSafeInteger(receipt.quitDispatchApprovedAt));
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('restored-workspace folderUri may only identify an existing root and never changes workspace shape', async () => {
    const matched = await fixture({ restart: true });
    try {
        const configured = await configuredWorkspace(matched);
        const manager = createColabEnvironmentForTest(matched.context, matched.deps); await manager.initialize();
        const prepared = parsed(await manager.prepare(configured.root.toString(), 'restore-clean-workspace'));
        assert.strictEqual(prepared.status, 'restart_requested');
        assert.strictEqual(await matched.runScheduledQuit(), true);
        assert.deepStrictEqual(state.workspaceUpdates, []);
        assert.deepStrictEqual(state.folders, [{ name: 'Research', uri: configured.root }]);
    } finally { matched.dispose(); await fs.rm(matched.temp, { recursive: true, force: true }); }

    const mismatched = await fixture({ restart: true });
    try {
        await configuredWorkspace(mismatched);
        const other = path.join(mismatched.temp, 'other-project'); await fs.mkdir(other);
        const manager = createColabEnvironmentForTest(mismatched.context, mismatched.deps); await manager.initialize();
        await rejectsCode(() => manager.prepare(fileUri(other).toString(), 'restore-clean-workspace'), 'workspace_mismatch');
        assert.strictEqual(mismatched.quitCalls, 0);
        assert.deepStrictEqual(state.workspaceUpdates, []);
    } finally { mismatched.dispose(); await fs.rm(mismatched.temp, { recursive: true, force: true }); }
});

test('restored-workspace matches only the exact configured URI for an aliased root', async () => {
    const matched = await fixture({ restart: true });
    try {
        const configured = await configuredWorkspace(matched);
        const aliasPath = path.join(matched.temp, 'project-alias');
        await fs.symlink(configured.root.fsPath, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
        const aliasUri = fileUri(aliasPath);
        const canonicalUri = fileUri(await fs.realpath(aliasPath));
        assert.notStrictEqual(aliasUri.toString(), canonicalUri.toString(), 'the fixture must exercise a real URI alias');
        state.folders = [{ name: 'Research', uri: aliasUri }];

        const manager = createColabEnvironmentForTest(matched.context, matched.deps); await manager.initialize();
        const prepared = parsed(await manager.prepare(aliasUri.toString(), 'restore-clean-workspace'));
        assert.strictEqual(prepared.status, 'restart_requested');
        const receipt = JSON.parse(await fs.readFile(path.join(matched.root, 'colab-environment-receipts', `${prepared.preparationId}.json`), 'utf8'));
        assert.deepStrictEqual(receipt.restorationSnapshot.workspace.roots, [{ uri: aliasUri.toString(), name: 'Research' }]);
        assert.strictEqual(await matched.runScheduledQuit(), true);
        assert.deepStrictEqual(state.workspaceUpdates, []);
    } finally { matched.dispose(); await fs.rm(matched.temp, { recursive: true, force: true }); }

    const unlisted = await fixture({ restart: true });
    try {
        const configured = await configuredWorkspace(unlisted);
        const aliasPath = path.join(unlisted.temp, 'project-alias');
        await fs.symlink(configured.root.fsPath, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
        const aliasUri = fileUri(aliasPath);
        const canonicalUri = fileUri(await fs.realpath(aliasPath));
        assert.notStrictEqual(aliasUri.toString(), canonicalUri.toString(), 'the negative fixture must identify the same directory differently');
        state.folders = [{ name: 'Research', uri: aliasUri }];

        const manager = createColabEnvironmentForTest(unlisted.context, unlisted.deps); await manager.initialize();
        await rejectsCode(() => manager.prepare(canonicalUri.toString(), 'restore-clean-workspace'), 'workspace_mismatch');
        assert.strictEqual(unlisted.quitCalls, 0);
        assert.strictEqual(operationGateStateForTest().restartPending, false);
        await assert.rejects(() => fs.stat(path.join(unlisted.root, 'colab-environment-active.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
        assert.deepStrictEqual(await fs.readdir(path.join(unlisted.root, 'colab-environment-receipts')), []);
        assert.deepStrictEqual(state.workspaceUpdates, []);
    } finally { unlisted.dispose(); await fs.rm(unlisted.temp, { recursive: true, force: true }); }
});

test('restored tab snapshot preserves multiplicity and group membership while ignoring within-group order', async () => {
    const reordered = await fixture({ restart: true });
    try {
        await configuredWorkspace(reordered);
        const manager = createColabEnvironmentForTest(reordered.context, reordered.deps); await manager.initialize();
        await manager.prepare(undefined, 'restore-clean-workspace');
        state.tabGroups[0].tabs.reverse();
        assert.strictEqual(await reordered.runScheduledQuit(), true, 'within-group tab ordering is intentionally not durable');
    } finally { reordered.dispose(); await fs.rm(reordered.temp, { recursive: true, force: true }); }

    for (const change of ['multiplicity', 'group'] as const) {
        const f = await fixture({ restart: true });
        try {
            const configured = await configuredWorkspace(f);
            const duplicate = { label: 'notes duplicate', input: new TabInputText(configured.text), isDirty: false };
            state.tabGroups = [{ tabs: [state.tabGroups[0].tabs[0], duplicate] }, { tabs: [state.tabGroups[0].tabs[1]] }];
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            await manager.prepare(undefined, 'restore-clean-workspace');
            if (change === 'multiplicity') state.tabGroups[0].tabs.pop();
            else state.tabGroups = [{ tabs: [state.tabGroups[0].tabs[0]] }, { tabs: [duplicate, state.tabGroups[1].tabs[0]] }];
            assert.strictEqual(await f.runScheduledQuit(), false, change);
            assert.strictEqual(f.quitCalls, 0, change);
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('working native binding returns restored preparation without restart or disconnected-kernel checks', async () => {
    const f = await fixture({ restart: true, native: true, spacedPaths: true });
    try {
        await configuredWorkspace(f);
        const userDataDir = path.join(f.deps.env.APPDATA!, 'Code');
        const extensionsDir = path.join(f.deps.env.USERPROFILE!, '.vscode', 'extensions');
        let statusCalls = 0, savedStateCalls = 0, markerCalls = 0;
        f.deps.probeNative = async () => { markerCalls++; return true; };
        f.deps.runCodeStatus = async () => {
            statusCalls++;
            return status(`--user-data-dir ${userDataDir} --extensions-dir ${extensionsDir} --remote-debugging-port=59267`);
        };
        f.deps.inspectSavedState = async () => { savedStateCalls++; throw new Error('restart-only saved state must not be inspected'); };
        f.deps.assertNoActiveKernels = async () => { throw Object.assign(new Error('active'), { code: 'active_kernel_present' }); };
        f.deps.hasBackgroundWork = () => true;
        state.documents = [{ uri: rawUri('untitled:native-dirty-text'), isDirty: true, isUntitled: true, version: 17 }];
        state.notebooks = [{ uri: rawUri('untitled:native-dirty-notebook'), isDirty: true, isUntitled: true, version: 23 }];
        state.tabGroups = [{ tabs: [{ label: 'dirty webview', input: new TabInputWebview('native-ready'), isDirty: true }] }];
        state.terminals = [{}]; state.activeDebugSession = { id: 'native-ready-debug' };
        state.restoreWindows = 'none'; state.confirmBeforeClose = 'always';
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const ready = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        assert.strictEqual(ready.status, 'environment_ready');
        assert.strictEqual(ready.environmentReady, true);
        assert.strictEqual(ready.restartRequired, false);
        assert.strictEqual(operationGateStateForTest().restartPending, false, 'native-ready return releases the provisional prepare exclusion');
        assert.strictEqual(f.quitCalls, 0);
        assert.strictEqual(statusCalls, 2, 'native-ready mode sandwiches a fresh marker proof between app/window identity checks');
        assert.strictEqual(markerCalls, 2);
        assert.strictEqual(savedStateCalls, 0, 'native-ready mode does not inspect restart-only saved state');
        const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'colab-environment-receipts', `${ready.preparationId}.json`), 'utf8'));
        assert.strictEqual(receipt.restorationSnapshot.savedState, undefined);
        assert.strictEqual(receipt.restorationSnapshot.tabGroups, undefined);
        assert.strictEqual(receipt.restorationSnapshot.documents, undefined);
        state.trusted = false;
        const untrusted = parsed(await manager.get(ready.preparationId));
        assert.strictEqual(untrusted.status, 'workspace_untrusted');
        assert.strictEqual(untrusted.environmentReady, false);
        state.trusted = true;
        state.documents = [{ uri: rawUri('untitled:after-ready'), isDirty: true, isUntitled: true, version: 1 }];
        state.notebooks = [];
        state.tabGroups = [{ tabs: [{ label: 'webview', input: new TabInputWebview('after-ready'), isDirty: false }] }];
        state.terminals = [{}]; state.activeDebugSession = { id: 'after-ready' };
        const polled = parsed(await manager.get(ready.preparationId));
        assert.strictEqual(polled.environmentReady, true, 'ready polling checks only Workspace identity, trust and a fresh native bind');
        assert.strictEqual(polled.restartRequired, false);
        assert.strictEqual(statusCalls, 2, 'ready polling does not repeat restart-only process checks');
        assert.strictEqual(markerCalls, 3, 'the trusted ready poll adds only one fresh marker proof');
        assert.strictEqual(savedStateCalls, 0);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('native-ready preparation revalidates the exact Workspace and ordered roots around marker probing', async () => {
    const f = await fixture({ restart: true, native: true });
    try {
        await configuredWorkspace(f);
        let statusCalls = 0;
        f.deps.runCodeStatus = async () => { statusCalls++; return status(); };
        f.deps.probeNative = async () => { state.folders[0].name = 'changed-during-marker-probe'; return true; };
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        await rejectsCode(() => manager.prepare(undefined, 'restore-clean-workspace'), 'restoration_snapshot_changed');
        assert.strictEqual(statusCalls, 0, 'changed Workspace identity stops before process corroboration');
        assert.strictEqual(operationGateStateForTest().restartPending, false);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('restart exclusion counts in-flight mutations and admits only the explicit read-only allowlist', async () => {
    const finishMutation = beginLocalOperation('create_notebook', {});
    assert.throws(() => acquireRestartExclusion(), (error: any) => error.code === 'mutation_in_progress');
    finishMutation();
    const exclusion = acquireRestartExclusion();
    assert.strictEqual(operationGateStateForTest().restartPending, true);
    assert.throws(() => beginLocalOperation('close_colab_terminals', {}), (error: any) => error.code === 'restart_in_progress');
    const finishRead = beginLocalOperation('get_execution', {}); finishRead();
    exclusion.release();
    assert.deepStrictEqual(operationGateStateForTest(), { activeMutations: 0, restartPending: false });
});

test('restored-workspace mode fails closed for policy, work, kernel and saved-state blockers', async () => {
    const cases: Array<[string, (f: Fixture) => Promise<void> | void, string]> = [
        ['terminal', () => { state.terminals = [{}]; }, 'terminal_present'],
        ['dirty document', () => { state.documents[0].isDirty = true; }, 'open_document_unsupported'],
        ['restore policy', () => { state.restoreWindows = 'one'; }, 'restore_policy_unsupported'],
        ['unsupported tab', () => { state.tabGroups[0].tabs[0].input = new TabInputWebview('invented'); }, 'tab_input_unsupported'],
        ['background work', (f) => { f.deps.hasBackgroundWork = () => true; }, 'background_work_present'],
        ['active kernel', (f) => { f.deps.assertNoActiveKernels = async () => { throw Object.assign(new Error('active'), { code: 'active_kernel_present' }); }; }, 'active_kernel_present'],
        ['unknown kernel', (f) => { f.deps.assertNoActiveKernels = async () => { throw Object.assign(new Error('unknown'), { code: 'kernel_observation_unavailable' }); }; }, 'kernel_observation_unavailable'],
        ['extra native window', (f) => { f.deps.runCodeStatus = async () => status('', PID, 2); }, 'application_identity_unverified'],
        ['other untitled Workspace', async (f) => { await fs.mkdir(path.join(f.deps.env.APPDATA!, 'Code', 'Workspaces', 'other')); }, 'other_untitled_workspace_present'],
        ['empty-window backup', async (f) => { await fs.writeFile(path.join(f.deps.env.APPDATA!, 'Code', 'User', 'globalStorage', 'storage.json'), JSON.stringify({ backupWorkspaces: { workspaces: [], folders: [], emptyWindows: [{ backupFolder: 'empty' }] } })); }, 'empty_window_backup_present']
    ];
    for (const [name, change, code] of cases) {
        const f = await fixture({ restart: true });
        try {
            await configuredWorkspace(f); await change(f);
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            await rejectsCode(() => manager.prepare(undefined, 'restore-clean-workspace'), code);
            assert.strictEqual(f.quitCalls, 0, name);
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('restored-workspace receipt disarms when resources, saved metadata or tracked work change before quit', async () => {
    const changes: Array<[string, (f: Fixture) => Promise<void> | void]> = [
        ['root', () => { state.folders[0].name = 'Changed'; }],
        ['tab', () => { state.tabGroups[0].tabs.pop(); }],
        ['terminal', () => { state.terminals = [{}]; }],
        ['dirty', () => { state.notebooks[0].isDirty = true; }],
        ['background', (f) => { f.deps.hasBackgroundWork = () => true; }],
        ['saved-count', async (f) => {
            await fs.writeFile(path.join(f.deps.env.APPDATA!, 'Code', 'User', 'globalStorage', 'storage.json'), JSON.stringify({
                backupWorkspaces: { workspaces: [], folders: [], emptyWindows: [] }
            }));
        }]
    ];
    for (const [name, change] of changes) {
        const f = await fixture({ restart: true });
        try {
            await configuredWorkspace(f);
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
            await change(f);
            assert.strictEqual(await f.runScheduledQuit(), false, name);
            assert.strictEqual(f.quitCalls, 0, name);
            const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'colab-environment-receipts', `${prepared.preparationId}.json`), 'utf8'));
            assert.strictEqual(receipt.status, 'failed', name);
            assert.strictEqual(receipt.failure, 'quit_preflight_changed', name);
            assert.strictEqual(operationGateStateForTest().restartPending, false, name);
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('restored-workspace final synchronous check catches GUI mutation during the last await', async () => {
    const f = await fixture({ restart: true });
    try {
        await configuredWorkspace(f);
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        const originalInspect = f.deps.inspectProcess;
        let mutateOnObservation = true;
        f.deps.inspectProcess = async pid => {
            const value = await originalInspect(pid);
            if (mutateOnObservation) { mutateOnObservation = false; state.terminals = [{}]; }
            return value;
        };
        assert.strictEqual(await f.runScheduledQuit(), false);
        assert.strictEqual(f.quitCalls, 0);
        const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'colab-environment-receipts', `${prepared.preparationId}.json`), 'utf8'));
        assert.strictEqual(receipt.status, 'failed');
        assert.strictEqual(receipt.failure, 'quit_preflight_changed');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('failed final disarm keeps its owning exclusion across unrelated terminal and expired receipt polls', async () => {
    const f = await fixture({ restart: true, native: true });
    try {
        await configuredWorkspace(f);
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const oldReady = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        const receiptRoot = path.join(f.root, 'colab-environment-receipts');
        const oldReadyPath = path.join(receiptRoot, `${oldReady.preparationId}.json`);
        const oldReadyReceipt = JSON.parse(await fs.readFile(oldReadyPath, 'utf8'));
        const oldFailedReceipt = {
            ...oldReadyReceipt, preparationId: crypto.randomUUID(), nonce: crypto.randomUUID(),
            status: 'failed', failure: 'older_failure'
        };
        await fs.writeFile(path.join(receiptRoot, `${oldFailedReceipt.preparationId}.json`), JSON.stringify(oldFailedReceipt));

        state.configuredPort = 0;
        f.deps.probeNative = async () => false;
        const pending = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        const pendingPath = path.join(receiptRoot, `${pending.preparationId}.json`);
        const pendingReceipt = JSON.parse(await fs.readFile(pendingPath, 'utf8'));
        const expiredCreatedAt = f.deps.now() - 120_001;
        const oldExpiredReceipt = {
            ...pendingReceipt, preparationId: crypto.randomUUID(), nonce: crypto.randomUUID(), helperToken: crypto.randomUUID(),
            status: 'restart_requested', createdAt: expiredCreatedAt, deadline: expiredCreatedAt + 120_000,
            helperArmedAt: expiredCreatedAt + 1, quitDispatchApprovedAt: undefined
        };
        await fs.writeFile(path.join(receiptRoot, `${oldExpiredReceipt.preparationId}.json`), JSON.stringify(oldExpiredReceipt));

        f.deps.receiptIoHooks = {
            afterWrite: receipt => {
                if (receipt.preparationId === pending.preparationId && receipt.status === 'restart_requested' &&
                    Number.isSafeInteger(receipt.quitDispatchApprovedAt)) state.terminals = [{}];
            },
            beforeWrite: receipt => {
                if (receipt.preparationId === pending.preparationId && receipt.status === 'failed') {
                    throw new Error('invented final-disarm write failure');
                }
            }
        };
        assert.strictEqual(await f.runScheduledQuit(), false);
        assert.strictEqual(operationGateStateForTest().restartPending, true);
        assert.throws(() => beginLocalOperation('create_notebook', {}), (error: any) => error.code === 'restart_in_progress');
        const uncertain = parsed(await manager.get(pending.preparationId));
        assert.strictEqual(uncertain.status, 'restart_disarm_uncertain');
        assert.strictEqual(uncertain.failure, 'restart_disarm_uncertain');

        const oldReadyPoll = parsed(await manager.get(oldReady.preparationId));
        assert.strictEqual(oldReadyPoll.status, 'native_binding_unavailable');
        const oldFailedPoll = parsed(await manager.get(oldFailedReceipt.preparationId));
        assert.strictEqual(oldFailedPoll.status, 'failed');
        await rejectsCode(() => manager.get(oldExpiredReceipt.preparationId), 'restart_in_progress');
        assert.strictEqual(operationGateStateForTest().restartPending, true, 'unrelated receipts cannot release or replace the owner block');
        assert.throws(() => beginLocalOperation('create_notebook', {}), (error: any) => error.code === 'restart_in_progress');

        f.deps.receiptIoHooks = undefined;
        const durablyFailed = JSON.parse(await fs.readFile(pendingPath, 'utf8'));
        durablyFailed.status = 'failed'; durablyFailed.failure = 'invented_cleanup_proof';
        await fs.writeFile(pendingPath, JSON.stringify(durablyFailed));
        assert.strictEqual(parsed(await manager.get(pending.preparationId)).status, 'failed');
        assert.strictEqual(operationGateStateForTest().restartPending, false);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('failed receipt read-back retains the uncertain owner block until its durable terminal receipt is polled', async () => {
    const f = await fixture({ restart: true });
    try {
        await configuredWorkspace(f);
        const originalArm = f.deps.armHelper;
        f.deps.armHelper = async (...args) => { await originalArm(...args); state.tabGroups[0].tabs.pop(); };
        let failNextRead = false;
        f.deps.receiptIoHooks = {
            afterWrite: receipt => { if (receipt.status === 'failed') failNextRead = true; },
            beforeRead: () => {
                if (!failNextRead) return;
                failNextRead = false;
                throw new Error('invented durable read-back failure');
            }
        };
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        await rejectsCode(() => manager.prepare(undefined, 'restore-clean-workspace'), 'restart_disarm_uncertain');
        assert.strictEqual(operationGateStateForTest().restartPending, true);
        assert.throws(() => beginLocalOperation('save_notebooks', {}), (error: any) => error.code === 'restart_in_progress');

        const files = await fs.readdir(path.join(f.root, 'colab-environment-receipts'));
        assert.strictEqual(files.length, 1);
        const preparationId = files[0].replace(/\.json$/, '');
        const failed = parsed(await manager.get(preparationId));
        assert.strictEqual(failed.status, 'failed');
        assert.strictEqual(operationGateStateForTest().restartPending, false, 'the owning durable terminal proof releases its own block');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('initial acquisition binds an expired active receipt before uncertain terminalization', async () => {
    const f = await fixture({ restart: true });
    try {
        await configuredWorkspace(f);
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const pending = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        const receiptPath = path.join(f.root, 'colab-environment-receipts', `${pending.preparationId}.json`);
        const activePath = path.join(f.root, 'colab-environment-active.json');
        const original = JSON.parse(await fs.readFile(receiptPath, 'utf8'));

        await fs.writeFile(receiptPath, JSON.stringify({ ...original, status: 'failed', failure: 'invented_seed_release' }));
        assert.strictEqual(parsed(await manager.get(pending.preparationId)).status, 'failed');
        assert.strictEqual(operationGateStateForTest().restartPending, false);

        const createdAt = f.deps.now() - 120_001;
        const expired = {
            ...original, status: 'restart_requested', failure: undefined, createdAt, deadline: createdAt + 120_000,
            helperArmedAt: createdAt + 1, quitDispatchApprovedAt: undefined
        };
        await fs.writeFile(receiptPath, JSON.stringify(expired));
        await fs.writeFile(activePath, JSON.stringify({ schema: 1, preparationId: pending.preparationId }));
        let failNextRead = false;
        f.deps.receiptIoHooks = {
            afterWrite: receipt => {
                if (receipt.preparationId === pending.preparationId && receipt.status === 'failed') failNextRead = true;
            },
            beforeRead: preparationId => {
                if (preparationId !== pending.preparationId || !failNextRead) return;
                failNextRead = false;
                throw new Error('invented expired-receipt read-back failure');
            }
        };

        await rejectsCode(() => manager.prepare(undefined, 'restore-clean-workspace'), 'restart_disarm_uncertain');
        assert.strictEqual(operationGateStateForTest().restartPending, true, 'the expired receipt owns the retained uncertain exclusion');
        assert.throws(() => beginLocalOperation('create_notebook', {}), (error: any) => error.code === 'restart_in_progress');

        f.deps.receiptIoHooks = undefined;
        assert.strictEqual(parsed(await manager.get(pending.preparationId)).status, 'failed');
        assert.strictEqual(operationGateStateForTest().restartPending, false, 'only the same durable terminal receipt releases the transferred block');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('prepare request holds one exclusion across successful adopted-expiry cleanup and receipt creation', async () => {
    const f = await fixture({ restart: true });
    try {
        await configuredWorkspace(f);
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const seed = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        const receiptRoot = path.join(f.root, 'colab-environment-receipts');
        const activePath = path.join(f.root, 'colab-environment-active.json');
        const seedPath = path.join(receiptRoot, `${seed.preparationId}.json`);
        const template = JSON.parse(await fs.readFile(seedPath, 'utf8'));

        await fs.writeFile(seedPath, JSON.stringify({ ...template, status: 'failed', failure: 'invented_seed_release' }));
        assert.strictEqual(parsed(await manager.get(seed.preparationId)).status, 'failed');
        assert.strictEqual(operationGateStateForTest().restartPending, false);

        const now = f.deps.now();
        const expiredCreatedAt = now - 120_001;
        const adoptedExpired = {
            ...template, status: 'restart_requested', failure: undefined,
            createdAt: expiredCreatedAt, deadline: expiredCreatedAt + 120_000, helperArmedAt: expiredCreatedAt + 1
        };
        const unrelatedPending = {
            ...template, preparationId: crypto.randomUUID(), nonce: crypto.randomUUID(), helperToken: crypto.randomUUID(),
            status: 'restart_requested', failure: undefined, createdAt: now, deadline: now + 120_000, helperArmedAt: now + 1
        };
        const unrelatedExpired = {
            ...unrelatedPending, preparationId: crypto.randomUUID(), nonce: crypto.randomUUID(), helperToken: crypto.randomUUID(),
            createdAt: expiredCreatedAt, deadline: expiredCreatedAt + 120_000, helperArmedAt: expiredCreatedAt + 1
        };
        await fs.writeFile(seedPath, JSON.stringify(adoptedExpired));
        await fs.writeFile(path.join(receiptRoot, `${unrelatedPending.preparationId}.json`), JSON.stringify(unrelatedPending));
        await fs.writeFile(path.join(receiptRoot, `${unrelatedExpired.preparationId}.json`), JSON.stringify(unrelatedExpired));
        await fs.writeFile(activePath, JSON.stringify({ schema: 1, preparationId: seed.preparationId }));

        const observed = new Set<string>();
        const boundaryFailures: string[] = [];
        let checkingBoundary = false;
        const assertRequestStillOwnsExclusion = async (boundary: string): Promise<void> => {
            if (checkingBoundary) return;
            checkingBoundary = true;
            try {
                observed.add(boundary);
                if (!operationGateStateForTest().restartPending) boundaryFailures.push(`${boundary}: exclusion absent before probes`);
                let admittedMutation: (() => void) | undefined;
                try {
                    admittedMutation = beginLocalOperation('create_notebook', {});
                    boundaryFailures.push(`${boundary}: mutation was admitted`);
                } catch (error) {
                    if ((error as any)?.code !== 'restart_in_progress') boundaryFailures.push(`${boundary}: mutation returned ${(error as any)?.code ?? error}`);
                } finally { admittedMutation?.(); }
                for (const candidate of [unrelatedPending, unrelatedExpired]) {
                    try {
                        await manager.get(candidate.preparationId);
                        boundaryFailures.push(`${boundary}: unrelated ${candidate.preparationId} poll was admitted`);
                    } catch (error) {
                        if ((error as any)?.code !== 'restart_in_progress') boundaryFailures.push(`${boundary}: unrelated poll returned ${(error as any)?.code ?? error}`);
                    }
                }
                if (!operationGateStateForTest().restartPending) boundaryFailures.push(`${boundary}: polls released the exclusion`);
            } finally { checkingBoundary = false; }
        };
        f.deps.restorationLifecycleHook = boundary => assertRequestStillOwnsExclusion(boundary);
        f.deps.reservePort = async () => {
            await assertRequestStillOwnsExclusion('reserve_port');
            return 59267;
        };

        const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        assert.strictEqual(prepared.status, 'restart_requested');
        assert.deepStrictEqual([...observed].sort(), ['active_released', 'new_receipt', 'reserve_port', 'terminal_proven']);
        assert.strictEqual(boundaryFailures.length, 0, boundaryFailures.join('; '));
        assert.strictEqual(operationGateStateForTest().restartPending, true, 'the returned pending receipt owns the transferred exclusion');
        assert.strictEqual(JSON.parse(await fs.readFile(path.join(receiptRoot, `${unrelatedPending.preparationId}.json`), 'utf8')).status, 'restart_requested');
        assert.strictEqual(JSON.parse(await fs.readFile(path.join(receiptRoot, `${unrelatedExpired.preparationId}.json`), 'utf8')).status, 'restart_requested');
        await rejectsCode(() => manager.get(unrelatedPending.preparationId), 'restart_in_progress');
        await rejectsCode(() => manager.get(unrelatedExpired.preparationId), 'restart_in_progress');

        f.deps.restorationLifecycleHook = undefined;
        const preparedPath = path.join(receiptRoot, `${prepared.preparationId}.json`);
        const durableOwner = JSON.parse(await fs.readFile(preparedPath, 'utf8'));
        durableOwner.status = 'failed'; durableOwner.failure = 'invented_matching_owner_recovery';
        await fs.writeFile(preparedPath, JSON.stringify(durableOwner));
        assert.strictEqual(parsed(await manager.get(prepared.preparationId)).status, 'failed');
        assert.strictEqual(operationGateStateForTest().restartPending, false, 'only the matching durable owner releases after request return');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('prepare request failure before receipt binding releases its provisional exclusion', async () => {
    const f = await fixture({ restart: true });
    try {
        await configuredWorkspace(f);
        f.deps.restorationLifecycleHook = boundary => {
            if (boundary === 'new_receipt') throw new Error('invented receipt-construction boundary failure');
        };
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        await rejectsCode(() => manager.prepare(undefined, 'restore-clean-workspace'), 'restored_workspace_preparation_failed');
        assert.strictEqual(operationGateStateForTest().restartPending, false);
        const finish = beginLocalOperation('create_notebook', {}); finish();
        await assert.rejects(() => fs.stat(path.join(f.root, 'colab-environment-active.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('restored-workspace recomputes the snapshot after helper arming and never leaves approval live on failure', async () => {
    const f = await fixture({ restart: true });
    try {
        await configuredWorkspace(f);
        const originalArm = f.deps.armHelper;
        f.deps.armHelper = async (...args) => { await originalArm(...args); state.tabGroups[0].tabs.pop(); };
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        await rejectsCode(() => manager.prepare(undefined, 'restore-clean-workspace'), 'restoration_snapshot_changed');
        assert.strictEqual(f.quitCalls, 0);
        assert.strictEqual(operationGateStateForTest().restartPending, false);
        const files = await fs.readdir(path.join(f.root, 'colab-environment-receipts'));
        const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'colab-environment-receipts', files[0]), 'utf8'));
        assert.strictEqual(receipt.status, 'failed');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('a restored failure after receipt creation but before helper dispatch releases the exclusion', async () => {
    const f = await fixture({ restart: true });
    try {
        await configuredWorkspace(f);
        const inspectSaved = f.deps.inspectSavedState;
        let savedReads = 0, armCalls = 0;
        f.deps.inspectSavedState = async (...args) => {
            const observed = await inspectSaved(...args);
            savedReads++;
            return savedReads >= 4
                ? { ...observed, backupRegistry: { ...observed.backupRegistry, workspaces: observed.backupRegistry.workspaces + 1 } }
                : observed;
        };
        let failNextRead = false;
        f.deps.receiptIoHooks = {
            afterWrite: receipt => { if (receipt.status === 'failed') failNextRead = true; },
            beforeRead: () => {
                if (!failNextRead) return;
                failNextRead = false;
                throw new Error('invented pre-helper failure read-back error');
            }
        };
        f.deps.armHelper = async () => { armCalls++; };
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        await rejectsCode(() => manager.prepare(undefined, 'restore-clean-workspace'), 'restoration_metadata_changed');
        assert.strictEqual(armCalls, 0);
        assert.strictEqual(operationGateStateForTest().restartPending, false);
        await assert.rejects(() => fs.stat(path.join(f.root, 'colab-environment-active.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
        const files = await fs.readdir(path.join(f.root, 'colab-environment-receipts'));
        const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'colab-environment-receipts', files[0]), 'utf8'));
        assert.strictEqual(receipt.status, 'failed');
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('restored-workspace startup arguments accept only an unambiguous current path', async () => {
    const allowed = await fixture({ restart: true });
    try {
        const configured = await configuredWorkspace(allowed);
        allowed.deps.runCodeStatus = async () => status(`--new-window ${configured.root.fsPath}`);
        const manager = createColabEnvironmentForTest(allowed.context, allowed.deps); await manager.initialize();
        const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        assert.strictEqual(prepared.status, 'restart_requested');
    } finally { allowed.dispose(); await fs.rm(allowed.temp, { recursive: true, force: true }); }

    for (const args of ['--unknown-flag', 'C:\\different-root']) {
        const f = await fixture({ restart: true });
        try {
            await configuredWorkspace(f); f.deps.runCodeStatus = async () => status(args);
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            await rejectsCode(() => manager.prepare(undefined, 'restore-clean-workspace'), 'startup_arguments_unsupported');
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('restored-workspace metadata reader rejects missing, malformed and oversized registry state without cleanup', async () => {
    for (const value of [undefined, '{', JSON.stringify({ backupWorkspaces: { workspaces: [], folders: [] } }), 'x'.repeat(1024 * 1024 + 1)]) {
        const f = await fixture({ restart: true });
        try {
            await configuredWorkspace(f);
            const storage = path.join(f.deps.env.APPDATA!, 'Code', 'User', 'globalStorage', 'storage.json');
            if (value === undefined) await fs.unlink(storage); else await fs.writeFile(storage, value);
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            await rejectsCode(() => manager.prepare(undefined, 'restore-clean-workspace'), 'restoration_metadata_unavailable');
            assert.strictEqual(f.quitCalls, 0);
            assert.strictEqual((await fs.readdir(path.join(f.deps.env.APPDATA!, 'Code', 'Workspaces'))).length, 0, 'metadata inspection must not clean state');
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('restored durable receipt rejects unknown modes, malformed snapshots, inconsistent identities and files at the 64 KiB bound', async () => {
    for (const mutation of ['mode', 'snapshot', 'identity', 'oversized'] as const) {
        const f = await fixture({ restart: true });
        try {
            await configuredWorkspace(f);
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
            const receiptPath = path.join(f.root, 'colab-environment-receipts', `${prepared.preparationId}.json`);
            if (mutation === 'oversized') await fs.writeFile(receiptPath, ' '.repeat(64 * 1024));
            else {
                const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
                if (mutation === 'mode') receipt.restartMode = 'unknown-mode';
                else if (mutation === 'snapshot') receipt.restorationSnapshot.tabGroups = 'invalid';
                else receipt.workspaceUri = 'file:///C:/different.code-workspace';
                await fs.writeFile(receiptPath, JSON.stringify(receipt));
            }
            await rejectsCode(() => manager.get(prepared.preparationId), 'preparation_not_found');
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('restored receipt reserves helper headroom before claiming the active slot', async () => {
    const f = await fixture({ restart: true });
    try {
        const configured = await configuredWorkspace(f);
        const maxReceiptBytes = 64 * 1024;
        const helperHeadroomBytes = 2 * 1024;
        const headroomBoundary = maxReceiptBytes - helperHeadroomBytes;
        const ids = [
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
            '00000000-0000-4000-8000-000000000003'
        ];
        const rootNames = Array.from({ length: 64 }, (_, index) => `Root ${index}`);
        const candidateFor = (rootUris: string[]) => {
            const snapshot = {
                schema: 1,
                workspace: {
                    uri: state.workspaceFile.toString(), kind: 'file',
                    roots: rootUris.map((uri, index) => ({ uri, name: rootNames[index] }))
                },
                tabGroups: [[
                    { kind: 'text', uri: configured.text.toString() },
                    { kind: 'notebook', uri: configured.notebook.toString(), notebookType: 'jupyter-notebook' }
                ]],
                documents: {
                    text: [{ uri: configured.text.toString(), version: 7 }],
                    notebooks: [{ uri: configured.notebook.toString(), version: 11 }]
                },
                savedState: {
                    untitledWorkspaces: [],
                    backupRegistry: { workspaces: 1, folders: 0, emptyWindows: 0 }
                }
            };
            return {
                schema: 1, preparationId: ids[0], nonce: ids[1], status: 'arming_restart',
                createdAt: f.deps.now(), deadline: f.deps.now() + 120_000,
                workspaceUri: state.workspaceFile.toString(),
                expectedWindowLabel: rootNames.join(', ').slice(0, 512),
                port: 59267, generatedWorkspace: false,
                restartMode: 'restore-clean-workspace', restorationSnapshot: snapshot, restartRequired: true,
                installedCommit: COMMIT, main: f.identity,
                executablePath: path.resolve(f.deps.execPath),
                userDataDir: path.resolve(f.deps.env.APPDATA!, 'Code'),
                extensionsDir: path.resolve(f.deps.env.USERPROFILE!, '.vscode', 'extensions'),
                helperToken: ids[2]
            };
        };

        // Derive the ASCII padding from the complete pre-helper candidate. The
        // fixed root URI prefixes avoid multiplying the host's temporary-path
        // length, while this calculation accounts for the remaining host paths.
        const rootPrefixes = rootNames.map((_name, index) => `file:///fixture-root-${index}-`);
        const baseBytes = Buffer.byteLength(JSON.stringify(candidateFor(rootPrefixes)));
        const paddingBytes = headroomBoundary - baseBytes;
        assert.ok(paddingBytes > 0, 'the bounded fixture must begin below the helper-headroom boundary');
        const commonPadding = Math.floor(paddingBytes / rootPrefixes.length);
        const remainder = paddingBytes % rootPrefixes.length;
        const rootUris = rootPrefixes.map((prefix, index) =>
            `${prefix}${'x'.repeat(commonPadding + (index === 0 ? remainder : 0))}`
        );
        state.folders = rootUris.map((uri, index) => ({ name: rootNames[index], uri: rawUri(uri) }));

        const candidate = candidateFor(rootUris);
        const candidateBytes = Buffer.byteLength(JSON.stringify(candidate));
        const snapshotBytes = Buffer.byteLength(JSON.stringify(candidate.restorationSnapshot));
        assert.strictEqual(candidateBytes, headroomBoundary, 'candidate must reach the exact reserved-headroom boundary');
        assert.ok(snapshotBytes < maxReceiptBytes, 'the snapshot itself must remain inside its independent 64 KiB bound');
        assert.ok(rootUris.every(uri => uri.length <= 4096), 'every constructed root URI must remain contract-valid');

        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        let uuidIndex = 0; f.deps.uuid = () => ids[uuidIndex++] ?? ids[2];
        await rejectsCode(() => manager.prepare(undefined, 'restore-clean-workspace'), 'preparation_receipt_too_large');
        assert.strictEqual(operationGateStateForTest().restartPending, false);
        await assert.rejects(() => fs.stat(path.join(f.root, 'colab-environment-active.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
        assert.deepStrictEqual(await fs.readdir(path.join(f.root, 'colab-environment-receipts')), []);
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('restored-workspace expiry and quit veto remain terminal for the original receipt', async () => {
    const veto = await fixture({ restart: true });
    try {
        await configuredWorkspace(veto);
        const manager = createColabEnvironmentForTest(veto.context, veto.deps); await manager.initialize();
        const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        await veto.runQuitWatchdog();
        const failed = parsed(await manager.get(prepared.preparationId));
        assert.strictEqual(failed.status, 'failed'); assert.strictEqual(failed.failure, 'quit_not_confirmed');
        assert.strictEqual(veto.quitCalls, 0);
    } finally { veto.dispose(); await fs.rm(veto.temp, { recursive: true, force: true }); }

    const expired = await fixture({ restart: true });
    try {
        await configuredWorkspace(expired);
        const manager = createColabEnvironmentForTest(expired.context, expired.deps); await manager.initialize();
        const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        expired.deps.now = () => 1_800_000_120_001;
        const failed = parsed(await manager.get(prepared.preparationId));
        assert.strictEqual(failed.status, 'failed'); assert.strictEqual(failed.failure, 'preparation_timeout');
        assert.strictEqual(operationGateStateForTest().restartPending, false);
        assert.strictEqual(await expired.runScheduledQuit(), false, 'an expired receipt cannot reissue the delayed quit');
        assert.strictEqual(expired.quitCalls, 0);
    } finally { expired.dispose(); await fs.rm(expired.temp, { recursive: true, force: true }); }
});

test('durably failed restored receipts release the mutation exclusion on poll and initialization', async () => {
    for (const recovery of ['poll', 'initialize'] as const) {
        const f = await fixture({ restart: true });
        try {
            await configuredWorkspace(f);
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
            const receiptPath = path.join(f.root, 'colab-environment-receipts', `${prepared.preparationId}.json`);
            const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
            receipt.status = 'failed'; receipt.failure = 'app_launch_failed';
            await fs.writeFile(receiptPath, JSON.stringify(receipt));
            if (recovery === 'poll') {
                const failed = parsed(await manager.get(prepared.preparationId));
                assert.strictEqual(failed.status, 'failed');
            } else {
                f.dispose();
                const restoredContext: ColabEnvironmentContextForTest = { ...f.context, subscriptions: [] };
                const restored = createColabEnvironmentForTest(restoredContext, f.deps); await restored.initialize();
                for (const disposable of restoredContext.subscriptions) disposable.dispose();
            }
            assert.strictEqual(operationGateStateForTest().restartPending, false, recovery);
            const finish = beginLocalOperation('create_notebook', {}); finish();
            await assert.rejects(() => fs.stat(path.join(f.root, 'colab-environment-active.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('same-main extension-host reload disarms restored-workspace receipts before or after quit approval', async () => {
    for (const approved of [false, true]) {
        const f = await fixture({ restart: true });
        try {
            await configuredWorkspace(f);
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
            if (approved) assert.strictEqual(await f.runScheduledQuit(), true);
            f.dispose();
            const reloadedContext: ColabEnvironmentContextForTest = { ...f.context, subscriptions: [] };
            const reloaded = createColabEnvironmentForTest(reloadedContext, f.deps); await reloaded.initialize();
            const failed = parsed(await reloaded.get(prepared.preparationId));
            assert.strictEqual(failed.status, 'failed', String(approved));
            assert.strictEqual(failed.failure, 'owner_reloaded', String(approved));
            for (const disposable of reloadedContext.subscriptions) disposable.dispose();
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
});

test('post-restore verification tolerates unloaded documents and pruned backup counts while preserving process and resource proof', async () => {
    const f = await fixture({ restart: true, spacedPaths: true });
    try {
        await configuredWorkspace(f);
        const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
        const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
        assert.strictEqual(await f.runScheduledQuit(), true);
        const receiptPath = path.join(f.root, 'colab-environment-receipts', `${prepared.preparationId}.json`);
        const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
        const preSpawnAt = receipt.createdAt + 1_000;
        receipt.preSpawnAt = preSpawnAt;
        receipt.launchedAt = preSpawnAt + 500;
        receipt.launchPid = 777;
        receipt.status = 'app_launched';
        await fs.writeFile(receiptPath, JSON.stringify(receipt));
        f.dispose();

        const newPid = PID + 100;
        const createdBeforeSpawnEvent = new Date(preSpawnAt + 10).toISOString();
        f.deps.env.VSCODE_PID = String(newPid);
        f.deps.now = () => preSpawnAt + 1_000;
        f.deps.inspectProcess = async pid => ({ pid, executablePath: f.identity.executablePath, creationTime: createdBeforeSpawnEvent });
        f.deps.runCodeStatus = async () => status(`--user-data-dir ${receipt.userDataDir} --extensions-dir ${receipt.extensionsDir} --remote-debugging-port=${receipt.port}`, newPid);
        f.deps.probeNative = async () => true;
        state.documents = [];
        state.notebooks = [];
        await fs.writeFile(path.join(f.deps.env.APPDATA!, 'Code', 'User', 'globalStorage', 'storage.json'), JSON.stringify({
            backupWorkspaces: { workspaces: [], folders: [], emptyWindows: [] }
        }));
        const restoredContext: ColabEnvironmentContextForTest = { ...f.context, subscriptions: [] };
        const restored = createColabEnvironmentForTest(restoredContext, f.deps); await restored.initialize();
        const ready = parsed(await restored.get(prepared.preparationId));
        assert.strictEqual(ready.status, 'environment_ready');
        assert.strictEqual(ready.environmentReady, true);
        assert.strictEqual(ready.runtimeReady, false);
        assert.notStrictEqual(receipt.launchPid, newPid, 'spawn child PID is not assumed to be the VS Code main PID');
        assert.ok(Date.parse(createdBeforeSpawnEvent) < receipt.launchedAt, 'process creation may precede the recorded spawn-event time');
        f.deps.assertNoActiveKernels = async () => { throw Object.assign(new Error('active after readiness'), { code: 'active_kernel_present' }); };
        f.deps.hasBackgroundWork = () => true;
        state.documents = [{ uri: rawUri('untitled:after-ready'), isDirty: true, isUntitled: true, version: 1 }];
        state.tabGroups = [{ tabs: [{ label: 'webview', input: new TabInputWebview('after-ready'), isDirty: false }] }];
        state.terminals = [{}]; state.activeDebugSession = { id: 'after-ready' };
        const repolled = parsed(await restored.get(prepared.preparationId));
        assert.strictEqual(repolled.environmentReady, true, 'ready receipts do not reapply pre-quit editor, terminal, kernel or saved-state gates');
        for (const disposable of restoredContext.subscriptions) disposable.dispose();
    } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('post-restore verification withholds readiness for missing resources, extra windows or violated saved-state invariants', async () => {
    for (const mismatch of ['missing-tab', 'extra-window', 'empty-backup', 'other-untitled-workspace'] as const) {
        const f = await fixture({ restart: true });
        try {
            await configuredWorkspace(f);
            const manager = createColabEnvironmentForTest(f.context, f.deps); await manager.initialize();
            const prepared = parsed(await manager.prepare(undefined, 'restore-clean-workspace'));
            assert.strictEqual(await f.runScheduledQuit(), true);
            const receiptPath = path.join(f.root, 'colab-environment-receipts', `${prepared.preparationId}.json`);
            const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
            receipt.preSpawnAt = receipt.createdAt + 1_000; receipt.launchedAt = receipt.createdAt + 1_500;
            receipt.launchPid = 777; receipt.status = 'app_launched'; await fs.writeFile(receiptPath, JSON.stringify(receipt));
            f.dispose();
            const newPid = PID + 200;
            f.deps.env.VSCODE_PID = String(newPid); f.deps.now = () => receipt.createdAt + 2_000;
            f.deps.inspectProcess = async pid => ({ pid, executablePath: f.identity.executablePath, creationTime: new Date(receipt.preSpawnAt + 10).toISOString() });
            f.deps.runCodeStatus = async () => status(`--user-data-dir ${receipt.userDataDir} --extensions-dir ${receipt.extensionsDir} --remote-debugging-port=${receipt.port}`, newPid, mismatch === 'extra-window' ? 2 : 1);
            f.deps.probeNative = async () => true;
            if (mismatch === 'missing-tab') state.tabGroups[0].tabs.pop();
            if (mismatch === 'empty-backup') {
                await fs.writeFile(path.join(f.deps.env.APPDATA!, 'Code', 'User', 'globalStorage', 'storage.json'), JSON.stringify({
                    backupWorkspaces: { workspaces: [], folders: [], emptyWindows: [{ backupFolder: 'new-empty' }] }
                }));
            }
            if (mismatch === 'other-untitled-workspace') await fs.mkdir(path.join(f.deps.env.APPDATA!, 'Code', 'Workspaces', 'other'));
            const restoredContext: ColabEnvironmentContextForTest = { ...f.context, subscriptions: [] };
            const restored = createColabEnvironmentForTest(restoredContext, f.deps); await restored.initialize();
            const pending = parsed(await restored.get(prepared.preparationId));
            assert.strictEqual(pending.environmentReady, false, mismatch);
            assert.strictEqual(pending.status, 'app_launched', mismatch);
            for (const disposable of restoredContext.subscriptions) disposable.dispose();
        } finally { f.dispose(); await fs.rm(f.temp, { recursive: true, force: true }); }
    }
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
    assert.match(HELPER_SOURCE_FOR_TEST, /if\(p\)\{[\s\S]*return setTimeout\(poll,250\)/);
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

test('restored helper revalidates metadata and launches without a positional workspace argument', async () => {
    const restored = helperHarness({ approved: true, observations: ['exited'], restored: true });
    restored.runTimer();
    assert.strictEqual(restored.launches.length, 1);
    assert.deepStrictEqual(Array.from(restored.launches[0].args), [
        '--user-data-dir', 'C:\\user', '--extensions-dir', 'C:\\extensions', '--remote-debugging-port=59267'
    ]);
    assert.ok(!restored.launches[0].args.includes('--new-window'));
    assert.ok(!restored.launches[0].args.includes('C:\\workspace'));
    restored.runTimer();
    assert.strictEqual(restored.receipt.status, 'app_launched');
    assert.ok(Number.isSafeInteger(restored.receipt.preSpawnAt));
    assert.ok(restored.receipt.launchedAt >= restored.receipt.preSpawnAt);

    const changed = helperHarness({ approved: true, observations: ['exited'], restored: true });
    changed.mutateStorage(value => { value.backupWorkspaces.folders.push({ folderUri: 'file:///C:/other' }); });
    changed.runTimer();
    assert.strictEqual(changed.receipt.status, 'failed');
    assert.strictEqual(changed.receipt.failure, 'restoration_state_changed');
    assert.strictEqual(changed.launches.length, 0);

    const tampered = helperHarness({ approved: true, observations: ['exited'], restored: true });
    tampered.mutateReceipt(value => { value.restorationSnapshot.workspace.roots[0].name = 'Changed'; });
    tampered.runTimer();
    assert.strictEqual(tampered.receipt.status, 'failed');
    assert.strictEqual(tampered.receipt.failure, 'helper_receipt_invalid');
    assert.strictEqual(tampered.launches.length, 0);

    const invalidMode = helperHarness({ approved: true, observations: ['exited'], restored: true });
    invalidMode.mutateReceipt(value => { value.restartMode = 'unknown-mode'; });
    invalidMode.runTimer();
    assert.strictEqual(invalidMode.receipt.status, 'failed');
    assert.strictEqual(invalidMode.receipt.failure, 'helper_receipt_invalid');
    assert.strictEqual(invalidMode.launches.length, 0);
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
    bounded.advance(120_001); bounded.runTimer();
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
        const createdAt = Date.now();
        const receipt = { schema: 1, preparationId: id, nonce: crypto.randomUUID(), helperToken: token, status: 'arming_restart',
            createdAt, deadline: createdAt + 5_000, workspaceUri: fileUri(temp).toString(), expectedWindowLabel: 'helper-veto', generatedWorkspace: false,
            main: { pid: process.pid, executablePath: process.execPath, creationTime: lines[1] }, executablePath: process.execPath,
            workspacePath: temp, userDataDir: temp, extensionsDir: temp, port: 59267, quitDispatchApprovedAt: createdAt };
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
