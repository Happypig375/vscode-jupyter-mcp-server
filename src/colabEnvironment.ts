import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, execFile, spawn } from 'child_process';
import * as vscode from 'vscode';
import { ColabNativeEndpointInspection, createColabNativeDriver, inspectColabNativeEndpoint } from './colabNative';
import { hasGlobalColabSetupWork } from './colabSetup';
import { hasGlobalFileTransferWork } from './kernelFiles';
import { assertNoExposedNotebookKernelsForRestart, hasGlobalNotebookExecutionWork } from './notebookOps';
import { acquireRestartExclusion, assertMutationAllowed, OperationGateError, RestartExclusion } from './operationGate';

const SCHEMA = 1;
const SUPPORTED_VERSION = '1.142.0';
const SUPPORTED_COMMIT = '6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1';
const SUPPORTED_EXTENSION_ID = 'Happypig375.vscode-jupyter-mcp-server';
const MAX_NATIVE_WINDOWS = 64;
const PREPARATION_MS = 120_000;
const HELPER_ACK_MS = 5_000;
const QUIT_DELAY_MS = 1_000;
const QUIT_CONFIRM_MS = 5_000;
const MAX_FILE_BYTES = 64 * 1024;
const RESTORED_RECEIPT_HEADROOM_BYTES = 2 * 1024;
const RECEIPTS = 'colab-environment-receipts';
const WORKSPACES = 'colab-environment-workspaces';
const ACTIVE = 'colab-environment-active.json';
const HELPER = 'colab-environment-helper.cjs';
const FOLDER_MARKER = 'jupyter-mcp-environment.json';
const MAX_RESTORE_ITEMS = 256;
const MAX_STATE_METADATA_BYTES = 1024 * 1024;
const PROCESS_TIME_PRECISION_MS = 1_000;

type RestartMode = 'restore-clean-workspace';
type RestorationTab =
    | { kind: 'text'; uri: string }
    | { kind: 'notebook'; uri: string; notebookType: string }
    | { kind: 'custom'; uri: string; viewType: string }
    | { kind: 'text-diff'; original: string; modified: string }
    | { kind: 'notebook-diff'; original: string; modified: string; notebookType: string };
interface SavedStateSnapshot {
    untitledWorkspaces: Array<{ name: string; kind: 'file' | 'directory' }>;
    backupRegistry: { workspaces: number; folders: number; emptyWindows: 0 };
}
interface RestorationWorkspaceState {
    schema: 1;
    workspace: { uri: string; kind: 'file' | 'untitled'; roots: Array<{ uri: string; name: string }> };
}
interface RestorationResourceState extends RestorationWorkspaceState {
    tabGroups: RestorationTab[][];
}
interface RestorationPublicState extends RestorationResourceState {
    documents: { text: Array<{ uri: string; version: number }>; notebooks: Array<{ uri: string; version: number }> };
}
interface RestorationSnapshot extends RestorationPublicState {
    savedState: SavedStateSnapshot;
}

type PreparationStatus = 'workspace_open_requested' | 'workspace_conversion_requested' | 'arming_restart' | 'restart_requested' | 'app_launched' | 'environment_ready' | 'failed';

export interface ColabEnvironmentReceiptForTest {
    schema: 1;
    preparationId: string;
    nonce: string;
    helperToken?: string;
    status: PreparationStatus;
    createdAt: number;
    deadline: number;
    workspaceUri: string;
    workspacePath?: string;
    expectedWindowLabel: string;
    port: number;
    generatedWorkspace: boolean;
    restartMode?: RestartMode;
    restorationSnapshot?: RestorationWorkspaceState;
    restartRequired?: boolean;
    folderPreparation?: { originalName: string; preparedName: string; requestedAt?: number; workspaceFileUri?: string };
    installedCommit?: string;
    main?: ProcessIdentity;
    executablePath?: string;
    userDataDir?: string;
    extensionsDir?: string;
    helperArmedAt?: number;
    quitDispatchApprovedAt?: number;
    preSpawnAt?: number;
    launchedAt?: number;
    launchPid?: number;
    readyAt?: number;
    failure?: string;
}
type Receipt = ColabEnvironmentReceiptForTest;

export interface ProcessIdentity {
    pid: number;
    executablePath: string;
    creationTime: string;
}

export interface ParsedCodeStatus {
    version: string;
    commit: string;
    processArgs: string[];
    processArgsLine: string;
    mainPid: number;
    windows: Array<{ id: number; pid: number; title: string }>;
}

export interface ColabEnvironmentPreflightLocal {
    schemaVersion: 1;
    observedAt: number;
    readOnly: true;
    nativeBinding: {
        source: 'setting' | 'launch_environment' | 'none' | 'invalid';
        port: number | null;
        listenerAvailable: boolean;
        workbenchPageCount: number | null;
        exactWindowBinding: 'not-established';
        correspondenceReason: 'debug-targets-do-not-expose-vscode-peer-window-ids';
    };
    windowIdentity: {
        source: 'extension_log_uri';
        status: 'verified' | 'unsupported' | 'unavailable' | 'mismatch';
        sourceVersion: string;
        sourceCommit: string;
        nativeWindowId: number | null;
        rendererProcessPid: number | null;
        observedNativeWindowIds: number[];
        failureCode: string | null;
    };
    window: {
        localHost: boolean;
        trusted: boolean;
        workspace: { kind: 'empty' | 'single-folder' | 'multi-folder' | 'workspace'; folderCount: number };
        notebooks: { total: number; fileBacked: number; untitled: number; dirty: number; visibleEditors: number; activeEditor: boolean };
        textDocuments: { total: number; fileBacked: number; untitled: number; dirty: number; blocking: number; visibleEditors: number; activeEditor: boolean };
        tabs: { total: number; dirty: number; benignWelcomeOnly: boolean };
        terminals: { total: number };
        debugging: { active: boolean };
        quitPolicy: { confirmBeforeClose: 'never' | 'unsupported'; restoreWindows: 'all' | 'folders' | 'one' | 'none' | 'preserve' | 'unresolved' | 'unsupported' };
    };
    application: {
        status: 'verified' | 'unsupported' | 'unavailable' | 'mismatch';
        version: string;
        supportedVersion: string;
        versionSupported: boolean;
        commit: string | null;
        mainProcessPid: number | null;
        mainProcessIdentity: 'verified' | 'mismatch' | 'unavailable';
        defaultInstall: 'verified' | 'unsupported';
        startupArguments: 'supported' | 'unsupported' | 'unavailable';
        actualWindowCount: number | null;
        nativeWindows: Array<{ id: number; rendererProcessPid: number }>;
        failureCode: string | null;
    };
    blockers: string[];
}

interface InstallIdentity {
    executablePath: string;
    userDataDir: string;
    extensionsDir: string;
}

export interface ColabEnvironmentContextForTest {
    globalStorageUri: vscode.Uri;
    logUri: vscode.Uri;
    extensionPath: string;
    extension: { id: string };
    subscriptions: Array<{ dispose(): unknown }>;
}

export interface ColabEnvironmentDependenciesForTest {
    now(): number;
    uuid(): string;
    platform: NodeJS.Platform;
    execPath: string;
    env: NodeJS.ProcessEnv;
    vscodeVersion: string;
    probeNative(port: number): Promise<boolean>;
    inspectNative(port: number): Promise<ColabNativeEndpointInspection>;
    runCodeStatus(executablePath: string): Promise<string>;
    inspectProcess(pid: number): Promise<ProcessIdentity | undefined>;
    reservePort(requestedPort?: number): Promise<number>;
    assertNoActiveKernels(): Promise<void>;
    hasBackgroundWork(): boolean;
    inspectSavedState(userDataDir: string, workspaceFile: vscode.Uri): Promise<SavedStateSnapshot>;
    receiptIoHooks?: {
        beforeRead?(preparationId: string): Promise<void> | void;
        beforeWrite?(receipt: Readonly<Receipt>): Promise<void> | void;
        afterWrite?(receipt: Readonly<Receipt>): Promise<void> | void;
    };
    restorationLifecycleHook?(
        boundary: 'terminal_proven' | 'active_released' | 'new_receipt',
        preparationId?: string
    ): Promise<void> | void;
    armHelper(executablePath: string, helperPath: string, receiptPath: string, receipt: Readonly<Receipt>): Promise<void>;
    requestQuit(revalidate: () => Promise<boolean>, stillAlive: () => Promise<void>): void;
}

export class ColabEnvironmentError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

let manager: ColabEnvironmentManager | undefined;

/** Initialize durable Colab desktop-environment recovery for this extension window. */
export async function initializeColabEnvironment(context: vscode.ExtensionContext): Promise<void> {
    manager = undefined;
    const candidate = new ColabEnvironmentManager(context as unknown as ColabEnvironmentContextForTest, productionDependencies());
    await candidate.initialize();
    manager = candidate;
}

/** Prepare this local VS Code window for bounded native Colab UI automation. */
export async function prepareColabEnvironment(folderUri?: string, restartMode?: RestartMode): Promise<string> {
    if (!manager) throw new ColabEnvironmentError('environment_not_initialized', 'Colab environment preparation is not initialized in this VS Code window.');
    return manager.prepare(folderUri, restartMode);
}

/** Read one durable preparation, proving this exact workspace before readiness. */
export async function getColabEnvironmentPreparation(preparationId: string): Promise<string> {
    if (!manager) throw new ColabEnvironmentError('environment_not_initialized', 'Colab environment preparation is not initialized in this VS Code window.');
    return manager.get(preparationId);
}

/** Inspect bounded local preparation state without changing editor or runtime state. */
export async function inspectColabEnvironmentPreflightLocal(): Promise<string> {
    if (!manager) throw new ColabEnvironmentError('environment_not_initialized', 'Colab environment preparation is not initialized in this VS Code window.');
    return manager.inspect();
}

export function createColabEnvironmentForTest(context: ColabEnvironmentContextForTest, dependencies: ColabEnvironmentDependenciesForTest): {
    initialize(): Promise<void>; prepare(folderUri?: string, restartMode?: RestartMode): Promise<string>; get(id: string): Promise<string>; inspect(): Promise<string>;
} {
    const instance = new ColabEnvironmentManager(context, dependencies);
    return { initialize: () => instance.initialize(), prepare: (folderUri, restartMode) => instance.prepare(folderUri, restartMode), get: id => instance.get(id), inspect: () => instance.inspect() };
}

class ColabEnvironmentManager {
    private readonly root: string;
    private readonly receiptRoot: string;
    private readonly workspaceRoot: string;
    private readonly activePath: string;
    private disposed = false;
    private workspacePreparation?: Promise<void>;
    private restoreExclusion?: { handle: RestartExclusion; preparationId?: string; prepareRequest?: symbol };
    private restoreDisarmUncertain?: string;

    constructor(private readonly context: ColabEnvironmentContextForTest, private readonly deps: ColabEnvironmentDependenciesForTest) {
        // File URI interpretation belongs to the host filesystem, independently of
        // test-injected bootstrap-platform behavior.
        this.root = resolveLocalGlobalStoragePath(context, { platform: process.platform, env: deps.env });
        this.receiptRoot = path.join(this.root, RECEIPTS);
        this.workspaceRoot = path.join(this.root, WORKSPACES);
        this.activePath = path.join(this.root, ACTIVE);
        context.subscriptions.push({ dispose: () => {
            this.disposed = true;
            // A disposed manager cannot route mutations. Preserve a genuinely
            // uncertain armed-helper block; ordinary activation turnover can be
            // reacquired from its durable in-progress receipt.
            if (!this.restoreDisarmUncertain) this.disposeRestoreExclusion();
        } });
    }

    async initialize(): Promise<void> {
        await fs.mkdir(this.receiptRoot, { recursive: true });
        await fs.mkdir(this.workspaceRoot, { recursive: true });
        const active = await this.readActive();
        if (!active) { this.releaseUnownedRestoreExclusion(); return; }
        const receipt = await this.readReceipt(active);
        if (!receipt) { await this.releaseActive(active); this.releaseUnownedRestoreExclusion(); return; }
        if (receipt.restartMode === 'restore-clean-workspace') {
            if (receipt.status === 'failed') {
                await this.releaseActive(receipt.preparationId);
                this.releaseTerminalRestoreExclusion(receipt);
                this.releaseUnownedRestoreExclusion();
                return;
            }
            if (receipt.status !== 'environment_ready') {
                this.ensureRestoreExclusion(receipt.preparationId);
                if (this.deps.now() > receipt.deadline) {
                    await this.fail(receipt, 'preparation_timeout');
                    return;
                }
            } else {
                this.releaseTerminalRestoreExclusion(receipt);
                this.releaseUnownedRestoreExclusion();
            }
        }
        if (receipt.status === 'restart_requested' && receipt.main &&
            (receipt.restartMode === 'restore-clean-workspace' || Number.isSafeInteger(receipt.quitDispatchApprovedAt))) {
            let currentPid: number | undefined;
            try { currentPid = parsePid(this.deps.env.VSCODE_PID); } catch { currentPid = undefined; }
            if (currentPid === receipt.main.pid) {
                const observed = await this.deps.inspectProcess(currentPid).catch(() => undefined);
                if (observed && sameProcess(observed, receipt.main)) {
                    await this.fail(receipt, 'owner_reloaded');
                    return;
                }
            }
        }
        if (!await this.reconcile(receipt) && receipt.restartMode !== 'restore-clean-workspace') await this.prepareWorkspace(receipt);
    }

    async inspect(): Promise<string> {
        const observedAt = this.deps.now();
        const folders = vscode.workspace.workspaceFolders ?? [];
        const workspaceKind: ColabEnvironmentPreflightLocal['window']['workspace']['kind'] = vscode.workspace.workspaceFile
            ? 'workspace' : folders.length === 0 ? 'empty' : folders.length === 1 ? 'single-folder' : 'multi-folder';
        const notebooks = [...vscode.workspace.notebookDocuments];
        const documents = [...vscode.workspace.textDocuments];
        const tabs = vscode.window.tabGroups.all.flatMap(group => [...group.tabs]);
        const confirmBeforeClose = vscode.workspace.getConfiguration('window').get<string>('confirmBeforeClose');
        const restoreWindows = classifyRestoreWindows(vscode.workspace.getConfiguration('window').get<string>('restoreWindows'));
        const configured = vscode.workspace.getConfiguration('jupyterMcp').get<number>('nativeDebugPort', 0) ?? 0;
        const environment = Number(this.deps.env.JUPYTER_MCP_NATIVE_DEBUG_PORT ?? 0);
        const selectedPort = configured !== 0 ? configured : environment;
        const nativeSource: ColabEnvironmentPreflightLocal['nativeBinding']['source'] = configured !== 0
            ? (validPort(configured) ? 'setting' : 'invalid')
            : environment !== 0 ? (validPort(environment) ? 'launch_environment' : 'invalid') : 'none';
        const native = validPort(selectedPort)
            ? await this.deps.inspectNative(selectedPort).catch(() => ({ listenerAvailable: false, workbenchPageCount: null }))
            : { listenerAvailable: false, workbenchPageCount: null };
        const application = await this.inspectApplication();
        const windowIdentity = inspectWindowIdentity(this.context, this.deps, application);
        const windowState: ColabEnvironmentPreflightLocal['window'] = {
            localHost: !vscode.env.remoteName,
            trusted: vscode.workspace.isTrusted,
            workspace: { kind: workspaceKind, folderCount: folders.length },
            notebooks: {
                total: notebooks.length,
                fileBacked: notebooks.filter(document => document.uri.scheme === 'file' && !document.isUntitled).length,
                untitled: notebooks.filter(document => document.isUntitled).length,
                dirty: notebooks.filter(document => document.isDirty).length,
                visibleEditors: vscode.window.visibleNotebookEditors.length,
                activeEditor: Boolean(vscode.window.activeNotebookEditor)
            },
            textDocuments: {
                total: documents.length,
                fileBacked: documents.filter(document => document.uri.scheme === 'file').length,
                untitled: documents.filter(document => document.isUntitled).length,
                dirty: documents.filter(document => document.isDirty).length,
                blocking: documents.filter(document => document.isDirty || document.isUntitled || document.uri.scheme === 'file').length,
                visibleEditors: vscode.window.visibleTextEditors.length,
                activeEditor: Boolean(vscode.window.activeTextEditor)
            },
            tabs: {
                total: tabs.length,
                dirty: tabs.filter(tab => tab.isDirty).length,
                benignWelcomeOnly: tabs.length === 1 && tabs[0].label === 'Welcome' && tabs[0].input === undefined && !tabs[0].isDirty
            },
            terminals: { total: vscode.window.terminals.length },
            debugging: { active: Boolean(vscode.debug.activeDebugSession) },
            quitPolicy: { confirmBeforeClose: confirmBeforeClose === 'never' ? 'never' : 'unsupported', restoreWindows }
        };
        const blockers: string[] = [];
        if (!windowState.localHost) blockers.push('remote_host_unsupported');
        if (!windowState.trusted) blockers.push('workspace_untrusted');
        if (nativeSource === 'invalid') blockers.push('native_port_invalid');
        if (!native.listenerAvailable) blockers.push('native_binding_unavailable');
        if (application.status !== 'verified') blockers.push(application.failureCode ?? 'application_identity_unverified');
        if (windowState.quitPolicy.confirmBeforeClose !== 'never') blockers.push('close_confirmation_unsupported');
        if (windowState.debugging.active) blockers.push('debug_session_present');
        if (windowState.workspace.kind !== 'empty') blockers.push('automatic_restart_workspace_present');
        if (windowState.notebooks.total || windowState.notebooks.visibleEditors || windowState.notebooks.activeEditor) blockers.push('open_notebook_present');
        if (windowState.terminals.total) blockers.push('terminal_present');
        if (windowState.textDocuments.blocking || windowState.textDocuments.visibleEditors || windowState.textDocuments.activeEditor) blockers.push('open_document_present');
        if (windowState.tabs.total && !windowState.tabs.benignWelcomeOnly) blockers.push('editor_present');
        const result: ColabEnvironmentPreflightLocal = {
            schemaVersion: 1,
            observedAt,
            readOnly: true,
            nativeBinding: {
                source: nativeSource,
                port: validPort(selectedPort) ? selectedPort : null,
                listenerAvailable: native.listenerAvailable,
                workbenchPageCount: native.workbenchPageCount,
                exactWindowBinding: 'not-established',
                correspondenceReason: 'debug-targets-do-not-expose-vscode-peer-window-ids'
            },
            windowIdentity,
            window: windowState,
            application,
            blockers: [...new Set(blockers)]
        };
        return JSON.stringify(result);
    }

