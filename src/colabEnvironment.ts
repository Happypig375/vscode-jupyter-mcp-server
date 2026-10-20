import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, execFile, spawn } from 'child_process';
import * as vscode from 'vscode';
import { ColabNativeEndpointInspection, createColabNativeDriver, inspectColabNativeEndpoint } from './colabNative';

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
const RECEIPTS = 'colab-environment-receipts';
const WORKSPACES = 'colab-environment-workspaces';
const ACTIVE = 'colab-environment-active.json';
const HELPER = 'colab-environment-helper.cjs';
const FOLDER_MARKER = 'jupyter-mcp-environment.json';

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
    folderPreparation?: { originalName: string; preparedName: string; requestedAt?: number; workspaceFileUri?: string };
    installedCommit?: string;
    main?: ProcessIdentity;
    executablePath?: string;
    userDataDir?: string;
    extensionsDir?: string;
    helperArmedAt?: number;
    quitDispatchApprovedAt?: number;
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
export async function prepareColabEnvironment(folderUri?: string): Promise<string> {
    if (!manager) throw new ColabEnvironmentError('environment_not_initialized', 'Colab environment preparation is not initialized in this VS Code window.');
    return manager.prepare(folderUri);
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
    initialize(): Promise<void>; prepare(folderUri?: string): Promise<string>; get(id: string): Promise<string>; inspect(): Promise<string>;
} {
    const instance = new ColabEnvironmentManager(context, dependencies);
    return { initialize: () => instance.initialize(), prepare: folderUri => instance.prepare(folderUri), get: id => instance.get(id), inspect: () => instance.inspect() };
}

class ColabEnvironmentManager {
    private readonly root: string;
    private readonly receiptRoot: string;
    private readonly workspaceRoot: string;
    private readonly activePath: string;
    private disposed = false;
    private workspacePreparation?: Promise<void>;

    constructor(private readonly context: ColabEnvironmentContextForTest, private readonly deps: ColabEnvironmentDependenciesForTest) {
        // File URI interpretation belongs to the host filesystem, independently of
        // test-injected bootstrap-platform behavior.
        this.root = resolveLocalGlobalStoragePath(context, { platform: process.platform, env: deps.env });
        this.receiptRoot = path.join(this.root, RECEIPTS);
        this.workspaceRoot = path.join(this.root, WORKSPACES);
        this.activePath = path.join(this.root, ACTIVE);
        context.subscriptions.push({ dispose: () => { this.disposed = true; } });
    }