    private async inspectApplication(): Promise<ColabEnvironmentPreflightLocal['application']> {
        const base: ColabEnvironmentPreflightLocal['application'] = {
            status: 'unavailable',
            version: this.deps.vscodeVersion,
            supportedVersion: SUPPORTED_VERSION,
            versionSupported: this.deps.vscodeVersion === SUPPORTED_VERSION,
            commit: null,
            mainProcessPid: null,
            mainProcessIdentity: 'unavailable',
            defaultInstall: 'unsupported',
            startupArguments: 'unavailable',
            actualWindowCount: null,
            nativeWindows: [],
            failureCode: null
        };
        let install: InstallIdentity;
        try {
            install = validateDefaultWindowsInstall({
                platform: this.deps.platform,
                version: this.deps.vscodeVersion,
                execPath: this.deps.execPath,
                env: this.deps.env,
                globalStoragePath: this.root,
                extensionPath: this.context.extensionPath,
                extensionId: this.context.extension.id,
                appHost: vscode.env.appHost,
                remoteName: vscode.env.remoteName
            });
            base.defaultInstall = 'verified';
        } catch (error) {
            base.status = 'unsupported';
            base.failureCode = error instanceof ColabEnvironmentError ? error.code : 'installation_unsupported';
            return base;
        }
        let pid: number;
        try { pid = parsePid(this.deps.env.VSCODE_PID); }
        catch (error) {
            base.failureCode = error instanceof ColabEnvironmentError ? error.code : 'main_process_unverified';
            return base;
        }
        base.mainProcessPid = pid;
        const before = await this.deps.inspectProcess(pid).catch(() => undefined);
        if (!before || !samePath(before.executablePath, install.executablePath)) {
            base.mainProcessIdentity = before ? 'mismatch' : 'unavailable';
            base.status = before ? 'mismatch' : 'unavailable';
            base.failureCode = 'main_process_unverified';
            return base;
        }
        let status: ParsedCodeStatus;
        try {
            status = parseCodeStatus(await this.deps.runCodeStatus(install.executablePath), pid);
        } catch (error) {
            base.failureCode = error instanceof ColabEnvironmentError ? error.code : 'status_unavailable';
            return base;
        }
        base.version = status.version;
        base.versionSupported = status.version === SUPPORTED_VERSION && status.version === this.deps.vscodeVersion;
        base.commit = status.commit;
        base.actualWindowCount = status.windows.length;
        if (status.windows.length <= MAX_NATIVE_WINDOWS && status.windows.every(window =>
            Number.isSafeInteger(window.id) && window.id > 0 &&
            Number.isSafeInteger(window.pid) && window.pid > 0)) {
            base.nativeWindows = status.windows.map(window => ({ id: window.id, rendererProcessPid: window.pid }))
                .sort((left, right) => left.id - right.id || left.rendererProcessPid - right.rendererProcessPid);
        }
        try { assertSafeInitialArgs(status.processArgs); base.startupArguments = 'supported'; }
        catch (error) {
            base.startupArguments = 'unsupported';
            base.status = 'unsupported';
            base.failureCode = error instanceof ColabEnvironmentError ? error.code : 'startup_arguments_unsupported';
        }
        const after = await this.deps.inspectProcess(pid).catch(() => undefined);
        if (!after) {
            base.mainProcessIdentity = 'unavailable';
            base.status = 'unavailable';
            base.failureCode ??= 'main_process_unverified';
            return base;
        }
        if (!sameProcess(before, after) || !samePath(after.executablePath, install.executablePath)) {
            base.mainProcessIdentity = 'mismatch';
            base.status = 'mismatch';
            base.failureCode = 'main_process_unverified';
            return base;
        }
        base.mainProcessIdentity = 'verified';
        if (!base.versionSupported) {
            base.status = 'unsupported';
            base.failureCode = 'unsupported_vscode_version';
        } else if (base.startupArguments === 'supported') {
            base.status = 'verified';
            base.failureCode = null;
        }
        return base;
    }

    async prepare(folderUri?: string, restartMode?: RestartMode): Promise<string> {
        if (restartMode !== undefined && restartMode !== 'restore-clean-workspace') {
            throw new ColabEnvironmentError('restart_mode_invalid', 'restartMode is unsupported.');
        }
        if (restartMode === 'restore-clean-workspace') return this.prepareRestoredWorkspace(folderUri);
        assertMutationAllowed();
        this.assertLocalHost();
        const requestedFolder = folderUri === undefined ? undefined : await resolveRequestedFolder(folderUri);
        const currentPort = await this.findWorkingPort();
        if (currentPort) {
            const active = await this.obtainActive();
            if (active) {
                const receipt = await this.requireReceipt(active);
                this.presentMatchingActive(receipt, requestedFolder);
                const freshNativeBind = await this.reconcile(receipt);
                if (!freshNativeBind) await this.prepareWorkspace(receipt);
                return this.present(await this.requireReceipt(active), freshNativeBind);
            }
            const current = currentWorkspaceIdentity();
            if (current) {
                if (requestedFolder && requestedFolder.uri !== current.uri &&
                    !(vscode.workspace.workspaceFile && vscode.workspace.workspaceFolders?.[0]?.uri.toString() === requestedFolder.uri)) {
                    throw new ColabEnvironmentError('workspace_mismatch', 'The requested folder is not this window\'s current workspace. Use an empty window or omit folderUri to prepare the current workspace.');
                }
                if (!vscode.workspace.workspaceFile) {
                    assertWorkspaceConversionSafe();
                    const receipt = await this.createBootstrapReceipt(currentPort, 'workspace_open_requested', undefined,
                        { uri: current.uri, label: current.label, path: vscode.Uri.parse(current.uri).fsPath });
                    await this.prepareWorkspace(receipt);
                    return this.present(await this.requireReceipt(receipt.preparationId));
                }
                const receipt = await this.newReceipt(current, currentPort, false, 'environment_ready');
                receipt.readyAt = this.deps.now();
                await this.writeReceipt(receipt);
                return this.present(receipt, true);
            }
            const receipt = await this.createBootstrapReceipt(currentPort, 'workspace_open_requested', undefined, requestedFolder);
            try {
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(receipt.workspaceUri), {
                    forceNewWindow: true, forceLocalWindow: true, noRecentEntry: true
                });
                return this.present(receipt);
            } catch (error) {
                await this.fail(receipt, 'workspace_open_failed');
                throw new ColabEnvironmentError('workspace_open_failed', `VS Code could not open the Colab workspace: ${safeError(error)}`);
            }
        }

        const install = validateDefaultWindowsInstall({
            platform: this.deps.platform,
            version: this.deps.vscodeVersion,
            execPath: this.deps.execPath,
            env: this.deps.env,
            globalStoragePath: this.root,
            extensionPath: this.context.extensionPath,
            extensionId: this.context.extension.id,
            appHost: vscode.env.appHost,
            remoteName: vscode.env.remoteName
        });
        await assertCleanEmptyWindow();
        const pid = parsePid(this.deps.env.VSCODE_PID);
        const status = parseCodeStatus(await this.deps.runCodeStatus(install.executablePath), pid);
        if (status.version !== SUPPORTED_VERSION) throw new ColabEnvironmentError('unsupported_vscode_version', `Automatic restart is pinned to VS Code ${SUPPORTED_VERSION}.`);
        assertSafeInitialArgs(status.processArgs);
        if (status.windows.length !== 1) throw new ColabEnvironmentError('window_count_unsupported', 'Automatic restart requires exactly one corroborated VS Code window.');
        const processIdentity = await this.deps.inspectProcess(pid);
        if (!processIdentity || !samePath(processIdentity.executablePath, install.executablePath)) {
            throw new ColabEnvironmentError('main_process_unverified', 'The VS Code main process could not be identified exactly.');
        }
        const active = await this.obtainActive();
        if (active) return this.presentMatchingActive(await this.requireReceipt(active), requestedFolder);
        const configuredPort = vscode.workspace.getConfiguration('jupyterMcp').get<number>('nativeDebugPort', 0) ?? 0;
        if (configuredPort !== 0 && !validPort(configuredPort)) throw new ColabEnvironmentError('native_port_invalid', 'The configured native debugging port is invalid.');
        const port = await this.deps.reservePort(configuredPort || undefined);
        const receipt = await this.createBootstrapReceipt(port, 'arming_restart', {
            installedCommit: status.commit,
            main: processIdentity,
            executablePath: install.executablePath,
            userDataDir: install.userDataDir,
            extensionsDir: install.extensionsDir,
            helperToken: this.deps.uuid()
        }, requestedFolder);
        const helperPath = path.join(this.root, HELPER);
        await fs.writeFile(helperPath, HELPER_SOURCE, { encoding: 'utf8' });
        try {
            await this.deps.armHelper(install.executablePath, helperPath, this.receiptPath(receipt.preparationId), receipt);
            const armed = await this.requireReceipt(receipt.preparationId);
            if (armed.status !== 'restart_requested' || armed.helperToken !== receipt.helperToken) throw new Error('helper acknowledgement did not match the receipt');
            await assertCleanEmptyWindow();
            const observed = await this.deps.inspectProcess(pid);
            if (!observed || !sameProcess(observed, processIdentity)) throw new Error('main process identity changed before quit');
            if (this.disposed) throw new Error('extension context was disposed before quit');
            this.deps.requestQuit(async () => {
                try {
                    if (this.disposed) throw new Error('extension context was disposed before quit dispatch');
                    await assertCleanEmptyWindow();
                    const latest = await this.requireReceipt(receipt.preparationId);
                    if (latest.status !== 'restart_requested' || latest.helperToken !== receipt.helperToken) throw new Error('restart receipt changed before quit dispatch');
                    const atDispatchStatus = parseCodeStatus(await this.deps.runCodeStatus(install.executablePath), pid);
                    if (atDispatchStatus.windows.length !== 1 || atDispatchStatus.commit !== status.commit || atDispatchStatus.version !== status.version) {
                        throw new Error('app or window identity changed before quit dispatch');
                    }
                    assertSafeInitialArgs(atDispatchStatus.processArgs);
                    const atDispatch = await this.deps.inspectProcess(pid);
                    if (!atDispatch || !sameProcess(atDispatch, processIdentity)) throw new Error('main process identity changed before quit dispatch');
                    latest.quitDispatchApprovedAt = this.deps.now();
                    await this.writeReceipt(latest);
                    return true;
                } catch {
                    await this.fail(receipt, this.disposed ? 'cancelled' : 'quit_preflight_changed');
                    return false;
                }
            }, async () => {
                // Disposal is expected after VS Code has passed its shutdown-veto phase,
                // but is also possible during an extension-host reload. A reactivated
                // owner in the same exact main process disarms that case in initialize().
                if (this.disposed) return;
                const latest = await retryWatchdogReceiptReadForTest(
                    () => this.readReceipt(receipt.preparationId),
                    () => !this.disposed && this.deps.now() <= receipt.deadline
                );
                if (!latest || latest.status !== 'restart_requested' || latest.helperToken !== receipt.helperToken) return;
                latest.status = 'failed';
                latest.failure = 'quit_not_confirmed';
                await this.writeReceipt(latest);
                await this.releaseActive(latest.preparationId);
            });
            return this.present(armed);
        } catch (error) {
            await this.fail(receipt, this.disposed ? 'cancelled' : 'helper_arm_failed');
            throw new ColabEnvironmentError(this.disposed ? 'cancelled' : 'helper_arm_failed', `VS Code restart was not requested: ${safeError(error)}`);
        }
    }

    private async prepareRestoredWorkspace(folderUri?: string): Promise<string> {
        // This is deliberately the first operation: routed mutations that were
        // already in flight block acquisition, and later ones see the exclusion.
        let prepareRequest: symbol;
        try { prepareRequest = this.beginRestorePreparation(); }
        catch (error) {
            if (error instanceof OperationGateError) throw new ColabEnvironmentError(error.code, error.message);
            throw error;
        }
        let receipt: Receipt | undefined;
        let helperDispatchStarted = false;
        try {
            this.assertLocalHost();
            const initialWorkspace = captureRestorationWorkspaceState();
            const requestedFolder = folderUri === undefined ? undefined : await resolveRequestedFolder(folderUri);
            assertSameRestorationWorkspace(initialWorkspace, captureRestorationWorkspaceState());
            if (requestedFolder && !initialWorkspace.workspace.roots.some(root => root.uri === requestedFolder.requestedUri)) {
                throw new ColabEnvironmentError('workspace_mismatch', 'folderUri must match one existing root of the configured Workspace.');
            }

            const install = validateDefaultWindowsInstall({
                platform: this.deps.platform,
                version: this.deps.vscodeVersion,
                execPath: this.deps.execPath,
                env: this.deps.env,
                globalStoragePath: this.root,
                extensionPath: this.context.extensionPath,
                extensionId: this.context.extension.id,
                appHost: vscode.env.appHost,
                remoteName: vscode.env.remoteName
            });
            const currentPort = await this.findWorkingPort();
            assertSameRestorationWorkspace(initialWorkspace, captureRestorationWorkspaceState());
            if (currentPort) {
                // A marker-bound native connection needs no restart authorization.
                // Keep only exact Workspace/root and target/install/window checks;
                // editor, quit-policy, runtime and saved-state gates protect an
                // actual quit and therefore do not apply here.
                let application = await this.verifyRestoredApplication(initialWorkspace, undefined, true);
                assertSameRestorationWorkspace(initialWorkspace, captureRestorationWorkspaceState());
                if (!await this.deps.probeNative(currentPort)) {
                    throw new ColabEnvironmentError('native_binding_unavailable', 'The marker-bound native connection changed during no-restart verification.');
                }
                assertSameRestorationWorkspace(initialWorkspace, captureRestorationWorkspaceState());
                application = await this.verifyRestoredApplication(initialWorkspace, undefined, true);
                assertSameRestorationWorkspace(initialWorkspace, captureRestorationWorkspaceState());
                receipt = await this.newReceipt(
                    { uri: initialWorkspace.workspace.uri, label: restorationWindowLabel(initialWorkspace) }, currentPort, false, 'environment_ready'
                );
                assertSameRestorationWorkspace(initialWorkspace, captureRestorationWorkspaceState());
                Object.assign(receipt, {
                    restartMode: 'restore-clean-workspace' as const,
                    restorationSnapshot: initialWorkspace,
                    restartRequired: false,
                    installedCommit: application.status.commit,
                    main: application.process,
                    executablePath: install.executablePath,
                    userDataDir: install.userDataDir,
                    extensionsDir: install.extensionsDir,
                    readyAt: this.deps.now()
                });
                if (!validateReceipt(receipt)) {
                    throw new ColabEnvironmentError('preparation_receipt_invalid', 'The native-ready preparation receipt failed strict validation.');
                }
                await this.writeReceipt(receipt);
                assertSameRestorationWorkspace(initialWorkspace, captureRestorationWorkspaceState());
                return this.present(receipt, true);
            }

            const initial = captureRestorationPublicState();
            assertSameRestorationWorkspace(initialWorkspace, initial);
            const savedState = await this.deps.inspectSavedState(install.userDataDir, vscode.workspace.workspaceFile!);
            const snapshot: RestorationSnapshot = { ...initial, savedState };
            assertRestorationSnapshotSize(snapshot);
            assertSameRestorationPublicState(snapshot, captureRestorationPublicState());
            const application = await this.verifyRestoredApplication(snapshot);
            await this.assertRestorationSnapshot(snapshot, false, install.userDataDir);

            this.assertNoBackgroundWork();
            await this.deps.assertNoActiveKernels().catch(error => {
                const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'kernel_observation_unavailable';
                throw new ColabEnvironmentError(code, 'Every open notebook must affirmatively return no active kernel before restored-workspace restart.');
            });
            await this.assertRestorationSnapshot(snapshot, true, install.userDataDir);

            const active = await this.obtainActive(prepareRequest);
            if (active) {
                const existing = await this.requireReceipt(active);
                if (existing.status === 'failed' || existing.status === 'environment_ready') {
                    // The receipt terminalized between obtainActive's read and
                    // this durable read. Cleanup relinquishes only that durable
                    // ID; the prepare request continues holding the same handle.
                    await this.releaseActive(existing.preparationId);
                    if (existing.restartMode === 'restore-clean-workspace') {
                        this.releaseTerminalRestoreExclusion(existing);
                    }
                } else {
                    if (existing.restartMode !== 'restore-clean-workspace' || existing.workspaceUri !== snapshot.workspace.uri) {
                        throw new ColabEnvironmentError('preparation_target_mismatch', 'A different Colab environment preparation is already active.');
                    }
                    this.adoptRestoreExclusion(prepareRequest, existing.preparationId);
                    return this.present(existing);
                }
            }
            const configuredPort = vscode.workspace.getConfiguration('jupyterMcp').get<number>('nativeDebugPort', 0) ?? 0;
            if (configuredPort !== 0 && !validPort(configuredPort)) throw new ColabEnvironmentError('native_port_invalid', 'The configured native debugging port is invalid.');
            const port = await this.deps.reservePort(configuredPort || undefined);
            const preparationId = this.deps.uuid();
            const candidate = await this.newReceipt(
                { uri: snapshot.workspace.uri, label: restorationWindowLabel(snapshot) }, port, false, 'arming_restart', preparationId
            );
            Object.assign(candidate, {
                restartMode: 'restore-clean-workspace' as const,
                restorationSnapshot: snapshot,
                restartRequired: true,
                installedCommit: application.status.commit,
                main: application.process,
                executablePath: install.executablePath,
                userDataDir: install.userDataDir,
                extensionsDir: install.extensionsDir,
                helperToken: this.deps.uuid()
            });
            assertRestoredReceiptHeadroom(candidate);
            this.adoptRestoreExclusion(prepareRequest, preparationId);
            receipt = candidate;
            await this.claimActive(preparationId);
            await this.writeReceipt(receipt);

            const helperPath = path.join(this.root, HELPER);
            await fs.writeFile(helperPath, HELPER_SOURCE, { encoding: 'utf8' });
            await this.assertRestorationSnapshot(snapshot, true, install.userDataDir);
            await this.verifyRestoredApplication(snapshot, receipt);
            helperDispatchStarted = true;
            await this.deps.armHelper(install.executablePath, helperPath, this.receiptPath(receipt.preparationId), receipt);
            const armed = await this.requireReceipt(receipt.preparationId);
            if (armed.status !== 'restart_requested' || armed.helperToken !== receipt.helperToken || armed.restartMode !== 'restore-clean-workspace') {
                throw new Error('helper acknowledgement did not match the restored-workspace receipt');
            }
            await this.assertRestorationSnapshot(snapshot, true, install.userDataDir);
            await this.verifyRestoredApplication(snapshot, armed);
            if (this.disposed) throw new Error('extension context was disposed before quit');

            this.deps.requestQuit(async () => {
                try {
                    if (this.disposed) throw new Error('extension context was disposed before quit dispatch');
                    await this.assertRestorationSnapshot(snapshot, true, install.userDataDir);
                    await this.verifyRestoredApplication(snapshot, armed);
                    const latest = await this.requireReceipt(armed.preparationId);
                    if (latest.status !== 'restart_requested' || latest.helperToken !== armed.helperToken || latest.restartMode !== 'restore-clean-workspace') {
                        throw new Error('restored-workspace receipt changed before quit dispatch');
                    }
                    latest.quitDispatchApprovedAt = this.deps.now();
                    await this.writeReceipt(latest);
                    // No await is permitted after this point. This is the final
                    // synchronous GUI/mutation check immediately before quit.
                    this.assertRestoreExclusionOwnedBy(armed.preparationId);
                    this.assertNoBackgroundWork();
                    assertSameRestorationPublicState(snapshot, captureRestorationPublicState());
                    return true;
                } catch {
                    const disarmed = await this.disarmRestoredReceipt(armed, this.disposed ? 'cancelled' : 'quit_preflight_changed');
                    if (!disarmed) return false;
                    return false;
                }
            }, async () => {
                if (this.disposed) return;
                const latest = await retryWatchdogReceiptReadForTest(
                    () => this.readReceipt(armed.preparationId),
                    () => !this.disposed && this.deps.now() <= armed.deadline
                );
                if (!latest || latest.status !== 'restart_requested' || latest.helperToken !== armed.helperToken) return;
                await this.fail(latest, 'quit_not_confirmed');
            });
            return this.present(armed);
        } catch (error) {
            if (receipt && receipt.status !== 'environment_ready' && helperDispatchStarted) {
                const disarmed = await this.disarmRestoredReceipt(receipt, this.disposed ? 'cancelled' : 'helper_arm_failed');
                if (!disarmed) {
                    throw new ColabEnvironmentError('restart_disarm_uncertain', 'Restored-workspace restart could not be disarmed conclusively; mutating operations remain blocked.');
                }
            } else {
                if (receipt) {
                    // No helper was dispatched, so a receipt-write failure cannot
                    // leave a launch authorization alive. Record failure if
                    // possible, but never retain a process-local mutation block.
                    await this.fail(receipt, this.disposed ? 'cancelled' : 'helper_arm_failed').catch(() => undefined);
                    await this.releaseActive(receipt.preparationId).catch(() => undefined);
                }
                this.unbindRestoreExclusionBeforeHelper(prepareRequest, receipt?.preparationId);
            }
            if (error instanceof ColabEnvironmentError) throw error;
            if (error instanceof OperationGateError) throw new ColabEnvironmentError(error.code, error.message);
            throw new ColabEnvironmentError('restored_workspace_preparation_failed', `Restored-workspace restart was not requested: ${safeError(error)}`);
        } finally {
            this.finishRestorePreparation(prepareRequest);
        }
    }

    async get(preparationId: string): Promise<string> {
        if (!isUuid(preparationId)) throw new ColabEnvironmentError('preparation_invalid', 'preparationId is malformed.');
        const receipt = await this.requireReceipt(preparationId);
        if (receipt.restartMode === 'restore-clean-workspace') {
            if (receipt.status === 'failed' || receipt.status === 'environment_ready') this.releaseTerminalRestoreExclusion(receipt);
            else this.ensureRestoreExclusion(receipt.preparationId);
        }
        const freshNativeBind = await this.reconcile(receipt);
        return this.present(await this.requireReceipt(preparationId), freshNativeBind);
    }

    private async reconcile(receipt: Receipt): Promise<boolean> {
        if (receipt.status === 'failed') {
            await this.releaseActive(receipt.preparationId);
            if (receipt.restartMode === 'restore-clean-workspace') this.releaseTerminalRestoreExclusion(receipt);
            return false;
        }
        if (receipt.status !== 'environment_ready' && this.deps.now() > receipt.deadline) {
            await this.fail(receipt, 'preparation_timeout'); return false;
        }
        if (receipt.restartMode === 'restore-clean-workspace') return this.reconcileRestoredWorkspace(receipt);
        if (!this.matchesWorkspace(receipt)) return false;
        if (!vscode.workspace.isTrusted) return false;
        if (receipt.generatedWorkspace && !await this.verifyFolderMarker(receipt)) return false;
        if (!await this.deps.probeNative(receipt.port)) return false;
        // Native probing yields. Recheck the exact workspace before pinning the
        // newly created configuration or publishing readiness.
        if (!this.matchesWorkspace(receipt) || !vscode.workspace.isTrusted) return false;
        if (receipt.folderPreparation && !receipt.folderPreparation.workspaceFileUri) {
            receipt.folderPreparation.workspaceFileUri = vscode.workspace.workspaceFile!.toString();
        }
        if (receipt.status !== 'environment_ready') {
            receipt.status = 'environment_ready'; receipt.readyAt = this.deps.now(); receipt.failure = undefined;
            await this.writeReceipt(receipt); await this.releaseActive(receipt.preparationId);
        }
        return true;
    }

    private async reconcileRestoredWorkspace(receipt: Receipt): Promise<boolean> {
        if (receipt.status !== 'app_launched' && receipt.status !== 'environment_ready') return false;
        if (receipt.status === 'environment_ready') {
            if (currentWorkspaceIdentity()?.uri !== receipt.workspaceUri || !vscode.workspace.isTrusted) return false;
            if (!await this.deps.probeNative(receipt.port)) return false;
            if (currentWorkspaceIdentity()?.uri !== receipt.workspaceUri || !vscode.workspace.isTrusted) return false;
            await this.releaseActive(receipt.preparationId);
            this.releaseTerminalRestoreExclusion(receipt);
            return true;
        }
        const snapshot = receipt.restorationSnapshot as RestorationSnapshot;
        try {
            const install = validateDefaultWindowsInstall({
                platform: this.deps.platform,
                version: this.deps.vscodeVersion,
                execPath: this.deps.execPath,
                env: this.deps.env,
                globalStoragePath: this.root,
                extensionPath: this.context.extensionPath,
                extensionId: this.context.extension.id,
                appHost: vscode.env.appHost,
                remoteName: vscode.env.remoteName
            });
            await this.assertPostRestorationSnapshot(snapshot, install.userDataDir);
            await this.verifyRestoredApplication(snapshot, receipt);
            if (!await this.deps.probeNative(receipt.port)) return false;
            await this.assertPostRestorationSnapshot(snapshot, install.userDataDir);
            await this.verifyRestoredApplication(snapshot, receipt);
            receipt.status = 'environment_ready';
            receipt.readyAt = this.deps.now();
            receipt.failure = undefined;
            await this.writeReceipt(receipt);
            const durable = await this.requireReceipt(receipt.preparationId);
            if (durable.status !== 'environment_ready') return false;
            await this.releaseActive(receipt.preparationId);
            this.releaseTerminalRestoreExclusion(durable);
            return true;
        } catch (error) {
            // Restoration can still be completing when the extension activates.
            // Keep the bounded exclusion and receipt pending until a later poll
            // matches exactly or the original 120-second deadline expires.
            return false;
        }
    }

    private matchesWorkspace(receipt: Receipt): boolean {
        if (receipt.restartMode === 'restore-clean-workspace') {
            return currentWorkspaceIdentity()?.uri === receipt.workspaceUri;
        }
        const preparation = receipt.folderPreparation;
        if (!preparation) return currentWorkspaceIdentity()?.uri === receipt.workspaceUri;
        const folders = vscode.workspace.workspaceFolders;
        const file = vscode.workspace.workspaceFile;
        if (!file || !folders?.length || folders[0].uri.toString() !== receipt.workspaceUri || folders[0].name !== preparation.preparedName) return false;
        if (preparation.workspaceFileUri) return file.toString() === preparation.workspaceFileUri;
        return receipt.status === 'workspace_conversion_requested' && preparation.requestedAt !== undefined &&
            file.scheme === 'untitled' && folders.length === 1;
    }

    /** Only explicit preparation and its activation continuation can dispatch this
     * public API operation. Polling a receipt never changes the workspace. */
    private async prepareWorkspace(receipt: Receipt): Promise<void> {
        if (this.workspacePreparation) return this.workspacePreparation;
        const pending = this.convertWorkspace(receipt);
        this.workspacePreparation = pending;
        try { await pending; } finally { if (this.workspacePreparation === pending) this.workspacePreparation = undefined; }
    }

    private async convertWorkspace(receipt: Receipt): Promise<void> {
        // Re-read inside the serialized operation: overlapping callers may hold
        // an older pre-dispatch receipt, and a request must never be sent twice.
        receipt = await this.requireReceipt(receipt.preparationId);
        const preparation = receipt.folderPreparation;
        if (!preparation || preparation.requestedAt !== undefined ||
            !['workspace_open_requested', 'app_launched', 'restart_requested'].includes(receipt.status) ||
            this.deps.now() > receipt.deadline) return;
        const exactFolder = () => !vscode.workspace.workspaceFile && vscode.workspace.workspaceFolders?.length === 1 &&
            vscode.workspace.workspaceFolders[0].uri.toString() === receipt.workspaceUri &&
            vscode.workspace.workspaceFolders[0].name === preparation.originalName;
        if (!exactFolder()) return;
        try {
            this.assertLocalHost();
            assertWorkspaceConversionSafe();
            if (receipt.generatedWorkspace && !await this.verifyFolderMarker(receipt)) return;
            if (!await this.deps.probeNative(receipt.port)) return;
            preparation.requestedAt = this.deps.now();
            receipt.status = 'workspace_conversion_requested';
            await this.writeReceipt(receipt);
            // There is no await between final public-state checks and dispatch.
            if (this.disposed || this.deps.now() > receipt.deadline || !exactFolder()) throw new ColabEnvironmentError('workspace_changed', 'The preparation workspace changed before conversion.');
            this.assertLocalHost();
            assertWorkspaceConversionSafe();
            const accepted = vscode.workspace.updateWorkspaceFolders(0, 1, {
                uri: vscode.workspace.workspaceFolders![0].uri, name: preparation.preparedName
            });
            if (!accepted) throw new ColabEnvironmentError('workspace_conversion_rejected', 'VS Code rejected workspace preparation.');
            // Replacing the first root terminates this extension host. The new
            // activation verifies the one-root untitled workspace and fresh CDP
            // binding; true here is not completion and is never retried.
        } catch (error) {
            await this.fail(receipt, error instanceof ColabEnvironmentError ? error.code : 'workspace_conversion_failed');
        }
    }

    private async createBootstrapReceipt(
        port: number,
        status: PreparationStatus,
        restart?: Pick<Receipt, 'installedCommit' | 'main' | 'executablePath' | 'userDataDir' | 'extensionsDir' | 'helperToken'>,
        requestedFolder?: { uri: string; label: string; path: string }
    ): Promise<Receipt> {
        const preparationId = this.deps.uuid();
        await this.claimActive(preparationId);
        try {
            const expectedWindowLabel = requestedFolder?.label ?? `colab-bootstrap-${preparationId.slice(0, 8)}`;
            const workspacePath = requestedFolder?.path ?? path.join(this.workspaceRoot, expectedWindowLabel);
            if (!requestedFolder) await fs.mkdir(workspacePath, { recursive: false });
            const identity = { uri: requestedFolder?.uri ?? vscode.Uri.file(workspacePath).toString(), label: expectedWindowLabel };
            const receipt = await this.newReceipt(identity, port, !requestedFolder, status, preparationId, workspacePath);
            receipt.folderPreparation = { originalName: expectedWindowLabel, preparedName: `${expectedWindowLabel} [Colab ${preparationId.slice(0, 8)}]` };
            if (restart) Object.assign(receipt, restart);
            if (!requestedFolder) await writeJsonAtomic(path.join(workspacePath, FOLDER_MARKER), { schema: SCHEMA, preparationId, nonce: receipt.nonce });
            await this.writeReceipt(receipt);
            return receipt;
        } catch (error) {
            await this.releaseActive(preparationId);
            throw error;
        }
    }

    private async newReceipt(
        workspace: { uri: string; label: string }, port: number, generatedWorkspace: boolean, status: PreparationStatus,
        preparationId = this.deps.uuid(), workspacePath?: string
    ): Promise<Receipt> {
        await this.deps.restorationLifecycleHook?.('new_receipt', preparationId);
        const now = this.deps.now();
        return { schema: SCHEMA, preparationId, nonce: this.deps.uuid(), status, createdAt: now, deadline: now + PREPARATION_MS,
            workspaceUri: workspace.uri, workspacePath, expectedWindowLabel: workspace.label, port, generatedWorkspace };
    }

    private async findWorkingPort(): Promise<number | undefined> {
        const configured = vscode.workspace.getConfiguration('jupyterMcp').get<number>('nativeDebugPort', 0);
        const envPort = Number(this.deps.env.JUPYTER_MCP_NATIVE_DEBUG_PORT ?? 0);
        // Match the production adapter: a nonzero setting takes precedence.
        // Do not report readiness against an environment port that setup ignores.
        const port = configured || envPort;
        if (validPort(port) && await this.deps.probeNative(port)) return port;
        return undefined;
    }

    private assertLocalHost(): void {
        if (vscode.env.remoteName) throw new ColabEnvironmentError('remote_host_unsupported', 'Colab environment preparation requires a local VS Code window.');
        if (!vscode.workspace.isTrusted) throw new ColabEnvironmentError('workspace_untrusted', 'Trust this VS Code window before preparing Colab.');
    }

    private beginRestorePreparation(): symbol {
        if (this.restoreExclusion) {
            throw new OperationGateError('restart_in_progress', 'A restored-workspace restart is already pending in this window.');
        }
        const prepareRequest = Symbol('restored-workspace-prepare');
        this.restoreExclusion = { handle: acquireRestartExclusion(), prepareRequest };
        return prepareRequest;
    }

    /** Only the executing restored prepare request may transfer its provisional
     * ownership to a durable preparation ID. Polling and initialization use the
     * non-transferring ensureRestoreExclusion path below. */
    private adoptRestoreExclusion(prepareRequest: symbol, preparationId: string): void {
        const exclusion = this.restoreExclusion;
        if (!exclusion || exclusion.prepareRequest !== prepareRequest) {
            throw new OperationGateError('restart_exclusion_lost', 'The restored-workspace prepare request no longer owns its mutation exclusion.');
        }
        exclusion.handle.assertHeld();
        if (this.restoreDisarmUncertain && this.restoreDisarmUncertain !== preparationId) {
            throw new OperationGateError('restart_in_progress', 'Another restored-workspace restart has an uncertain helper disarm.');
        }
        if (exclusion.preparationId !== undefined && exclusion.preparationId !== preparationId) {
            throw new OperationGateError('restart_in_progress', 'Another restored-workspace preparation owns the mutation exclusion.');
        }
        exclusion.preparationId = preparationId;
    }

    private finishRestorePreparation(prepareRequest: symbol): void {
        const exclusion = this.restoreExclusion;
        if (!exclusion || exclusion.prepareRequest !== prepareRequest) return;
        exclusion.handle.assertHeld();
        exclusion.prepareRequest = undefined;
        if (exclusion.preparationId !== undefined || this.restoreDisarmUncertain) return;
        exclusion.handle.release();
        this.restoreExclusion = undefined;
    }

    private ensureRestoreExclusion(preparationId: string): void {
        if (!this.restoreExclusion) {
            this.restoreExclusion = { handle: acquireRestartExclusion(), preparationId };
            return;
        }
        this.restoreExclusion.handle.assertHeld();
        const owner = this.restoreExclusion.preparationId;
        if (this.restoreExclusion.prepareRequest) {
            if (owner === preparationId) return;
            throw new OperationGateError('restart_in_progress', 'A restored-workspace prepare request owns the mutation exclusion.');
        }
        if (owner === undefined) {
            if (this.restoreDisarmUncertain && this.restoreDisarmUncertain !== preparationId) {
                throw new OperationGateError('restart_in_progress', 'Another restored-workspace restart has an uncertain helper disarm.');
            }
            this.restoreExclusion.preparationId = preparationId;
            return;
        }
        if (owner !== preparationId) {
            throw new OperationGateError('restart_in_progress', 'Another restored-workspace preparation owns the mutation exclusion.');
        }
    }

    private assertRestoreExclusionOwnedBy(preparationId: string): void {
        if (!this.restoreExclusion || this.restoreExclusion.preparationId !== preparationId) {
            throw new OperationGateError('restart_exclusion_lost', 'The restored-workspace preparation no longer owns its mutation exclusion.');
        }
        this.restoreExclusion.handle.assertHeld();
    }

    private releaseUnownedRestoreExclusion(): void {
        if (!this.restoreExclusion || this.restoreExclusion.prepareRequest ||
            this.restoreExclusion.preparationId !== undefined || this.restoreDisarmUncertain) return;
        this.restoreExclusion.handle.release();
        this.restoreExclusion = undefined;
    }

    private unbindRestoreExclusionBeforeHelper(prepareRequest: symbol, preparationId?: string): void {
        const exclusion = this.restoreExclusion;
        if (!exclusion || exclusion.prepareRequest !== prepareRequest || this.restoreDisarmUncertain) return;
        // An omitted ID never clears an adopted older receipt. An exact ID is
        // safe to relinquish only on this request's confirmed pre-helper path;
        // finishRestorePreparation retains the same handle until this call exits.
        if (preparationId !== undefined && exclusion.preparationId === preparationId) {
            exclusion.preparationId = undefined;
        }
    }

    private markRestoreDisarmUncertain(preparationId: string): void {
        if (this.restoreExclusion?.preparationId === preparationId &&
            (!this.restoreDisarmUncertain || this.restoreDisarmUncertain === preparationId)) {
            this.restoreDisarmUncertain = preparationId;
        }
    }

    private releaseTerminalRestoreExclusion(receipt: Receipt): void {
        if (!['failed', 'environment_ready'].includes(receipt.status) ||
            !this.restoreExclusion || this.restoreExclusion.preparationId !== receipt.preparationId) return;
        if (this.restoreDisarmUncertain && this.restoreDisarmUncertain !== receipt.preparationId) return;
        if (this.restoreDisarmUncertain === receipt.preparationId) this.restoreDisarmUncertain = undefined;
        if (this.restoreExclusion.prepareRequest) {
            this.restoreExclusion.preparationId = undefined;
            return;
        }
        this.restoreExclusion.handle.release();
        this.restoreExclusion = undefined;
    }

    private disposeRestoreExclusion(): void {
        this.restoreExclusion?.handle.release();
        this.restoreExclusion = undefined;
    }

    private assertNoBackgroundWork(): void {
        this.restoreExclusion?.handle.assertHeld();
        if (this.deps.hasBackgroundWork()) {
            throw new ColabEnvironmentError('background_work_present', 'Tracked execution, setup, transfer or unsettled I/O is still active in this window.');
        }
    }

    private async assertRestorationSnapshot(
        snapshot: RestorationSnapshot,
        requireDisconnectedKernels: boolean,
        userDataDir: string
    ): Promise<void> {
        this.restoreExclusion?.handle.assertHeld();
        assertSameRestorationPublicState(snapshot, captureRestorationPublicState());
        if (requireDisconnectedKernels) {
            this.assertNoBackgroundWork();
            await this.deps.assertNoActiveKernels().catch(error => {
                const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'kernel_observation_unavailable';
                throw new ColabEnvironmentError(code, 'Every open notebook must affirmatively return no active kernel.');
            });
        }
        const saved = await this.deps.inspectSavedState(userDataDir, vscode.workspace.workspaceFile!);
        if (!snapshot.savedState || !sameJson(snapshot.savedState, saved)) {
            throw new ColabEnvironmentError('restoration_metadata_changed', 'VS Code restoration registry metadata changed during restart preparation.');
        }
        this.restoreExclusion?.handle.assertHeld();
        assertSameRestorationPublicState(snapshot, captureRestorationPublicState());
        if (requireDisconnectedKernels) this.assertNoBackgroundWork();
    }

    private async assertPostRestorationSnapshot(snapshot: RestorationSnapshot, userDataDir: string): Promise<void> {
        const expectedSaved = snapshot.savedState;
        if (!expectedSaved) throw new ColabEnvironmentError('restoration_metadata_unavailable', 'The approved restart receipt did not contain saved-state invariants.');
        assertSameRestoredResources(snapshot, captureRestoredResourceState());
        const saved = await this.deps.inspectSavedState(userDataDir, vscode.workspace.workspaceFile!);
        if (!sameJson(expectedSaved.untitledWorkspaces, saved.untitledWorkspaces) || saved.backupRegistry.emptyWindows !== 0) {
            throw new ColabEnvironmentError('restoration_metadata_changed', 'The approved untitled-Workspace or empty-window restoration invariant changed.');
        }
        assertSameRestoredResources(snapshot, captureRestoredResourceState());
    }

    private async verifyRestoredApplication(snapshot: RestorationWorkspaceState, receipt?: Receipt, skipInitialArguments = false): Promise<{
        install: InstallIdentity; status: ParsedCodeStatus; process: ProcessIdentity;
    }> {
        const install = validateDefaultWindowsInstall({
            platform: this.deps.platform,
            version: this.deps.vscodeVersion,
            execPath: this.deps.execPath,
            env: this.deps.env,
            globalStoragePath: this.root,
            extensionPath: this.context.extensionPath,
            extensionId: this.context.extension.id,
            appHost: vscode.env.appHost,
            remoteName: vscode.env.remoteName
        });
        const pid = parsePid(this.deps.env.VSCODE_PID);
        const before = await this.deps.inspectProcess(pid);
        if (!before || !samePath(before.executablePath, install.executablePath)) {
            throw new ColabEnvironmentError('main_process_unverified', 'The VS Code main process could not be identified exactly.');
        }
        const status = parseCodeStatus(await this.deps.runCodeStatus(install.executablePath), pid);
        if (status.version !== SUPPORTED_VERSION || status.commit !== SUPPORTED_COMMIT || status.windows.length !== 1) {
            throw new ColabEnvironmentError('application_identity_unverified', 'Restored-workspace restart requires the pinned VS Code build and exactly one native window.');
        }
        const postLaunch = receipt?.restartMode === 'restore-clean-workspace' && receipt.restartRequired === true &&
            (receipt.status === 'app_launched' || receipt.status === 'environment_ready');
        if (postLaunch) assertRestoredLaunchArgs(status.processArgsLine, receipt!);
        else if (!skipInitialArguments) assertSafeRestoredInitialArgs(status.processArgs, snapshot);
        const windowId = nativeWindowIdFromLogUri(this.context, this.deps);
        if (status.windows[0].id !== windowId) {
            throw new ColabEnvironmentError('window_identity_status_row_mismatch', 'The extension window did not match the sole native VS Code window.');
        }
        const after = await this.deps.inspectProcess(pid);
        if (!after || !sameProcess(before, after)) {
            throw new ColabEnvironmentError('main_process_unverified', 'The VS Code main process identity changed during verification.');
        }
        if (postLaunch) assertFreshRestoredProcess(receipt!, after, this.deps.now());
        return { install, status, process: after };
    }

    private async disarmRestoredReceipt(receipt: Receipt, failure: string): Promise<boolean> {
        try {
            await this.fail(receipt, failure);
            return true;
        } catch {
            // The helper approval may still be live. Keep the in-process gate so
            // no mutation can race an uncertain disarm.
            this.markRestoreDisarmUncertain(receipt.preparationId);
            return false;
        }
    }

    private async verifyFolderMarker(receipt: Receipt): Promise<boolean> {
        if (!receipt.workspacePath || !samePath(vscode.Uri.parse(receipt.workspaceUri).fsPath, receipt.workspacePath)) return false;
        const value = await readJson(path.join(receipt.workspacePath, FOLDER_MARKER));
        return !!value && value.schema === SCHEMA && value.preparationId === receipt.preparationId && value.nonce === receipt.nonce;
    }

    private presentMatchingActive(receipt: Receipt, requestedFolder?: { uri: string }): string {
        if (requestedFolder && requestedFolder.uri !== receipt.workspaceUri) {
            throw new ColabEnvironmentError('preparation_target_mismatch', 'A preparation for a different workspace is already active. Follow its existing receipt.');
        }
        return this.present(receipt);
    }

    private present(receipt: Receipt, freshNativeBind = false): string {
        const current = currentWorkspaceIdentity();
        const exactWindow = this.matchesWorkspace(receipt);
        const expectedWindowLabel = exactWindow ? current!.label : receipt.folderPreparation?.requestedAt !== undefined
            ? receipt.folderPreparation.preparedName : receipt.expectedWindowLabel;
        const ready = receipt.status === 'environment_ready' && exactWindow && vscode.workspace.isTrusted && freshNativeBind;
        const disarmUncertain = this.restoreDisarmUncertain === receipt.preparationId &&
            this.restoreExclusion?.preparationId === receipt.preparationId &&
            receipt.status !== 'failed' && receipt.status !== 'environment_ready';
        const status = disarmUncertain ? 'restart_disarm_uncertain' : receipt.status !== 'failed' && (exactWindow || current?.uri === receipt.workspaceUri) && !vscode.workspace.isTrusted ? 'workspace_untrusted' : receipt.status === 'environment_ready'
            ? !exactWindow ? 'workspace_mismatch' : !freshNativeBind ? 'native_binding_unavailable' : 'environment_ready'
            : receipt.status;
        const next = ready
            ? { tool: 'list_notebooks', hint: `Use the connected window labelled '${expectedWindowLabel}', then call open_notebooks there if the notebook is not already open.` }
            : status === 'workspace_open_requested' || status === 'workspace_mismatch'
                ? { tool: 'list_notebooks', hint: `Find the connected window for '${receipt.expectedWindowLabel}' and route get_colab_environment_preparation to it.` }
                : { tool: 'get_colab_environment_preparation', preparationId: receipt.preparationId, hint: 'Poll after VS Code has restarted; this status proves only the desktop environment.' };
        return JSON.stringify({ preparationId: receipt.preparationId, status, environmentReady: ready, runtimeReady: false,
            restartMode: receipt.restartMode, restartRequired: receipt.restartRequired,
            workspaceUri: receipt.folderPreparation?.workspaceFileUri ?? receipt.workspaceUri,
            folderUri: receipt.folderPreparation ? receipt.workspaceUri : undefined,
            expectedWindowLabel, failure: disarmUncertain ? 'restart_disarm_uncertain' : receipt.failure, next });
    }

    private receiptPath(id: string): string { return path.join(this.receiptRoot, `${id}.json`); }
    private async writeReceipt(receipt: Receipt): Promise<void> {
        const serialized = JSON.stringify(receipt);
        if (Buffer.byteLength(serialized) >= MAX_FILE_BYTES) {
            throw new ColabEnvironmentError('preparation_receipt_too_large', 'The durable preparation receipt exceeded its strict size bound.');
        }
        await this.deps.receiptIoHooks?.beforeWrite?.(receipt);
        await writeJsonAtomic(this.receiptPath(receipt.preparationId), receipt);
        await this.deps.receiptIoHooks?.afterWrite?.(receipt);
    }
    private async readReceipt(id: string): Promise<Receipt | undefined> {
        await this.deps.receiptIoHooks?.beforeRead?.(id);
        return validateReceipt(await readJson(this.receiptPath(id)));
    }
    private async requireReceipt(id: string): Promise<Receipt> {
        const receipt = await this.readReceipt(id);
        if (!receipt) throw new ColabEnvironmentError('preparation_not_found', 'The Colab environment preparation is unknown or corrupted.');
        return receipt;
    }
    private async readActive(): Promise<string | undefined> {
        const value = await readJson(this.activePath);
        return value && value.schema === SCHEMA && isUuid(value.preparationId) ? value.preparationId : undefined;
    }
    private async obtainActive(prepareRequest?: symbol): Promise<string | undefined> {
        const id = await this.readActive();
        if (!id) return undefined;
        const receipt = await this.readReceipt(id);
        if (!receipt || receipt.status === 'failed' || receipt.status === 'environment_ready') {
            await this.releaseActive(id); return undefined;
        }
        // The synchronously acquired exclusion is initially unowned. Bind it to
        // a pending restored receipt before any terminalization attempt so an
        // I/O failure cannot be mistaken for a safe pre-helper failure of the
        // new request.
        if (receipt.restartMode === 'restore-clean-workspace') {
            if (prepareRequest) this.adoptRestoreExclusion(prepareRequest, receipt.preparationId);
            else this.ensureRestoreExclusion(receipt.preparationId);
        }
        if (this.deps.now() > receipt.deadline) {
            if (receipt.restartMode === 'restore-clean-workspace') await this.fail(receipt, 'preparation_timeout');
            else await this.releaseActive(id);
            return undefined;
        }
        return id;
    }
    private async claimActive(id: string): Promise<void> {
        await fs.mkdir(this.root, { recursive: true });
        try {
            const handle = await fs.open(this.activePath, 'wx');
            try { await handle.writeFile(JSON.stringify({ schema: SCHEMA, preparationId: id }), 'utf8'); } finally { await handle.close(); }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ColabEnvironmentError('preparation_in_progress', 'Another Colab environment preparation is already active.');
            throw error;
        }
    }
    private async releaseActive(id: string): Promise<void> {
        if (await this.readActive() !== id) return;
        await fs.unlink(this.activePath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        await this.deps.restorationLifecycleHook?.('active_released', id);
    }
    private async fail(receipt: Receipt, failure: string): Promise<void> {
        const receiptHelperMayBeArmed = receipt.restartMode === 'restore-clean-workspace' &&
            (Number.isSafeInteger(receipt.helperArmedAt) || ['restart_requested', 'app_launched'].includes(receipt.status));
        let latest: Receipt;
        try {
            latest = await this.readReceipt(receipt.preparationId) ?? receipt;
        } catch (error) {
            if (receiptHelperMayBeArmed) {
                this.markRestoreDisarmUncertain(receipt.preparationId);
                throw new ColabEnvironmentError('restart_disarm_uncertain', `The restored-workspace receipt could not be read before durable failure: ${safeError(error)}`);
            }
            throw error;
        }
        const helperMayBeArmed = latest.restartMode === 'restore-clean-workspace' &&
            (Number.isSafeInteger(latest.helperArmedAt) || ['restart_requested', 'app_launched'].includes(latest.status));
        latest.status = 'failed'; latest.failure = failure;
        try {
            await this.writeReceipt(latest);
        } catch (error) {
            if (helperMayBeArmed) {
                this.markRestoreDisarmUncertain(latest.preparationId);
                throw new ColabEnvironmentError('restart_disarm_uncertain', `The restored-workspace failure receipt could not be written durably: ${safeError(error)}`);
            }
            throw error;
        }
        if (latest.restartMode === 'restore-clean-workspace') {
            let durable: Receipt | undefined;
            try {
                durable = await this.readReceipt(latest.preparationId);
            } catch (error) {
                if (helperMayBeArmed) this.markRestoreDisarmUncertain(latest.preparationId);
                throw new ColabEnvironmentError('restart_disarm_uncertain', `The restored-workspace failure receipt could not be read back durably: ${safeError(error)}`);
            }
            if (!durable || durable.status !== 'failed') {
                if (helperMayBeArmed) this.markRestoreDisarmUncertain(latest.preparationId);
                throw new ColabEnvironmentError('restart_disarm_uncertain', 'The restored-workspace failure receipt could not be verified durably.');
            }
            this.releaseTerminalRestoreExclusion(durable);
            await this.deps.restorationLifecycleHook?.('terminal_proven', latest.preparationId);
            await this.releaseActive(latest.preparationId).catch(() => undefined);
            return;
        }
        await this.releaseActive(latest.preparationId);
    }
}