    async initialize(): Promise<void> {
        await fs.mkdir(this.receiptRoot, { recursive: true });
        await fs.mkdir(this.workspaceRoot, { recursive: true });
        const active = await this.readActive();
        if (!active) return;
        const receipt = await this.readReceipt(active);
        if (!receipt) { await this.releaseActive(active); return; }
        if (receipt.status === 'restart_requested' && Number.isSafeInteger(receipt.quitDispatchApprovedAt) && receipt.main) {
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
        if (!await this.reconcile(receipt)) await this.prepareWorkspace(receipt);
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

    async prepare(folderUri?: string): Promise<string> {
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

    async get(preparationId: string): Promise<string> {
        if (!isUuid(preparationId)) throw new ColabEnvironmentError('preparation_invalid', 'preparationId is malformed.');
        const receipt = await this.requireReceipt(preparationId);
        const freshNativeBind = await this.reconcile(receipt);
        return this.present(await this.requireReceipt(preparationId), freshNativeBind);
    }

    private async reconcile(receipt: Receipt): Promise<boolean> {
        if (receipt.status === 'failed') { await this.releaseActive(receipt.preparationId); return false; }
        if (receipt.status !== 'environment_ready' && this.deps.now() > receipt.deadline) {
            await this.fail(receipt, 'preparation_timeout'); return false;
        }
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

    private matchesWorkspace(receipt: Receipt): boolean {
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
        const status = receipt.status !== 'failed' && (exactWindow || current?.uri === receipt.workspaceUri) && !vscode.workspace.isTrusted ? 'workspace_untrusted' : receipt.status === 'environment_ready'
            ? !exactWindow ? 'workspace_mismatch' : !freshNativeBind ? 'native_binding_unavailable' : 'environment_ready'
            : receipt.status;
        const next = ready
            ? { tool: 'list_notebooks', hint: `Use the connected window labelled '${expectedWindowLabel}', then call open_notebooks there if the notebook is not already open.` }
            : status === 'workspace_open_requested' || status === 'workspace_mismatch'
                ? { tool: 'list_notebooks', hint: `Find the connected window for '${receipt.expectedWindowLabel}' and route get_colab_environment_preparation to it.` }
                : { tool: 'get_colab_environment_preparation', preparationId: receipt.preparationId, hint: 'Poll after VS Code has restarted; this status proves only the desktop environment.' };
        return JSON.stringify({ preparationId: receipt.preparationId, status, environmentReady: ready, runtimeReady: false,
            workspaceUri: receipt.folderPreparation?.workspaceFileUri ?? receipt.workspaceUri,
            folderUri: receipt.folderPreparation ? receipt.workspaceUri : undefined,
            expectedWindowLabel, failure: receipt.failure, next });
    }

    private receiptPath(id: string): string { return path.join(this.receiptRoot, `${id}.json`); }
    private async writeReceipt(receipt: Receipt): Promise<void> { await writeJsonAtomic(this.receiptPath(receipt.preparationId), receipt); }
    private async readReceipt(id: string): Promise<Receipt | undefined> { return validateReceipt(await readJson(this.receiptPath(id))); }
    private async requireReceipt(id: string): Promise<Receipt> {
        const receipt = await this.readReceipt(id);
        if (!receipt) throw new ColabEnvironmentError('preparation_not_found', 'The Colab environment preparation is unknown or corrupted.');
        return receipt;
    }
    private async readActive(): Promise<string | undefined> {
        const value = await readJson(this.activePath);
        return value && value.schema === SCHEMA && isUuid(value.preparationId) ? value.preparationId : undefined;
    }
    private async obtainActive(): Promise<string | undefined> {
        const id = await this.readActive();
        if (!id) return undefined;
        const receipt = await this.readReceipt(id);
        if (!receipt || receipt.status === 'failed' || receipt.status === 'environment_ready' || this.deps.now() > receipt.deadline) {
            await this.releaseActive(id); return undefined;
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
    }
    private async fail(receipt: Receipt, failure: string): Promise<void> {
        const latest = await this.readReceipt(receipt.preparationId) ?? receipt;
        latest.status = 'failed'; latest.failure = failure;
        await this.writeReceipt(latest); await this.releaseActive(latest.preparationId);
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

async function resolveRequestedFolder(value: string): Promise<{ uri: string; label: string; path: string }> {
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
    return { uri: vscode.Uri.file(folderPath).toString(), label: path.basename(folderPath) || folderPath, path: folderPath };
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
    return { version: versionMatch[1], commit: versionMatch[2], processArgs: argsMatch[1].trim() ? argsMatch[1].trim().split(/\s+/) : [], mainPid: expectedPid, windows };
}

function assertSafeInitialArgs(args: string[]): void {
    const remaining = [...args];
    const newWindow = remaining.indexOf('--new-window');
    if (newWindow >= 0) remaining.splice(newWindow, 1);
    if (!remaining.length) return;
    if (remaining.length === 2 && remaining[0] === '--crash-reporter-id' && /^[0-9a-f-]{36}$/i.test(remaining[1])) return;
    throw new ColabEnvironmentError('startup_arguments_unsupported', 'Automatic restart requires the ordinary default VS Code startup arguments.');
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
        if (data.length > MAX_FILE_BYTES) return undefined;
        return JSON.parse(data.toString('utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
        throw error;
    }
}
function validateReceipt(value: any): Receipt | undefined {
    if (!value || value.schema !== SCHEMA || !isUuid(value.preparationId) || !isUuid(value.nonce) ||
        !['workspace_open_requested', 'workspace_conversion_requested', 'arming_restart', 'restart_requested', 'app_launched', 'environment_ready', 'failed'].includes(value.status) ||
        !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.deadline) || value.deadline !== value.createdAt + PREPARATION_MS ||
        typeof value.workspaceUri !== 'string' || value.workspaceUri.length > 4096 || typeof value.expectedWindowLabel !== 'string' ||
        (value.generatedWorkspace && !/^colab-bootstrap-[0-9a-f]{8}$/.test(value.expectedWindowLabel)) ||
        !validPort(value.port) || typeof value.generatedWorkspace !== 'boolean') return undefined;
    const preparation = value.folderPreparation;
    if (preparation !== undefined && (!preparation || typeof preparation.originalName !== 'string' ||
        preparation.originalName !== value.expectedWindowLabel || preparation.originalName.length > 512 ||
        preparation.preparedName !== `${preparation.originalName} [Colab ${value.preparationId.slice(0, 8)}]` ||
        (preparation.requestedAt !== undefined && (!Number.isSafeInteger(preparation.requestedAt) ||
            preparation.requestedAt < value.createdAt || preparation.requestedAt > value.deadline)) ||
        (preparation.workspaceFileUri !== undefined && (typeof preparation.workspaceFileUri !== 'string' ||
            preparation.workspaceFileUri.length > 4096 || !/^untitled:[^\r\n]+$/.test(preparation.workspaceFileUri) || preparation.requestedAt === undefined)))) return undefined;
    if (value.status === 'workspace_conversion_requested' && (!preparation || preparation.requestedAt === undefined)) return undefined;
    if (['arming_restart', 'restart_requested', 'app_launched'].includes(value.status) &&
        (typeof value.executablePath !== 'string' || typeof value.userDataDir !== 'string' || typeof value.extensionsDir !== 'string' ||
         !value.main || !Number.isSafeInteger(value.main.pid) || typeof value.main.executablePath !== 'string' ||
         typeof value.main.creationTime !== 'string' || !isUuid(value.helperToken) || typeof value.workspacePath !== 'string' ||
         !samePath(value.executablePath, value.main.executablePath))) return undefined;
    return value as Receipt;
}

// This fixed helper accepts only the internally generated receipt path/id/token.
// It never terminates a process, never launches on an unknown process query, and
// honors a receipt that the surviving extension host has disarmed.
export const HELPER_SOURCE_FOR_TEST = String.raw`'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const [receiptPath,id,token]=process.argv.slice(2); const MAX=65536;
function read(){const b=fs.readFileSync(receiptPath);if(b.length>MAX)throw Error('receipt too large');return JSON.parse(b.toString('utf8'));}
function write(v){const t=receiptPath+'.'+process.pid+'.tmp';try{fs.writeFileSync(t,JSON.stringify(v),{encoding:'utf8',flag:'wx'});try{fs.renameSync(t,receiptPath);}catch(e){if(e.code!=='EEXIST'&&e.code!=='EPERM')throw e;fs.rmSync(receiptPath,{force:true});fs.renameSync(t,receiptPath);}}finally{try{fs.rmSync(t,{force:true});}catch{}}}
function fail(code){try{const r=read();if(r.preparationId===id&&r.helperToken===token){r.status='failed';r.failure=code;write(r);}}catch{}process.exit(0);}
function inspect(r){const root=process.env.SystemRoot||'C:\\Windows';const ps=path.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');const s='$ErrorActionPreference=\'Stop\';try{$p=Get-CimInstance -ClassName Win32_Process -Filter "ProcessId='+r.main.pid+'" -ErrorAction Stop;if($null -ne $p){$p.ExecutablePath;$p.CreationDate.ToUniversalTime().ToString("o")};exit 0}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 17}';const q=cp.spawnSync(ps,['-NoProfile','-NonInteractive','-Command',s],{windowsHide:true,timeout:5000,encoding:'utf8',maxBuffer:16384});if(q.error||q.status!==0)throw Error('identity query failed');const lines=q.stdout.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(!lines.length)return;if(lines.length!==2||Number.isNaN(Date.parse(lines[1])))throw Error('identity response malformed');return {executablePath:path.resolve(lines[0]),creationTime:lines[1]};}
function same(a,b){return path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();}
let r;try{r=read();if(r.schema!==1||r.preparationId!==id||r.helperToken!==token||r.status!=='arming_restart'||!r.main||Date.now()>r.deadline||typeof r.workspacePath!=='string'||typeof r.userDataDir!=='string'||typeof r.extensionsDir!=='string'||typeof r.executablePath!=='string'||!same(r.executablePath,r.main.executablePath))throw Error('receipt mismatch');r.status='restart_requested';r.helperArmedAt=Date.now();write(r);if(process.send)process.send({type:'armed',preparationId:id,token});}catch{fail('helper_receipt_invalid');}
function retry(){if(Date.now()>r.deadline)return fail('quit_not_confirmed');return setTimeout(poll,250);}
function recordLaunch(child){if(Date.now()>r.deadline)return fail('app_launch_receipt_timeout');let latest;try{latest=read();}catch{return setTimeout(()=>recordLaunch(child),250);}if(latest.preparationId!==id||latest.helperToken!==token||latest.status!=='restart_requested')return process.exit(0);latest.status='app_launched';latest.launchedAt=Date.now();latest.launchPid=child.pid;try{write(latest);setTimeout(()=>process.exit(0),50);}catch{setTimeout(()=>recordLaunch(child),250);}}
function poll(){let latest;try{latest=read();}catch{return retry();}r=latest;if(r.preparationId!==id||r.helperToken!==token||r.status!=='restart_requested')return;if(Date.now()>r.deadline)return fail('quit_not_confirmed');if(!Number.isSafeInteger(r.quitDispatchApprovedAt))return setTimeout(poll,250);const expectedDeadline=r.deadline,expectedApproval=r.quitDispatchApprovedAt;let p;try{p=inspect(r);}catch{return retry();}if(p){if(!same(p.executablePath,r.main.executablePath)||p.creationTime!==r.main.creationTime)return fail('main_process_identity_changed');return setTimeout(poll,250);}let confirmed;try{confirmed=read();}catch{return retry();}if(confirmed.preparationId!==id||confirmed.helperToken!==token||confirmed.status!=='restart_requested')return;if(confirmed.deadline!==expectedDeadline||confirmed.quitDispatchApprovedAt!==expectedApproval)return;if(Date.now()>confirmed.deadline){r=confirmed;return fail('quit_not_confirmed');}r=confirmed;const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const k of Object.keys(env))if(k.startsWith('VSCODE_'))delete env[k];env.JUPYTER_MCP_NATIVE_DEBUG_PORT=String(r.port);const args=['--new-window','--user-data-dir',r.userDataDir,'--extensions-dir',r.extensionsDir,'--remote-debugging-port='+r.port,r.workspacePath];let child;try{child=cp.spawn(r.executablePath,args,{detached:true,windowsHide:false,stdio:'ignore',env,cwd:path.dirname(r.executablePath)});}catch{return fail('app_launch_failed');}let settled=false;child.once('error',()=>{if(settled)return;settled=true;fail('app_launch_failed');});child.once('spawn',()=>{if(settled)return;settled=true;child.unref();recordLaunch(child);});}
setTimeout(poll,250);`;

const HELPER_SOURCE = HELPER_SOURCE_FOR_TEST;