export async function retryWatchdogReceiptReadForTest<T>(
    read: () => Promise<T | undefined>,
    canRetry: () => boolean,
    wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 250)),
    maxAttempts = 20
): Promise<T | undefined> {
    for (let attempt = 0; attempt < maxAttempts && canRetry(); attempt++) {
        try {
            const value = await read();
            if (value !== undefined && canRetry()) return value;
        } catch { /* retry an unknown observation below */ }
        if (attempt + 1 >= maxAttempts || !canRetry()) return undefined;
        await wait();
    }
    return undefined;
}

function productionDependencies(): ColabEnvironmentDependenciesForTest {
    return {
        now: Date.now,
        uuid: crypto.randomUUID,
        platform: process.platform,
        execPath: process.execPath,
        env: process.env,
        vscodeVersion: vscode.version,
        probeNative: probeNativePort,
        inspectNative: inspectNativePort,
        runCodeStatus,
        inspectProcess,
        reservePort,
        assertNoActiveKernels: assertNoExposedNotebookKernelsForRestart,
        hasBackgroundWork: () => hasGlobalNotebookExecutionWork() || hasGlobalColabSetupWork() || hasGlobalFileTransferWork(),
        inspectSavedState: inspectSavedStateMetadata,
        armHelper,
        requestQuit: (revalidate, stillAlive) => {
            setTimeout(() => {
                void revalidate().then(ok => {
                    if (!ok) return;
                    setTimeout(() => { void stillAlive().catch(() => undefined); }, QUIT_CONFIRM_MS);
                    void vscode.commands.executeCommand('workbench.action.quit').then(undefined, () => undefined);
                }).catch(() => undefined);
            }, QUIT_DELAY_MS);
        }
    };
}

async function inspectNativePort(port: number): Promise<ColabNativeEndpointInspection> {
    if (!validPort(port)) return { listenerAvailable: false, workbenchPageCount: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try { return await inspectColabNativeEndpoint(port, controller.signal); }
    finally { clearTimeout(timer); }
}

async function probeNativePort(port: number): Promise<boolean> {
    if (!validPort(port)) return false;
    const driver = createColabNativeDriver(port);
    const marker = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1_000_000);
    const text = `MCP Colab setup ${crypto.randomUUID()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    marker.text = text; marker.show();
    try { await driver.bind(text, controller.signal); return true; } catch { return false; }
    finally { clearTimeout(timer); driver.dispose(); marker.dispose(); }
}

function currentWorkspaceIdentity(): { uri: string; label: string } | undefined {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile) {
        const label = vscode.workspace.workspaceFolders?.map(folder => folder.name).join(', ') || 'workspace';
        return { uri: workspaceFile.toString(), label };
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length !== 1 || folders[0].uri.scheme !== 'file') return undefined;
    return { uri: folders[0].uri.toString(), label: folders[0].name };
}

/** Capture the identity needed even when no restart is required. This does not
 * inspect editor contents, tabs, quit policy, terminals, debugging or runtime. */
function captureRestorationWorkspaceState(): RestorationWorkspaceState {
    if (!vscode.workspace.isTrusted) throw new ColabEnvironmentError('workspace_untrusted', 'Trust this Workspace before restored-workspace preparation.');
    const workspaceFile = vscode.workspace.workspaceFile;
    if (!workspaceFile || !['file', 'untitled'].includes(workspaceFile.scheme) || workspaceFile.authority || workspaceFile.query || workspaceFile.fragment || workspaceFile.toString().length > 4096) {
        throw new ColabEnvironmentError('configured_workspace_required', 'Restored-workspace preparation requires one local configured file or untitled Workspace.');
    }
    if (workspaceFile.scheme === 'file' && (!path.isAbsolute(workspaceFile.fsPath) || !workspaceFile.fsPath.toLowerCase().endsWith('.code-workspace'))) {
        throw new ColabEnvironmentError('configured_workspace_required', 'The configured Workspace must be an absolute local .code-workspace file.');
    }
    const folders = [...(vscode.workspace.workspaceFolders ?? [])];
    if (!folders.length || folders.length > 64) throw new ColabEnvironmentError('workspace_roots_unsupported', 'The configured Workspace must contain between one and 64 local roots.');
    const roots = folders.map(folder => {
        if (folder.uri.scheme !== 'file' || folder.uri.authority || folder.uri.query || folder.uri.fragment ||
            !path.isAbsolute(folder.uri.fsPath) || folder.uri.toString().length > 4096 || !folder.name || folder.name.length > 512) {
            throw new ColabEnvironmentError('workspace_roots_unsupported', 'Every Workspace root must be a bounded local file URI with a bounded name.');
        }
        return { uri: folder.uri.toString(), name: folder.name };
    });
    return { schema: 1, workspace: { uri: workspaceFile.toString(), kind: workspaceFile.scheme as 'file' | 'untitled', roots } };
}

/** Capture only the resource graph that VS Code promises to restore. Loaded
 * document objects are intentionally excluded from post-launch comparison. */
function captureRestoredResourceState(): RestorationResourceState {
    const workspace = captureRestorationWorkspaceState();
    let tabCount = 0;
    const tabGroups = vscode.window.tabGroups.all.map(group => {
        tabCount += group.tabs.length;
        if (tabCount > MAX_RESTORE_ITEMS) throw new ColabEnvironmentError('tab_inventory_unbounded', 'The tab inventory exceeded the restored-workspace bound.');
        return [...group.tabs].map(tab => {
            if (tab.isDirty) throw new ColabEnvironmentError('dirty_tab_present', 'Dirty tabs prevent restored-workspace verification.');
            return restorationTabIdentity(tab.input);
        }).sort(compareJson);
    }).filter(group => group.length > 0).sort(compareJson);
    return { ...workspace, tabGroups };
}

function captureRestorationPublicState(): RestorationPublicState {
    const workspace = captureRestorationWorkspaceState();
    const restoreWindows = classifyRestoreWindows(vscode.workspace.getConfiguration('window').get<string>('restoreWindows'));
    if (restoreWindows !== 'all' && restoreWindows !== 'preserve') {
        throw new ColabEnvironmentError('restore_policy_unsupported', 'Restored-workspace restart requires window.restoreWindows to resolve to all or preserve.');
    }
    if (vscode.workspace.getConfiguration('window').get<string>('confirmBeforeClose') !== 'never') {
        throw new ColabEnvironmentError('close_confirmation_unsupported', 'Restored-workspace restart requires window.confirmBeforeClose to resolve to never.');
    }
    if (vscode.debug.activeDebugSession) throw new ColabEnvironmentError('debug_session_present', 'Stop debugging before restored-workspace restart.');
    if (vscode.window.terminals.length) throw new ColabEnvironmentError('terminal_present', 'Integrated terminals prevent restored-workspace restart; no terminal is closed automatically.');

    const notebooks = [...vscode.workspace.notebookDocuments];
    const texts = [...vscode.workspace.textDocuments];
    if (notebooks.length > MAX_RESTORE_ITEMS || texts.length > MAX_RESTORE_ITEMS) {
        throw new ColabEnvironmentError('document_inventory_unbounded', 'The open document inventory exceeded the restored-workspace bound.');
    }
    if (notebooks.some(document => document.isDirty || document.isUntitled || document.uri.scheme !== 'file')) {
        throw new ColabEnvironmentError('open_notebook_unsupported', 'Every open notebook must be saved and file-backed before restored-workspace restart.');
    }
    if (texts.some(document => document.isDirty || document.isUntitled)) {
        throw new ColabEnvironmentError('open_document_unsupported', 'Dirty or untitled text documents prevent restored-workspace restart.');
    }
    const textDocuments = texts.filter(document => document.uri.scheme === 'file').map(document => {
        if (!Number.isSafeInteger(document.version) || document.version < 0 || document.uri.toString().length > 4096) {
            throw new ColabEnvironmentError('document_inventory_invalid', 'A text-document identity or version was invalid.');
        }
        return { uri: document.uri.toString(), version: document.version };
    }).sort(compareUriVersion);
    const notebookDocuments = notebooks.map(document => {
        if (!Number.isSafeInteger(document.version) || document.version < 0 || document.uri.toString().length > 4096) {
            throw new ColabEnvironmentError('document_inventory_invalid', 'A notebook identity or version was invalid.');
        }
        return { uri: document.uri.toString(), version: document.version };
    }).sort(compareUriVersion);

    let tabCount = 0;
    const tabGroups = vscode.window.tabGroups.all.map(group => {
        tabCount += group.tabs.length;
        if (tabCount > MAX_RESTORE_ITEMS) throw new ColabEnvironmentError('tab_inventory_unbounded', 'The tab inventory exceeded the restored-workspace bound.');
        return [...group.tabs].map(tab => {
            if (tab.isDirty) throw new ColabEnvironmentError('dirty_tab_present', 'Dirty tabs prevent restored-workspace restart.');
            return restorationTabIdentity(tab.input);
        }).sort(compareJson);
    }).filter(group => group.length > 0).sort(compareJson);

    return {
        ...workspace,
        tabGroups,
        documents: { text: textDocuments, notebooks: notebookDocuments }
    };
}

function restorationTabIdentity(input: unknown): RestorationTab {
    const localUri = (uri: vscode.Uri): string => {
        if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment || !path.isAbsolute(uri.fsPath) || uri.toString().length > 4096) {
            throw new ColabEnvironmentError('tab_input_unsupported', 'Every restored tab input must use a bounded local file URI.');
        }
        return uri.toString();
    };
    if (input instanceof vscode.TabInputText) return { kind: 'text', uri: localUri(input.uri) };
    if (input instanceof vscode.TabInputNotebook) {
        if (!input.notebookType || input.notebookType.length > 256) throw new ColabEnvironmentError('tab_input_unsupported', 'Notebook tab type was invalid.');
        return { kind: 'notebook', uri: localUri(input.uri), notebookType: input.notebookType };
    }
    if (input instanceof vscode.TabInputCustom) {
        if (!input.viewType || input.viewType.length > 256) throw new ColabEnvironmentError('tab_input_unsupported', 'Custom tab type was invalid.');
        return { kind: 'custom', uri: localUri(input.uri), viewType: input.viewType };
    }
    if (input instanceof vscode.TabInputTextDiff) {
        return { kind: 'text-diff', original: localUri(input.original), modified: localUri(input.modified) };
    }
    if (input instanceof vscode.TabInputNotebookDiff) {
        if (!input.notebookType || input.notebookType.length > 256) throw new ColabEnvironmentError('tab_input_unsupported', 'Notebook diff type was invalid.');
        return { kind: 'notebook-diff', original: localUri(input.original), modified: localUri(input.modified), notebookType: input.notebookType };
    }
    throw new ColabEnvironmentError('tab_input_unsupported', 'Webviews, terminals, virtual resources and unknown tab inputs cannot be restored by this bounded mode.');
}

function compareJson(left: unknown, right: unknown): number { return JSON.stringify(left).localeCompare(JSON.stringify(right)); }
function compareUriVersion(left: { uri: string; version: number }, right: { uri: string; version: number }): number {
    return left.uri.localeCompare(right.uri) || left.version - right.version;
}
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function sameWorkspaceStructure(left: RestorationWorkspaceState['workspace'], right: RestorationWorkspaceState['workspace']): boolean { return sameJson(left, right); }

function assertSameRestorationWorkspace(expected: RestorationWorkspaceState, actual: RestorationWorkspaceState): void {
    if (!sameWorkspaceStructure(expected.workspace, actual.workspace)) {
        throw new ColabEnvironmentError('restoration_snapshot_changed', 'The configured Workspace identity or ordered roots changed during restored-workspace preparation.');
    }
}

function assertSameRestoredResources(expected: RestorationResourceState | RestorationSnapshot, actual: RestorationResourceState): void {
    if (!sameWorkspaceStructure(expected.workspace, actual.workspace) || !sameJson(expected.tabGroups, actual.tabGroups)) {
        throw new ColabEnvironmentError('restoration_snapshot_changed', 'Workspace roots or tab resource membership changed during restored-workspace restart.');
    }
}

function assertSameRestorationPublicState(
    expected: RestorationPublicState | RestorationSnapshot,
    actual: RestorationPublicState
): void {
    const expectedPublic = { schema: expected.schema, workspace: expected.workspace, tabGroups: expected.tabGroups, documents: expected.documents };
    assertSameRestoredResources(expectedPublic, actual);
    if (!sameJson(expectedPublic.documents, actual.documents)) {
        throw new ColabEnvironmentError('restoration_documents_changed', 'Open document identities or pre-quit versions changed during restored-workspace restart.');
    }
}

function assertRestorationSnapshotSize(snapshot: RestorationSnapshot): void {
    if (Buffer.byteLength(JSON.stringify(snapshot)) >= MAX_FILE_BYTES) {
        throw new ColabEnvironmentError('restoration_snapshot_too_large', 'The restoration snapshot exceeded its bounded receipt budget.');
    }
}

function assertRestoredReceiptHeadroom(receipt: Receipt): void {
    if (Buffer.byteLength(JSON.stringify(receipt)) >= MAX_FILE_BYTES - RESTORED_RECEIPT_HEADROOM_BYTES) {
        throw new ColabEnvironmentError('preparation_receipt_too_large', 'The restored-workspace receipt left insufficient bounded helper/failure headroom.');
    }
    if (!validateReceipt(receipt)) {
        throw new ColabEnvironmentError('preparation_receipt_invalid', 'The restored-workspace receipt failed strict validation before helper arming.');
    }
}

function restorationWindowLabel(snapshot: RestorationWorkspaceState): string {
    return snapshot.workspace.roots.map(root => root.name).join(', ').slice(0, 512) || 'workspace';
}

export async function inspectSavedStateMetadataForTest(userDataDir: string, workspaceFile: vscode.Uri): Promise<SavedStateSnapshot> {
    return inspectSavedStateMetadata(userDataDir, workspaceFile);
}

async function inspectSavedStateMetadata(userDataDir: string, workspaceFile: vscode.Uri): Promise<SavedStateSnapshot> {
    const workspacesRoot = path.join(userDataDir, 'Workspaces');
    let entries: Array<{ name: string; kind: 'file' | 'directory' }>;
    try {
        const observed = await fs.readdir(workspacesRoot, { withFileTypes: true });
        if (observed.length > 64) throw new Error('unbounded');
        entries = observed.map(entry => {
            if (!entry.name || entry.name.length > 255 || (!entry.isFile() && !entry.isDirectory())) throw new Error('unsupported entry');
            return { name: entry.name, kind: entry.isDirectory() ? 'directory' as const : 'file' as const };
        }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
        throw new ColabEnvironmentError('restoration_metadata_unavailable', 'The default-profile untitled Workspace registry was missing, malformed or unbounded.');
    }
    if (workspaceFile.scheme === 'file') {
        if (entries.length !== 0) throw new ColabEnvironmentError('other_untitled_workspace_present', 'Another untitled Workspace is registered in the default profile.');
    } else {
        const relative = path.relative(workspacesRoot, path.resolve(workspaceFile.fsPath));
        const first = relative.split(/[\\/]+/)[0];
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !first || entries.length !== 1 || entries[0].name !== first) {
            throw new ColabEnvironmentError('untitled_workspace_ambiguous', 'The current untitled Workspace did not uniquely match the default-profile Workspace registry.');
        }
    }

    const storagePath = path.join(userDataDir, 'User', 'globalStorage', 'storage.json');
    let storage: any;
    try {
        const bytes = await fs.readFile(storagePath);
        if (!bytes.length || bytes.length > MAX_STATE_METADATA_BYTES) throw new Error('unbounded');
        storage = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new ColabEnvironmentError('restoration_metadata_unavailable', 'The default-profile backup registry metadata was missing, malformed or unbounded.');
    }
    const registry = storage && typeof storage === 'object' && !Array.isArray(storage) ? storage.backupWorkspaces : undefined;
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
        throw new ColabEnvironmentError('restoration_metadata_unavailable', 'The backupWorkspaces registry metadata was missing or malformed.');
    }
    const workspaces = boundedRegistryArray(registry.workspaces, 'workspace');
    const folders = boundedRegistryArray(registry.folders, 'folder');
    const emptyWindows = boundedRegistryArray(registry.emptyWindows, 'empty');
    if (emptyWindows.length !== 0) throw new ColabEnvironmentError('empty_window_backup_present', 'A registered empty-window backup prevents unambiguous single-Workspace restoration.');
    return { untitledWorkspaces: entries, backupRegistry: { workspaces: workspaces.length, folders: folders.length, emptyWindows: 0 } };
}

function boundedRegistryArray(value: unknown, kind: 'workspace' | 'folder' | 'empty'): any[] {
    if (!Array.isArray(value) || value.length > MAX_RESTORE_ITEMS) throw new ColabEnvironmentError('restoration_metadata_unavailable', 'Backup registry metadata was malformed or unbounded.');
    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ColabEnvironmentError('restoration_metadata_unavailable', 'Backup registry entry was malformed.');
        const record = item as Record<string, unknown>;
        const required = kind === 'workspace' ? ['id', 'configURIPath'] : kind === 'folder' ? ['folderUri'] : ['backupFolder'];
        if (required.some(key => typeof record[key] !== 'string' || !(record[key] as string).length || (record[key] as string).length > 4096) ||
            (record.remoteAuthority !== undefined && (typeof record.remoteAuthority !== 'string' || record.remoteAuthority.length > 256))) {
            throw new ColabEnvironmentError('restoration_metadata_unavailable', 'Backup registry entry was malformed.');
        }
    }
    return value;
}

function assertWorkspaceConversionSafe(): void {
    if (vscode.debug.activeDebugSession) throw new ColabEnvironmentError('debug_session_present', 'Stop debugging before preparing the workspace.');
    if (vscode.workspace.notebookDocuments.length || vscode.window.visibleNotebookEditors.length || vscode.window.activeNotebookEditor) {
        throw new ColabEnvironmentError('open_notebook_present', 'Prepare the workspace before opening notebooks; conversion refreshes the extension host.');
    }
    if (vscode.window.terminals.length) throw new ColabEnvironmentError('terminal_present', 'Inspect restored terminals and close only authorized explicit references before workspace preparation.');
    if (vscode.workspace.textDocuments.some(document => document.isDirty || document.isUntitled || document.uri.scheme === 'file') ||
        vscode.window.visibleTextEditors.length || vscode.window.activeTextEditor) {
        throw new ColabEnvironmentError('open_document_present', 'Close user documents before workspace preparation.');
    }
    const tabs = vscode.window.tabGroups.all.flatMap(group => [...group.tabs]);
    if (tabs.some(tab => tab.label !== 'Welcome' || tab.input !== undefined || tab.isDirty)) {
        throw new ColabEnvironmentError('editor_present', 'Close editor tabs before workspace preparation.');
    }
}

export function resolveLocalGlobalStoragePathForTest(
    context: Pick<ColabEnvironmentContextForTest, 'globalStorageUri' | 'extension'>,
    dependencies: Pick<ColabEnvironmentDependenciesForTest, 'platform' | 'env'>
): string {
    return resolveLocalGlobalStoragePath(context, dependencies);
}

function resolveLocalGlobalStoragePath(
    context: Pick<ColabEnvironmentContextForTest, 'globalStorageUri' | 'extension'>,
    dependencies: Pick<ColabEnvironmentDependenciesForTest, 'platform' | 'env'>
): string {
    const uri = context.globalStorageUri;
    if (uri.authority || uri.query || uri.fragment) {
        throw new ColabEnvironmentError('local_storage_required', 'Automatic Colab environment preparation requires unambiguous local extension storage.');
    }
    const segments = uri.path.replace(/\\/g, '/').split('/');
    if (segments.some(segment => segment === '.' || segment === '..')) {
        throw new ColabEnvironmentError('local_storage_required', 'Automatic Colab environment preparation rejects relative extension storage paths.');
    }
    const storagePath = uri.fsPath;
    if (uri.scheme === 'file') {
        const absolute = dependencies.platform === 'win32' ? path.win32.isAbsolute(storagePath) : path.posix.isAbsolute(storagePath);
        const nonLocal = dependencies.platform === 'win32' && (storagePath.startsWith('\\\\') || !/^[A-Za-z]:[\\/]/.test(storagePath));
        if (!absolute || nonLocal) throw new ColabEnvironmentError('local_storage_required', 'Automatic Colab environment preparation requires an absolute local extension storage path.');
        return dependencies.platform === 'win32' ? path.win32.resolve(storagePath) : path.posix.resolve(storagePath);
    }
    if (uri.scheme !== 'vscode-userdata' || dependencies.platform !== 'win32' ||
        !/^\/[A-Za-z]:\//.test(uri.path.replace(/\\/g, '/')) || storagePath.startsWith('\\\\')) {
        throw new ColabEnvironmentError('local_storage_required', 'Automatic Colab environment preparation does not recognize this extension storage location as local.');
    }
    const appData = dependencies.env.APPDATA;
    if (!appData || !path.win32.isAbsolute(appData)) {
        throw new ColabEnvironmentError('local_storage_required', 'The local Windows user-data root is unavailable.');
    }
    const expected = path.win32.resolve(appData, 'Code', 'User', 'globalStorage', context.extension.id.toLowerCase());
    if (path.win32.resolve(storagePath).toLowerCase() !== expected.toLowerCase()) {
        throw new ColabEnvironmentError('local_storage_required', 'The VS Code user-data URI does not map to this extension in the default local profile.');
    }
    return path.win32.resolve(storagePath);
}

function inspectWindowIdentity(
    context: Pick<ColabEnvironmentContextForTest, 'logUri' | 'extension'>,
    dependencies: Pick<ColabEnvironmentDependenciesForTest, 'platform' | 'env' | 'vscodeVersion'>,
    application: ColabEnvironmentPreflightLocal['application']
): ColabEnvironmentPreflightLocal['windowIdentity'] {
    const base: ColabEnvironmentPreflightLocal['windowIdentity'] = {
        source: 'extension_log_uri',
        status: 'unavailable',
        sourceVersion: SUPPORTED_VERSION,
        sourceCommit: SUPPORTED_COMMIT,
        nativeWindowId: null,
        rendererProcessPid: null,
        observedNativeWindowIds: [],
        failureCode: 'window_identity_unavailable'
    };
    if (dependencies.vscodeVersion !== SUPPORTED_VERSION || application.version !== SUPPORTED_VERSION) {
        return { ...base, status: 'unsupported', failureCode: 'window_identity_version_unsupported' };
    }
    if (application.commit !== SUPPORTED_COMMIT) {
        return { ...base, status: 'unsupported', failureCode: 'window_identity_commit_unsupported' };
    }
    if (application.defaultInstall !== 'verified' || application.mainProcessIdentity !== 'verified' || dependencies.platform !== 'win32') {
        return { ...base, failureCode: 'window_identity_application_unverified' };
    }
    if (context.extension.id.toLowerCase() !== SUPPORTED_EXTENSION_ID.toLowerCase()) {
        return { ...base, status: 'unsupported', failureCode: 'window_identity_extension_unsupported' };
    }
    const rows = application.nativeWindows;
    const ids = rows.map(row => row.id);
    const rendererPids = rows.map(row => row.rendererProcessPid);
    if (application.actualWindowCount === null || rows.length !== application.actualWindowCount || rows.length > MAX_NATIVE_WINDOWS ||
        rows.some(row => !Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isSafeInteger(row.rendererProcessPid) || row.rendererProcessPid <= 0) ||
        new Set(ids).size !== ids.length || new Set(rendererPids).size !== rendererPids.length) {
        return { ...base, status: 'mismatch', failureCode: 'window_identity_native_rows_invalid' };
    }
    base.observedNativeWindowIds = [...ids].sort((left, right) => left - right);
    let nativeWindowId: number;
    try {
        nativeWindowId = nativeWindowIdFromLogUri(context, dependencies);
    } catch (error) {
        return {
            ...base,
            observedNativeWindowIds: base.observedNativeWindowIds,
            failureCode: error instanceof ColabEnvironmentError ? error.code : 'window_identity_log_uri_invalid'
        };
    }
    const matches = rows.filter(row => row.id === nativeWindowId);
    if (matches.length !== 1) {
        return {
            ...base,
            status: 'mismatch',
            observedNativeWindowIds: base.observedNativeWindowIds,
            failureCode: 'window_identity_status_row_mismatch'
        };
    }
    return {
        ...base,
        status: 'verified',
        nativeWindowId,
        rendererProcessPid: matches[0].rendererProcessPid,
        observedNativeWindowIds: base.observedNativeWindowIds,
        failureCode: null
    };
}

function nativeWindowIdFromLogUri(
    context: Pick<ColabEnvironmentContextForTest, 'logUri' | 'extension'>,
    dependencies: Pick<ColabEnvironmentDependenciesForTest, 'platform' | 'env'>
): number {
    const uri = context.logUri;
    const appData = dependencies.env.APPDATA;
    if (dependencies.platform !== 'win32' || !appData || !path.win32.isAbsolute(appData) ||
        uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment ||
        !path.win32.isAbsolute(uri.fsPath) || uri.fsPath.startsWith('\\\\')) {
        throw new ColabEnvironmentError('window_identity_log_uri_invalid', 'The extension log URI is not an unambiguous local default-profile file URI.');
    }
    const uriSegments = uri.path.replace(/\\/g, '/').split('/');
    if (uriSegments.some(segment => segment === '.' || segment === '..')) {
        throw new ColabEnvironmentError('window_identity_log_uri_invalid', 'The extension log URI contains a relative path segment.');
    }
    const logsRoot = path.win32.resolve(appData, 'Code', 'logs');
    const logPath = path.win32.resolve(uri.fsPath);
    const relative = path.win32.relative(logsRoot, logPath);
    if (!relative || relative.startsWith('..') || path.win32.isAbsolute(relative)) {
        throw new ColabEnvironmentError('window_identity_log_uri_invalid', 'The extension log URI is outside the default stable profile log root.');
    }
    const segments = relative.split(/[\\/]+/);
    if (segments.length !== 4 || !segments[0] || segments[0] === '.' || segments[0] === '..' ||
        segments[2] !== 'exthost' || segments[3] !== context.extension.id) {
        throw new ColabEnvironmentError('window_identity_log_uri_invalid', 'The extension log URI does not have the reviewed window/exthost/extension suffix.');
    }
    const match = /^window([1-9]\d*)$/.exec(segments[1]);
    const windowId = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(windowId) || windowId <= 0) {
        throw new ColabEnvironmentError('window_identity_log_uri_invalid', 'The extension log URI does not contain a positive safe window identifier.');
    }
    return windowId;
}

async function resolveRequestedFolder(value: string): Promise<{ uri: string; requestedUri: string; label: string; path: string }> {
    if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('file:///')) {
        throw new ColabEnvironmentError('folder_uri_invalid', 'folderUri must be an absolute local file URI.');
    }
    let uri: vscode.Uri;
    try { uri = vscode.Uri.parse(value, true); }
    catch { throw new ColabEnvironmentError('folder_uri_invalid', 'folderUri is malformed.'); }
    if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment || !path.isAbsolute(uri.fsPath) ||
        uri.fsPath.includes('\0') || (process.platform === 'win32' && uri.fsPath.startsWith('\\\\'))) {
        throw new ColabEnvironmentError('folder_uri_invalid', 'folderUri must identify one local folder without an authority, query or fragment.');
    }
    const requestedUri = uri.toString();
    let folderPath: string;
    try {
        folderPath = await fs.realpath(uri.fsPath);
        if (process.platform === 'win32' && folderPath.startsWith('\\\\')) {
            throw new ColabEnvironmentError('folder_uri_invalid', 'folderUri must resolve to a local directory, not a network share.');
        }
        if (!await fs.stat(folderPath).then(stat => stat.isDirectory())) {
            throw new ColabEnvironmentError('folder_not_directory', 'folderUri must identify an existing directory.');
        }
    } catch (error) {
        if (error instanceof ColabEnvironmentError) throw error;
        throw new ColabEnvironmentError('folder_unavailable', 'The requested local folder is unavailable.');
    }
    return { uri: vscode.Uri.file(folderPath).toString(), requestedUri, label: path.basename(folderPath) || folderPath, path: folderPath };
}

async function assertCleanEmptyWindow(): Promise<void> {
    const confirmBeforeClose = vscode.workspace.getConfiguration('window').get<string>('confirmBeforeClose');
    if (confirmBeforeClose !== 'never') {
        throw new ColabEnvironmentError('close_confirmation_unsupported', 'Automatic restart requires window.confirmBeforeClose to be explicitly resolved as never.');
    }
    if (vscode.debug.activeDebugSession) {
        throw new ColabEnvironmentError('debug_session_present', 'Stop the active debug session before automatic VS Code restart.');
    }
    if (vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFile) throw new ColabEnvironmentError('empty_window_required', 'Automatic restart is limited to one truly empty VS Code window.');
    if (vscode.workspace.notebookDocuments.length || vscode.window.visibleNotebookEditors.length || vscode.window.activeNotebookEditor) {
        throw new ColabEnvironmentError('open_notebook_present', 'Close all notebooks before automatic VS Code restart.');
    }
    if (vscode.window.terminals.length) throw new ColabEnvironmentError('terminal_present', 'Integrated terminals prevent automatic VS Code restart. Inspect them with list_colab_terminals; close only authorized explicit references with close_colab_terminals, then retry preparation. Terminal metadata does not establish idleness.');
    if (vscode.workspace.textDocuments.some(document => document.isDirty || document.isUntitled || document.uri.scheme === 'file') ||
        vscode.window.visibleTextEditors.length || vscode.window.activeTextEditor) {
        throw new ColabEnvironmentError('open_document_present', 'Close all user documents before automatic VS Code restart.');
    }
    let tabs = vscode.window.tabGroups.all.flatMap(group => [...group.tabs]);
    if (tabs.length === 1 && tabs[0].label === 'Welcome' && tabs[0].input === undefined && !tabs[0].isDirty) {
        const closed = await vscode.window.tabGroups.close(tabs[0], true);
        if (!closed) throw new ColabEnvironmentError('editor_present', 'The benign Welcome tab could not be closed.');
        tabs = vscode.window.tabGroups.all.flatMap(group => [...group.tabs]);
    }
    if (tabs.length) throw new ColabEnvironmentError('editor_present', 'Close all editor tabs before automatic VS Code restart.');
}

export function parseCodeStatusForTest(text: string, expectedPid: number): ParsedCodeStatus { return parseCodeStatus(text, expectedPid); }
function parseCodeStatus(text: string, expectedPid: number): ParsedCodeStatus {
    if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0 || Buffer.byteLength(text) > 512 * 1024 || text.includes('\0')) {
        throw new ColabEnvironmentError('status_unparseable', 'VS Code status output was invalid.');
    }
    const versionMatch = text.match(/^Version:\s+Code\s+(\d+\.\d+\.\d+)\s+\(([0-9a-f]{40}),/m);
    const argsMatch = text.match(/^Process Argv:[ \t]*(.*)$/m);
    if (!versionMatch || !argsMatch) throw new ColabEnvironmentError('status_unparseable', 'VS Code status output did not contain the expected identity fields.');
    const rows = text.split(/\r?\n/).map(line => line.match(/^\s*\d+\s+\d+\s+(\d+)\s+(.+?)\s*$/)).filter((match): match is RegExpMatchArray => !!match);
    const main = rows.filter(row => Number(row[1]) === expectedPid && row[2] === 'code');
    if (main.length !== 1) throw new ColabEnvironmentError('main_process_unverified', 'VS Code status did not identify the expected primary process.');
    const windows = rows.flatMap(row => {
        const match = row[2].match(/^window \[(\d+)\] \(([^\r\n]*)\)$/);
        return match ? [{ id: Number(match[1]), pid: Number(row[1]), title: match[2] }] : [];
    });
    if (windows.some(window => !Number.isSafeInteger(window.id) || !Number.isSafeInteger(window.pid))) throw new ColabEnvironmentError('status_unparseable', 'VS Code status contained an invalid window row.');
    const processArgsLine = argsMatch[1].trim();
    return { version: versionMatch[1], commit: versionMatch[2], processArgs: processArgsLine ? processArgsLine.split(/\s+/) : [], processArgsLine, mainPid: expectedPid, windows };
}

function assertSafeInitialArgs(args: string[]): void {
    const remaining = [...args];
    const newWindow = remaining.indexOf('--new-window');
    if (newWindow >= 0) remaining.splice(newWindow, 1);
    if (!remaining.length) return;
    if (remaining.length === 2 && remaining[0] === '--crash-reporter-id' && /^[0-9a-f-]{36}$/i.test(remaining[1])) return;
    throw new ColabEnvironmentError('startup_arguments_unsupported', 'Automatic restart requires the ordinary default VS Code startup arguments.');
}

function withoutCrashReporter(args: string[]): string[] {
    const remaining = [...args];
    const indices = remaining.flatMap((value, index) => value === '--crash-reporter-id' ? [index] : []);
    if (indices.length > 1) throw new ColabEnvironmentError('startup_arguments_unsupported', 'VS Code startup arguments were ambiguous.');
    if (indices.length === 1) {
        const index = indices[0];
        if (!/^[0-9a-f-]{36}$/i.test(remaining[index + 1] ?? '')) throw new ColabEnvironmentError('startup_arguments_unsupported', 'VS Code crash reporter arguments were malformed.');
        remaining.splice(index, 2);
    }
    return remaining;
}

function assertSafeRestoredInitialArgs(args: string[], snapshot: RestorationWorkspaceState): void {
    const remaining = withoutCrashReporter(args);
    const newWindows = remaining.filter(value => value === '--new-window').length;
    if (newWindows > 1) throw new ColabEnvironmentError('startup_arguments_unsupported', 'Multiple --new-window arguments are unsupported.');
    if (newWindows === 1) remaining.splice(remaining.indexOf('--new-window'), 1);
    if (!remaining.length) return;
    if (remaining.length !== 1 || remaining[0].startsWith('-') || /\s/.test(remaining[0])) {
        throw new ColabEnvironmentError('startup_arguments_unsupported', 'Only one unambiguous current Workspace/root positional path is accepted.');
    }
    const candidates = snapshot.workspace.roots.map(root => vscode.Uri.parse(root.uri).fsPath);
    if (snapshot.workspace.kind === 'file') candidates.push(vscode.Uri.parse(snapshot.workspace.uri).fsPath);
    if (!candidates.some(candidate => samePath(candidate, remaining[0]))) {
        throw new ColabEnvironmentError('startup_arguments_unsupported', 'The positional startup path did not match this configured Workspace.');
    }
}

function assertRestoredLaunchArgs(processArgsLine: string, receipt: Receipt): void {
    const crash = /(?:^| )--crash-reporter-id ([0-9a-f-]{36})(?= |$)/ig;
    const matches = [...processArgsLine.matchAll(crash)];
    if (matches.length > 1) throw new ColabEnvironmentError('startup_arguments_unsupported', 'VS Code startup arguments were ambiguous.');
    let remaining = processArgsLine;
    if (matches.length === 1) {
        const match = matches[0];
        remaining = `${remaining.slice(0, match.index!)}${remaining.slice(match.index! + match[0].length)}`.trim();
    }
    const expected = [
        '--user-data-dir', receipt.userDataDir!,
        '--extensions-dir', receipt.extensionsDir!,
        `--remote-debugging-port=${receipt.port}`
    ].join(' ');
    if (remaining !== expected) {
        throw new ColabEnvironmentError('startup_arguments_unsupported', 'The restored VS Code process did not use the fixed approved launch arguments.');
    }
}

function assertFreshRestoredProcess(receipt: Receipt, current: ProcessIdentity, observedAt: number): void {
    if (!receipt.main || current.pid === receipt.main.pid || sameProcess(current, receipt.main) ||
        !Number.isSafeInteger(receipt.preSpawnAt) || !Number.isSafeInteger(receipt.launchedAt) ||
        receipt.preSpawnAt! < receipt.createdAt || receipt.launchedAt! < receipt.preSpawnAt! || receipt.launchedAt! > receipt.deadline ||
        !Number.isSafeInteger(receipt.launchPid) || receipt.launchPid! <= 0) {
        throw new ColabEnvironmentError('restored_process_unverified', 'The restored VS Code main process was not distinct from the approved prior process.');
    }
    const createdAt = Date.parse(current.creationTime);
    if (!Number.isFinite(createdAt) || createdAt + PROCESS_TIME_PRECISION_MS < receipt.preSpawnAt! ||
        createdAt - PROCESS_TIME_PRECISION_MS > observedAt || receipt.preSpawnAt! > observedAt + PROCESS_TIME_PRECISION_MS) {
        throw new ColabEnvironmentError('restored_process_unverified', 'The restored VS Code process creation time was outside the bounded pre-spawn observation interval.');
    }
}

export function validateDefaultWindowsInstallForTest(input: Parameters<typeof validateDefaultWindowsInstall>[0]): InstallIdentity {
    return validateDefaultWindowsInstall(input);
}
function validateDefaultWindowsInstall(input: {
    platform: NodeJS.Platform; version: string; execPath: string; env: NodeJS.ProcessEnv; globalStoragePath: string;
    extensionPath: string; extensionId: string; appHost: string; remoteName?: string;
}): InstallIdentity {
    if (input.platform !== 'win32') throw new ColabEnvironmentError('automatic_restart_windows_only', 'Automatic missing-port bootstrap is supported only for installed Windows VS Code in this release.');
    if (input.version !== SUPPORTED_VERSION) throw new ColabEnvironmentError('unsupported_vscode_version', `Automatic restart is pinned to VS Code ${SUPPORTED_VERSION}.`);
    if (input.appHost !== 'desktop' || input.remoteName) throw new ColabEnvironmentError('remote_host_unsupported', 'Automatic restart requires the local desktop extension host.');
    if (input.env.VSCODE_PORTABLE) throw new ColabEnvironmentError('profile_unsupported', 'Portable VS Code is outside the bounded automatic restart path.');
    const appData = input.env.APPDATA, localAppData = input.env.LOCALAPPDATA, userProfile = input.env.USERPROFILE;
    if (!appData || !localAppData || !userProfile) throw new ColabEnvironmentError('profile_unverified', 'The default Windows VS Code profile paths are unavailable.');
    const executablePath = path.resolve(input.execPath);
    const expectedExecutable = path.resolve(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe');
    if (!samePath(executablePath, expectedExecutable)) {
        throw new ColabEnvironmentError('installation_unsupported', 'The running executable is not the default stable Microsoft VS Code installation.');
    }
    const userDataDir = path.resolve(appData, 'Code');
    const expectedStorage = path.join(userDataDir, 'User', 'globalStorage', input.extensionId.toLowerCase());
    if (!samePath(input.globalStoragePath, expectedStorage)) throw new ColabEnvironmentError('profile_unsupported', 'The extension is not using the default stable VS Code profile.');
    const extensionsDir = path.resolve(userProfile, '.vscode', 'extensions');
    const relative = path.relative(extensionsDir, path.resolve(input.extensionPath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
        throw new ColabEnvironmentError('extensions_path_unverified', 'The extension installation is not under the default VS Code extensions directory.');
    }
    return { executablePath, userDataDir, extensionsDir };
}

async function runCodeStatus(executablePath: string): Promise<string> {
    const cliPath = await resolveInstalledCodeCli(executablePath);
    const env = cleanChildEnvironment(process.env);
    env.ELECTRON_RUN_AS_NODE = '1';
    if (process.env.VSCODE_IPC_HOOK_CLI) env.VSCODE_IPC_HOOK_CLI = process.env.VSCODE_IPC_HOOK_CLI;
    return new Promise((resolve, reject) => execFile(executablePath, [cliPath, '--status'], { env, windowsHide: true, timeout: 12_000, maxBuffer: 512 * 1024 }, (error, stdout) => {
        if (error) reject(new ColabEnvironmentError('status_unavailable', 'The installed VS Code status command failed.')); else resolve(stdout);
    }));
}

export async function resolveInstalledCodeCliForTest(executablePath: string): Promise<string> { return resolveInstalledCodeCli(executablePath); }
async function resolveInstalledCodeCli(executablePath: string): Promise<string> {
    const installRoot = path.dirname(path.resolve(executablePath));
    const commandPath = path.join(installRoot, 'bin', 'code.cmd');
    let command: string;
    try {
        const bytes = await fs.readFile(commandPath);
        if (bytes.length > MAX_FILE_BYTES) throw new Error('code.cmd too large');
        command = bytes.toString('utf8');
    } catch {
        throw new ColabEnvironmentError('status_unavailable', 'The installed VS Code CLI launcher could not be verified.');
    }
    const matches = [...command.matchAll(/^"%~dp0\.\.\\Code\.exe"[ \t]+"%~dp0\.\.\\([0-9a-f]{10})\\resources\\app\\out\\cli\.js"[ \t]+%\*[ \t]*$/gmi)];
    if (matches.length !== 1) throw new ColabEnvironmentError('status_unavailable', 'The installed VS Code CLI launcher shape was not recognized uniquely.');
    const cliPath = path.resolve(installRoot, matches[0][1], 'resources', 'app', 'out', 'cli.js');
    const relative = path.relative(installRoot, cliPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ColabEnvironmentError('status_unavailable', 'The installed VS Code CLI path escaped its installation.');
    try {
        const stat = await fs.stat(cliPath);
        if (!stat.isFile()) throw new Error('not a file');
    } catch {
        throw new ColabEnvironmentError('status_unavailable', 'The installed VS Code CLI entry point was missing.');
    }
    return cliPath;
}

async function inspectProcess(pid: number): Promise<ProcessIdentity | undefined> {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = buildProcessIdentityPowerShellForTest(pid);
    return new Promise((resolve, reject) => execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 }, (error, stdout) => {
        if (error) { reject(new ColabEnvironmentError('main_process_unverified', 'The VS Code process identity query failed.')); return; }
        const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!lines.length) { resolve(undefined); return; }
        if (lines.length !== 2 || Number.isNaN(Date.parse(lines[1]))) { reject(new ColabEnvironmentError('main_process_unverified', 'The VS Code process identity response was malformed.')); return; }
        resolve({ pid, executablePath: path.resolve(lines[0]), creationTime: lines[1] });
    }));
}

export function buildProcessIdentityPowerShellForTest(pid: number, cimClass = 'Win32_Process'): string {
    if (!Number.isSafeInteger(pid) || pid < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cimClass)) throw new Error('invalid process identity query');
    return `$ErrorActionPreference='Stop';try{$p=Get-CimInstance -ClassName ${cimClass} -Filter "ProcessId=${pid}" -ErrorAction Stop;if($null -ne $p){$p.ExecutablePath;$p.CreationDate.ToUniversalTime().ToString('o')};exit 0}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 17}`;
}

async function reservePort(requestedPort = 0): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: requestedPort, exclusive: true }, () => {
            const address = server.address();
            if (!address || typeof address === 'string') { server.close(); reject(new Error('invalid loopback listener')); return; }
            server.close(error => error ? reject(error) : resolve(address.port));
        });
    });
}

async function armHelper(executablePath: string, helperPath: string, receiptPath: string, receipt: Receipt): Promise<void> {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(executablePath, [helperPath, receiptPath, receipt.preparationId, receipt.helperToken!], {
        detached: true, windowsHide: true, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    await helperAcknowledgement(child, receipt.preparationId, receipt.helperToken!);
    child.disconnect(); child.unref();
}

function helperAcknowledgement(child: ChildProcess, preparationId: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (error?: Error) => {
            if (done) return; done = true; clearTimeout(timer);
            child.removeListener('error', onError); child.removeListener('exit', onExit); child.removeListener('message', onMessage);
            error ? reject(error) : resolve();
        };
        const onError = (error: Error) => finish(error);
        const onExit = () => finish(new Error('restart helper exited before arming'));
        const onMessage = (message: unknown) => {
            const value = message as { type?: unknown; preparationId?: unknown; token?: unknown };
            if (value?.type === 'armed' && value.preparationId === preparationId && value.token === token) finish();
        };
        const timer = setTimeout(() => finish(new Error('restart helper did not arm')), HELPER_ACK_MS);
        child.once('error', onError); child.once('exit', onExit); child.on('message', onMessage);
    });
}

function cleanChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...source };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
    return env;
}

function parsePid(value: string | undefined): number {
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new ColabEnvironmentError('main_process_unverified', 'VSCODE_PID did not identify the primary VS Code process.');
    return pid;
}
function classifyRestoreWindows(value: string | undefined): ColabEnvironmentPreflightLocal['window']['quitPolicy']['restoreWindows'] {
    if (value === undefined) return 'unresolved';
    return ['all', 'folders', 'one', 'none', 'preserve'].includes(value)
        ? value as ColabEnvironmentPreflightLocal['window']['quitPolicy']['restoreWindows']
        : 'unsupported';
}
function validPort(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535; }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function samePath(left: string, right: string): boolean { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function sameProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
    return left.pid === right.pid && samePath(left.executablePath, right.executablePath) && left.creationTime === right.creationTime;
}
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 300) : 'unknown error'; }

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, file).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        await fs.rm(file, { force: true }); await fs.rename(temp, file);
    }).finally(() => fs.rm(temp, { force: true }).catch(() => undefined));
}
async function readJson(file: string): Promise<any | undefined> {
    try {
        const data = await fs.readFile(file);
        if (data.length >= MAX_FILE_BYTES) return undefined;
        return JSON.parse(data.toString('utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
        throw error;
    }
}
function validateReceipt(value: any): Receipt | undefined {
    if (!value || Buffer.byteLength(JSON.stringify(value)) >= MAX_FILE_BYTES || value.schema !== SCHEMA || !isUuid(value.preparationId) || !isUuid(value.nonce) ||
        !['workspace_open_requested', 'workspace_conversion_requested', 'arming_restart', 'restart_requested', 'app_launched', 'environment_ready', 'failed'].includes(value.status) ||
        !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.deadline) || value.deadline !== value.createdAt + PREPARATION_MS ||
        typeof value.workspaceUri !== 'string' || value.workspaceUri.length > 4096 || typeof value.expectedWindowLabel !== 'string' ||
        (value.generatedWorkspace && !/^colab-bootstrap-[0-9a-f]{8}$/.test(value.expectedWindowLabel)) ||
        !validPort(value.port) || typeof value.generatedWorkspace !== 'boolean') return undefined;
    if (value.restartMode !== undefined && value.restartMode !== 'restore-clean-workspace') return undefined;
    const preparation = value.folderPreparation;
    if (preparation !== undefined && (!preparation || typeof preparation.originalName !== 'string' ||
        preparation.originalName !== value.expectedWindowLabel || preparation.originalName.length > 512 ||
        preparation.preparedName !== `${preparation.originalName} [Colab ${value.preparationId.slice(0, 8)}]` ||
        (preparation.requestedAt !== undefined && (!Number.isSafeInteger(preparation.requestedAt) ||
            preparation.requestedAt < value.createdAt || preparation.requestedAt > value.deadline)) ||
        (preparation.workspaceFileUri !== undefined && (typeof preparation.workspaceFileUri !== 'string' ||
            preparation.workspaceFileUri.length > 4096 || !/^untitled:[^\r\n]+$/.test(preparation.workspaceFileUri) || preparation.requestedAt === undefined)))) return undefined;
    if (value.status === 'workspace_conversion_requested' && (!preparation || preparation.requestedAt === undefined)) return undefined;
    if (value.restartMode === 'restore-clean-workspace') {
        if (value.generatedWorkspace || preparation !== undefined || typeof value.restartRequired !== 'boolean' || value.expectedWindowLabel.length > 512 ||
            value.workspacePath !== undefined || !validateRestorationSnapshot(value.restorationSnapshot, value.restartRequired === true) ||
            value.workspaceUri !== value.restorationSnapshot.workspace.uri || value.installedCommit !== SUPPORTED_COMMIT ||
            !value.main || !Number.isSafeInteger(value.main.pid) || typeof value.main.executablePath !== 'string' ||
            typeof value.main.creationTime !== 'string' || value.main.creationTime.length > 128 || Number.isNaN(Date.parse(value.main.creationTime)) ||
            typeof value.executablePath !== 'string' || value.executablePath.length > 4096 ||
            typeof value.userDataDir !== 'string' || value.userDataDir.length > 4096 ||
            typeof value.extensionsDir !== 'string' || value.extensionsDir.length > 4096 ||
            !samePath(value.executablePath, value.main.executablePath)) return undefined;
        if (value.preSpawnAt !== undefined && (!Number.isSafeInteger(value.preSpawnAt) || value.preSpawnAt < value.createdAt || value.preSpawnAt > value.deadline)) return undefined;
        if (!value.restartRequired && value.status !== 'environment_ready' && value.status !== 'failed') return undefined;
        if (value.restartRequired && ['arming_restart', 'restart_requested', 'app_launched'].includes(value.status) && !isUuid(value.helperToken)) return undefined;
        if (value.status === 'app_launched' || (value.status === 'environment_ready' && value.restartRequired)) {
            if (!Number.isSafeInteger(value.preSpawnAt) || !Number.isSafeInteger(value.launchedAt) || !Number.isSafeInteger(value.launchPid) ||
                value.preSpawnAt < value.createdAt || value.launchedAt < value.preSpawnAt || value.launchedAt > value.deadline || value.launchPid <= 0) return undefined;
        }
    } else if (value.restorationSnapshot !== undefined || value.restartRequired !== undefined || value.preSpawnAt !== undefined) return undefined;
    if (value.restartMode !== 'restore-clean-workspace' && ['arming_restart', 'restart_requested', 'app_launched'].includes(value.status) &&
        (typeof value.executablePath !== 'string' || typeof value.userDataDir !== 'string' || typeof value.extensionsDir !== 'string' ||
         !value.main || !Number.isSafeInteger(value.main.pid) || typeof value.main.executablePath !== 'string' ||
         typeof value.main.creationTime !== 'string' || !isUuid(value.helperToken) || typeof value.workspacePath !== 'string' ||
         !samePath(value.executablePath, value.main.executablePath))) return undefined;
    return value as Receipt;
}

function validateRestorationSnapshot(value: any, requireSavedState = true): value is RestorationWorkspaceState {
    if (!value || value.schema !== 1 || Buffer.byteLength(JSON.stringify(value)) >= MAX_FILE_BYTES ||
        !value.workspace || !['file', 'untitled'].includes(value.workspace.kind) ||
        typeof value.workspace.uri !== 'string' || value.workspace.uri.length > 4096 ||
        (value.workspace.kind === 'file' ? !/^file:/i.test(value.workspace.uri) : !/^untitled:/i.test(value.workspace.uri)) ||
        !Array.isArray(value.workspace.roots) || !value.workspace.roots.length || value.workspace.roots.length > 64 ||
        value.workspace.roots.some((root: any) => !root || typeof root.uri !== 'string' || root.uri.length > 4096 || !/^file:/i.test(root.uri) || typeof root.name !== 'string' || !root.name || root.name.length > 512)) return false;
    const hasPublicSnapshot = value.tabGroups !== undefined || value.documents !== undefined;
    if (!requireSavedState && !hasPublicSnapshot) return value.savedState === undefined;
    if (!Array.isArray(value.tabGroups) || value.tabGroups.length > MAX_RESTORE_ITEMS ||
        value.tabGroups.some((group: any) => !Array.isArray(group) || group.length > MAX_RESTORE_ITEMS || group.some((tab: any) => !validRestorationTab(tab))) ||
        value.tabGroups.reduce((count: number, group: any[]) => count + group.length, 0) > MAX_RESTORE_ITEMS ||
        !value.documents || !validVersionInventory(value.documents.text) || !validVersionInventory(value.documents.notebooks)) return false;
    if (!requireSavedState) return value.savedState === undefined;
    if (!value.savedState || !Array.isArray(value.savedState.untitledWorkspaces) || value.savedState.untitledWorkspaces.length > 64 ||
        value.savedState.untitledWorkspaces.some((entry: any) => !entry || typeof entry.name !== 'string' || !entry.name || entry.name.length > 255 || !['file', 'directory'].includes(entry.kind)) ||
        !value.savedState.backupRegistry || !Number.isSafeInteger(value.savedState.backupRegistry.workspaces) || value.savedState.backupRegistry.workspaces < 0 || value.savedState.backupRegistry.workspaces > MAX_RESTORE_ITEMS ||
        !Number.isSafeInteger(value.savedState.backupRegistry.folders) || value.savedState.backupRegistry.folders < 0 || value.savedState.backupRegistry.folders > MAX_RESTORE_ITEMS ||
        value.savedState.backupRegistry.emptyWindows !== 0) return false;
    return true;
}

function validVersionInventory(value: any): boolean {
    return Array.isArray(value) && value.length <= MAX_RESTORE_ITEMS && value.every((entry: any) => entry && typeof entry.uri === 'string' &&
        entry.uri.length <= 4096 && /^file:/i.test(entry.uri) && Number.isSafeInteger(entry.version) && entry.version >= 0);
}

function validRestorationTab(tab: any): boolean {
    if (!tab || !['text', 'notebook', 'custom', 'text-diff', 'notebook-diff'].includes(tab.kind)) return false;
    const uri = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^file:/i.test(value);
    if (tab.kind === 'text') return uri(tab.uri);
    if (tab.kind === 'notebook') return uri(tab.uri) && typeof tab.notebookType === 'string' && tab.notebookType.length > 0 && tab.notebookType.length <= 256;
    if (tab.kind === 'custom') return uri(tab.uri) && typeof tab.viewType === 'string' && tab.viewType.length > 0 && tab.viewType.length <= 256;
    if (tab.kind === 'text-diff') return uri(tab.original) && uri(tab.modified);
    return uri(tab.original) && uri(tab.modified) && typeof tab.notebookType === 'string' && tab.notebookType.length > 0 && tab.notebookType.length <= 256;
}

// This fixed helper accepts only the internally generated receipt path/id/token.
// It never terminates a process, never launches on an unknown process query, and
// honors a receipt that the surviving extension host has disarmed.
export const HELPER_SOURCE_FOR_TEST = String.raw`'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const [receiptPath,id,token]=process.argv.slice(2); const MAX=65536,META=1048576,LIFE=120000,ITEMS=256,COMMIT='6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1';
function read(){const b=fs.readFileSync(receiptPath);if(b.length>=MAX)throw Error('receipt too large');return JSON.parse(b.toString('utf8'));}
function write(v){const s=JSON.stringify(v);if(Buffer.byteLength(s)>=MAX)throw Error('receipt too large');const t=receiptPath+'.'+process.pid+'.tmp';try{fs.writeFileSync(t,s,{encoding:'utf8',flag:'wx'});try{fs.renameSync(t,receiptPath);}catch(e){if(e.code!=='EEXIST'&&e.code!=='EPERM')throw e;fs.rmSync(receiptPath,{force:true});fs.renameSync(t,receiptPath);}}finally{try{fs.rmSync(t,{force:true});}catch{}}}
function fail(code){try{const r=read();if(r.preparationId===id&&r.helperToken===token){r.status='failed';r.failure=code;write(r);}}catch{}process.exit(0);}
function inspect(r){const root=process.env.SystemRoot||'C:\\Windows';const ps=path.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');const s='$ErrorActionPreference=\'Stop\';try{$p=Get-CimInstance -ClassName Win32_Process -Filter "ProcessId='+r.main.pid+'" -ErrorAction Stop;if($null -ne $p){$p.ExecutablePath;$p.CreationDate.ToUniversalTime().ToString("o")};exit 0}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 17}';const q=cp.spawnSync(ps,['-NoProfile','-NonInteractive','-Command',s],{windowsHide:true,timeout:5000,encoding:'utf8',maxBuffer:16384});if(q.error||q.status!==0)throw Error('identity query failed');const lines=q.stdout.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(!lines.length)return;if(lines.length!==2||Number.isNaN(Date.parse(lines[1])))throw Error('identity response malformed');return {executablePath:path.resolve(lines[0]),creationTime:lines[1]};}
function same(a,b){return path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();}
function restored(r){return r.restartMode==='restore-clean-workspace';}
function uuid(v){return typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);}
function bounded(v,n){return typeof v==='string'&&v.length>0&&v.length<=n;}
function file(v){return bounded(v,4096)&&/^file:/i.test(v);}
function versions(v){return Array.isArray(v)&&v.length<=ITEMS&&v.every(x=>x&&file(x.uri)&&Number.isSafeInteger(x.version)&&x.version>=0);}
function tab(v){if(!v||!['text','notebook','custom','text-diff','notebook-diff'].includes(v.kind))return false;const kind=x=>bounded(x,256);if(v.kind==='text')return file(v.uri);if(v.kind==='notebook')return file(v.uri)&&kind(v.notebookType);if(v.kind==='custom')return file(v.uri)&&kind(v.viewType);if(v.kind==='text-diff')return file(v.original)&&file(v.modified);return file(v.original)&&file(v.modified)&&kind(v.notebookType);}
function snapshot(v){if(!v||v.schema!==1||!v.workspace||!['file','untitled'].includes(v.workspace.kind)||!bounded(v.workspace.uri,4096)||(v.workspace.kind==='file'?!/^file:/i.test(v.workspace.uri):!/^untitled:/i.test(v.workspace.uri))||!Array.isArray(v.workspace.roots)||!v.workspace.roots.length||v.workspace.roots.length>64||v.workspace.roots.some(x=>!x||!file(x.uri)||!bounded(x.name,512)))return false;if(!Array.isArray(v.tabGroups)||v.tabGroups.length>ITEMS||v.tabGroups.some(g=>!Array.isArray(g)||g.length>ITEMS||g.some(x=>!tab(x)))||v.tabGroups.reduce((n,g)=>n+g.length,0)>ITEMS)return false;if(!v.documents||!versions(v.documents.text)||!versions(v.documents.notebooks))return false;const s=v.savedState,b=s&&s.backupRegistry;return !!s&&Array.isArray(s.untitledWorkspaces)&&s.untitledWorkspaces.length<=64&&s.untitledWorkspaces.every(x=>x&&bounded(x.name,255)&&['file','directory'].includes(x.kind))&&b&&Number.isSafeInteger(b.workspaces)&&b.workspaces>=0&&b.workspaces<=ITEMS&&Number.isSafeInteger(b.folders)&&b.folders>=0&&b.folders<=ITEMS&&b.emptyWindows===0;}
function valid(r,status){if(!r||r.schema!==1||r.preparationId!==id||!uuid(r.nonce)||r.helperToken!==token||!uuid(token)||r.status!==status||!Number.isSafeInteger(r.createdAt)||!Number.isSafeInteger(r.deadline)||r.deadline<=r.createdAt||r.deadline>r.createdAt+LIFE||!bounded(r.workspaceUri,4096)||!bounded(r.expectedWindowLabel,512)||!Number.isInteger(r.port)||r.port<=0||r.port>65535||typeof r.generatedWorkspace!=='boolean'||!r.main||!Number.isSafeInteger(r.main.pid)||r.main.pid<=0||!bounded(r.main.creationTime,128)||Number.isNaN(Date.parse(r.main.creationTime))||!bounded(r.userDataDir,4096)||!bounded(r.extensionsDir,4096)||!bounded(r.executablePath,4096)||!same(r.executablePath,r.main.executablePath))return false;if(r.helperArmedAt!==undefined&&(!Number.isSafeInteger(r.helperArmedAt)||r.helperArmedAt<r.createdAt||r.helperArmedAt>r.deadline))return false;if(r.quitDispatchApprovedAt!==undefined&&(!Number.isSafeInteger(r.quitDispatchApprovedAt)||r.quitDispatchApprovedAt<r.createdAt||r.quitDispatchApprovedAt>r.deadline))return false;if(r.preSpawnAt!==undefined&&(!Number.isSafeInteger(r.preSpawnAt)||r.preSpawnAt<r.createdAt||r.preSpawnAt>r.deadline))return false;if(r.restartMode!==undefined&&!restored(r))return false;if(restored(r))return r.restartRequired===true&&r.generatedWorkspace===false&&r.workspacePath===undefined&&r.folderPreparation===undefined&&r.installedCommit===COMMIT&&snapshot(r.restorationSnapshot)&&r.workspaceUri===r.restorationSnapshot.workspace.uri;return bounded(r.workspacePath,4096);}
function fixed(v){const c={...v};for(const k of ['status','helperArmedAt','quitDispatchApprovedAt','preSpawnAt','launchedAt','launchPid','readyAt','failure'])delete c[k];return JSON.stringify(c);}
function registry(v,keys){return Array.isArray(v)&&v.length<=ITEMS&&v.every(x=>x&&typeof x==='object'&&!Array.isArray(x)&&keys.every(k=>bounded(x[k],4096))&&(x.remoteAuthority===undefined||(typeof x.remoteAuthority==='string'&&x.remoteAuthority.length<=256)));}
function saved(r){if(!restored(r))return true;const expected=r.restorationSnapshot.savedState;if(!expected||!Array.isArray(expected.untitledWorkspaces)||!expected.backupRegistry)return false;const root=path.join(r.userDataDir,'Workspaces');const entries=fs.readdirSync(root,{withFileTypes:true});if(entries.length>64)return false;const projected=entries.map(e=>{if(!e.name||e.name.length>255||(!e.isFile()&&!e.isDirectory()))throw Error('entry');return {name:e.name,kind:e.isDirectory()?'directory':'file'};}).sort((a,b)=>a.name.localeCompare(b.name));const file=path.join(r.userDataDir,'User','globalStorage','storage.json');const bytes=fs.readFileSync(file);if(!bytes.length||bytes.length>META)return false;const storage=JSON.parse(bytes.toString('utf8')),b=storage&&storage.backupWorkspaces;if(!b||!registry(b.workspaces,['id','configURIPath'])||!registry(b.folders,['folderUri'])||!registry(b.emptyWindows,['backupFolder'])||b.emptyWindows.length!==0)return false;const actual={untitledWorkspaces:projected,backupRegistry:{workspaces:b.workspaces.length,folders:b.folders.length,emptyWindows:0}};return JSON.stringify(actual)===JSON.stringify(expected);}
let r,baseline;try{r=read();if(!valid(r,'arming_restart')||Date.now()>r.deadline||!saved(r))throw Error('receipt mismatch');baseline=fixed(r);r.status='restart_requested';r.helperArmedAt=Date.now();write(r);if(process.send)process.send({type:'armed',preparationId:id,token});}catch{fail('helper_receipt_invalid');}
function current(v,status){return valid(v,status)&&(!restored(v)||fixed(v)===baseline);}
function retry(){if(Date.now()>r.deadline)return fail('quit_not_confirmed');return setTimeout(poll,250);}
function recordLaunch(child,preSpawnAt){if(Date.now()>r.deadline)return fail('app_launch_receipt_timeout');let latest;try{latest=read();}catch{return setTimeout(()=>recordLaunch(child,preSpawnAt),250);}if(latest.status!=='restart_requested')return process.exit(0);if(!current(latest,'restart_requested')||(restored(latest)&&latest.preSpawnAt!==preSpawnAt))return fail('helper_receipt_invalid');latest.status='app_launched';latest.launchedAt=Date.now();latest.launchPid=child.pid;try{write(latest);setTimeout(()=>process.exit(0),50);}catch{setTimeout(()=>recordLaunch(child,preSpawnAt),250);}}
function poll(){let latest;try{latest=read();}catch{return retry();}r=latest;if(r.status!=='restart_requested')return;if(!current(r,'restart_requested'))return fail('helper_receipt_invalid');if(Date.now()>r.deadline)return fail('quit_not_confirmed');if(!Number.isSafeInteger(r.quitDispatchApprovedAt))return setTimeout(poll,250);const expectedDeadline=r.deadline,expectedApproval=r.quitDispatchApprovedAt;let p;try{p=inspect(r);}catch{return retry();}if(p){if(!same(p.executablePath,r.main.executablePath)||p.creationTime!==r.main.creationTime)return fail('main_process_identity_changed');return setTimeout(poll,250);}let confirmed;try{confirmed=read();}catch{return retry();}if(confirmed.status!=='restart_requested')return;if(!current(confirmed,'restart_requested'))return fail('helper_receipt_invalid');if(confirmed.deadline!==expectedDeadline||confirmed.quitDispatchApprovedAt!==expectedApproval)return fail('helper_receipt_invalid');if(Date.now()>confirmed.deadline){r=confirmed;return fail('quit_not_confirmed');}try{if(!saved(confirmed)){r=confirmed;return fail('restoration_state_changed');}}catch{r=confirmed;return fail('restoration_state_changed');}r=confirmed;let preSpawnAt;if(restored(r)){preSpawnAt=Date.now();r.preSpawnAt=preSpawnAt;try{write(r);const exact=read();if(exact.status!=='restart_requested')return;if(!current(exact,'restart_requested')||exact.preSpawnAt!==preSpawnAt||!saved(exact))return fail('helper_receipt_invalid');r=exact;}catch{return fail('helper_receipt_invalid');}}const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const k of Object.keys(env))if(k.startsWith('VSCODE_'))delete env[k];env.JUPYTER_MCP_NATIVE_DEBUG_PORT=String(r.port);const args=restored(r)?['--user-data-dir',r.userDataDir,'--extensions-dir',r.extensionsDir,'--remote-debugging-port='+r.port]:['--new-window','--user-data-dir',r.userDataDir,'--extensions-dir',r.extensionsDir,'--remote-debugging-port='+r.port,r.workspacePath];let child;try{child=cp.spawn(r.executablePath,args,{detached:true,windowsHide:false,stdio:'ignore',env,cwd:path.dirname(r.executablePath)});}catch{return fail('app_launch_failed');}let settled=false;child.once('error',()=>{if(settled)return;settled=true;fail('app_launch_failed');});child.once('spawn',()=>{if(settled)return;settled=true;child.unref();recordLaunch(child,preSpawnAt);});}
setTimeout(poll,250);`;

const HELPER_SOURCE = HELPER_SOURCE_FOR_TEST;
