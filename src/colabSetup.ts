import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DesktopSetupChoice, DesktopSetupDriver, DesktopSetupError } from './colabDesktop';
import { createColabNativeDriver } from './colabNative';
import { checkColabRuntime, getColabFileRoots } from './kernelFiles';
import { findNotebook, getExecution, hasPendingNotebookExecutionCommand } from './notebookOps';

const SETUP_TIMEOUT_MS = 300_000;
const MAX_HISTORY = 16;
type Stage = 'preflight' | 'binding_window' | 'selecting_provider' | 'creating_cpu_server' | 'naming_server' | 'awaiting_kernel_selection' | 'selecting_python' | 'starting_kernel' | 'mounting_filesystem' | 'verifying_runtime' | 'finished';
type ProviderStep = 'opening_kernel_picker' | 'choosing_colab_source' | 'awaiting_server_picker' | 'choosing_colab_handoff' | 'choosing_existing_server' | 'choosing_new_server';
type State = 'running' | 'ready' | 'failed' | 'cancelled';
type SetupOperation = 'configure_kernel' | 'mount_colab_server';
interface SetupKernel { language?: string; status?: string; executeCode?: unknown; }
interface Setup {
    id: string; notebook: string; operation: SetupOperation; serverAlias?: string; state: State; stage: Stage; startedAt: string;
    endedAt?: string; reason?: string; code?: string; verification?: unknown; failedStage?: Stage;
    providerStep?: ProviderStep; failedProviderStep?: ProviderStep;
    startupCellRetained?: boolean; serverMayRemain?: boolean; cleanupPending?: boolean;
    desktopOperation?: string; desktopError?: string;
    driver?: DesktopSetupDriver; kernelHeader?: string; kernelChoices?: Map<string, DesktopSetupChoice>;
    kernelListingVersion: number; kernelChoiceQueue: Promise<void>;
    kernelChoiceGate: Promise<string>; resolveKernelChoice(choiceId: string): void;
    actionReady: Promise<void>; resolveActionReady(): void;
    controller: AbortController; promise: Promise<void>;
}
export interface SetupOptions { waitMs?: number; serverAlias?: string; }
export interface SetupDeps {
    desktop(): DesktopSetupDriver;
    lease(): Promise<() => Promise<void>>;
    check(ref: string, root?: string, token?: vscode.CancellationToken): Promise<string>;
    timeoutMs?: number;
    cleanupWaitMs?: number;
}
const defaults: SetupDeps = {
    desktop: () => createColabNativeDriver(vscode.workspace.getConfiguration('jupyterMcp').get<number>('nativeDebugPort', 0) ?? 0),
    lease: acquireDesktopLease,
    check: (notebookRef, colabFileUri, token) => checkColabRuntime({ notebookRef, colabFileUri }, token)
};
const setups = new Map<string, Setup>();
class SetupFailure extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new SetupFailure(code, message); }
function alive(signal: AbortSignal): void { if (signal.aborted) fail('cancelled', 'Colab setup was cancelled or reached its five-minute deadline.'); }
async function bounded<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
    alive(signal);
    let reject!: (error: Error) => void;
    const aborted = new Promise<never>((_, no) => { reject = no; });
    const onAbort = () => reject(new SetupFailure('cancelled', 'Colab setup was cancelled or reached its five-minute deadline.'));
    signal.addEventListener('abort', onAbort, { once: true });
    try { return await Promise.race([Promise.resolve(promise), aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
}
async function pause(signal: AbortSignal): Promise<void> { await bounded(new Promise<void>((resolve) => setTimeout(resolve, 200)), signal); }
function receipt(job: Setup): string {
    const actionRequired = job.stage === 'awaiting_kernel_selection' ? {
        kind: 'kernel_selection',
        listTool: 'list_setup_kernels',
        selectTool: 'select_setup_kernel',
        choicesListed: !!job.kernelChoices,
        listingVersion: job.kernelChoices ? job.kernelListingVersion : undefined
    } : undefined;
    return JSON.stringify({ setupId: job.id, notebook: job.notebook, operation: job.operation, serverAlias: job.serverAlias,
        runtime: 'colab', status: job.endedAt ? job.state : 'running', stage: job.stage,
        ready: !!job.endedAt && job.state === 'ready', startedAt: job.startedAt, endedAt: job.endedAt,
        code: job.code, reason: job.reason, failedStage: job.failedStage,
        providerStep: job.stage === 'selecting_provider' ? job.providerStep : undefined,
        failedProviderStep: job.failedProviderStep, desktopOperation: job.desktopOperation,
        desktopError: job.desktopError, verification: job.verification,
        startupCellRetained: job.startupCellRetained ?? false, serverMayRemain: job.serverMayRemain ?? false,
        cleanupPending: job.cleanupPending ?? false, actionRequired }, null, 2);
}
function validateWait(value: number | undefined, fallback: number): number {
    const wait = value ?? fallback;
    if (!Number.isSafeInteger(wait) || wait < 0 || wait > 60_000) throw new Error('waitMs must be an integer from 0 to 60000.');
    return wait;
}
async function waitForReceipt(job: Setup, wait: number, stopAtAction = true): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (wait && !job.endedAt) {
        const actionTransition = !stopAtAction ? job.promise : job.stage === 'awaiting_kernel_selection'
            ? Promise.resolve()
            : job.actionReady.then(() => job.stage === 'awaiting_kernel_selection' ? undefined : job.promise);
        try { await Promise.race([job.promise, actionTransition, new Promise<void>((resolve) => { timer = setTimeout(resolve, wait); })]); }
        finally { if (timer) clearTimeout(timer); }
    }
    return receipt(job);
}

/** Only the owner may remove this cross-window desktop lease. Never expire a live holder. */
export async function acquireDesktopLease(directory = path.join(os.tmpdir(), 'jupyter-mcp-colab-setup-' + crypto.createHash('sha256').update(os.homedir()).digest('hex').slice(0, 16))): Promise<() => Promise<void>> {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'desktop.lock');
    const value = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await fs.promises.writeFile(file, value, { flag: 'wx', mode: 0o600 });
            return async () => { if (await fs.promises.readFile(file, 'utf8').catch(() => '') === value) await fs.promises.unlink(file).catch(() => undefined); };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fail('desktop_lock_failed', 'Cannot acquire the local Colab setup lock.');
            // Serialize stale-owner recovery, so two reapers cannot unlink a new holder.
            const reaping = file + '.reaping';
            let handle: fs.promises.FileHandle;
            try { handle = await fs.promises.open(reaping, 'wx', 0o600); }
            catch { break; }
            try {
                const old = await fs.promises.readFile(file, 'utf8').catch(() => '');
                let pid: unknown;
                try { pid = JSON.parse(old).pid; } catch { /* Unknown locks are never removed. */ }
                if (!Number.isSafeInteger(pid) || Number(pid) <= 0) break;
                try { process.kill(Number(pid), 0); break; }
                catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') break; }
                if (await fs.promises.readFile(file, 'utf8').catch(() => '') !== old) break;
                await fs.promises.unlink(file).catch(() => undefined);
            } finally { await handle.close(); await fs.promises.unlink(reaping).catch(() => undefined); }
        }
    }
    fail('desktop_busy', 'Another Colab setup still owns the desktop. Wait for it to finish or cancel it in its owning window.');
}

export function assertNoColabSetup(ref: string): void {
    if ([...setups.values()].some((job) => job.notebook === ref && (!job.endedAt || job.cleanupPending))) {
        throw new Error('Colab setup is still active for this notebook. Inspect or cancel it before another notebook operation.');
    }
}
export function hasGlobalColabSetupWork(): boolean {
    return [...setups.values()].some(job => !job.endedAt || job.cleanupPending);
}
export async function configureColab(ref: string, options: SetupOptions = {}, deps = defaults): Promise<string> {
    const wait = validateWait(options.waitMs, 1000);
    if (options.serverAlias !== undefined) validateServerAlias(options.serverAlias);
    const job = startSetup(ref, 'configure_kernel', deps, options.serverAlias);
    return waitForReceipt(job, wait);
}

export async function mountColabServer(ref: string, serverAlias: string, options: SetupOptions = {}, deps = defaults): Promise<string> {
    const wait = validateWait(options.waitMs, 1000);
    validateServerAlias(serverAlias);
    const job = startSetup(ref, 'mount_colab_server', deps, serverAlias);
    return waitForReceipt(job, wait);
}

function validateServerAlias(serverAlias: unknown): asserts serverAlias is string {
    if (typeof serverAlias !== 'string' || !/^m[a-f0-9]{8}$/.test(serverAlias)) {
        throw new Error('serverAlias must be an exact MCP-generated alias such as m0123abcd.');
    }
}

function startSetup(ref: string, operation: SetupOperation, deps: SetupDeps, serverAlias?: string): Setup {
    if (!findNotebook(ref)) throw new Error('The target notebook is no longer open.');
    assertNoColabSetup(ref);
    if ([...setups.values()].some((job) => !job.endedAt || job.cleanupPending)) throw new Error('This VS Code window already has an active Colab setup.');
    while (setups.size >= MAX_HISTORY) {
        const oldest = [...setups.values()].find((job) => job.endedAt && !job.cleanupPending);
        if (!oldest) throw new Error('Colab setup history is full.');
        setups.delete(oldest.id);
    }
    let resolveKernelChoice!: (choiceId: string) => void;
    const kernelChoiceGate = new Promise<string>((resolve) => { resolveKernelChoice = resolve; });
    let resolveActionReady!: () => void;
    const actionReady = new Promise<void>((resolve) => { resolveActionReady = resolve; });
    const job: Setup = {
        id: 'setup_' + crypto.randomUUID(), notebook: ref, operation, serverAlias, state: 'running', stage: 'preflight', startedAt: new Date().toISOString(),
        kernelListingVersion: 0, kernelChoiceQueue: Promise.resolve(), kernelChoiceGate, resolveKernelChoice,
        actionReady, resolveActionReady, controller: new AbortController(), promise: Promise.resolve()
    };
    setups.set(job.id, job);
    job.promise = performSetup(job, deps).catch(() => {
        job.state = 'failed'; job.code = 'setup_internal_failure';
        job.reason = 'Colab setup could not complete its lifecycle cleanup; no readiness is claimed.';
        job.endedAt = new Date().toISOString();
    });
    return job;
}
export async function getColabSetup(ref: string, setupId?: string, waitMs?: number, cancel = false): Promise<string> {
    const wait = validateWait(waitMs, 0);
    const job = setupId ? setups.get(setupId) : [...setups.values()].reverse().find((value) => value.notebook === ref);
    if (!job || job.notebook !== ref) throw new Error('No matching Colab setup exists in this window lifetime.');
    if (cancel && !job.endedAt) job.controller.abort();
    return waitForReceipt(job, wait, !cancel);
}

/** Observe only the exact setup-owned post-alias kernel picker. A fresh listing invalidates earlier ids. */
export async function listColabSetupKernels(ref: string, setupId: string): Promise<string> {
    const job = requireSetup(ref, setupId);
    return withKernelChoiceLock(job, async () => {
        requireAwaitingKernelChoice(job);
        const driver = job.driver;
        const header = job.kernelHeader;
        if (!driver?.listChoices || !header) throw new Error('This setup cannot list kernel choices safely.');
        job.kernelChoices = undefined;
        let observed: DesktopSetupChoice[];
        try { observed = await driver.listChoices([header], job.controller.signal); }
        catch (error) {
            if (error instanceof DesktopSetupError) throw error;
            throw new Error(job.controller.signal.aborted
                ? 'The Colab setup was cancelled before kernel choices could be listed.'
                : 'The setup-owned kernel choices could not be listed safely.');
        }
        const choices = validateKernelChoices(observed);
        requireAwaitingKernelChoice(job);
        job.kernelListingVersion++;
        job.kernelChoices = new Map(choices.map((choice) => [choice.choiceId, choice]));
        return JSON.stringify({
            setupId: job.id,
            notebook: job.notebook,
            status: 'awaiting_kernel_selection',
            stage: job.stage,
            listingVersion: job.kernelListingVersion,
            choices
        }, null, 2);
    });
}

/** Accept exactly one id from the latest setup-owned listing; the background workflow performs the action. */
export async function selectColabSetupKernel(ref: string, setupId: string, choiceId: string, waitMs?: number): Promise<string> {
    const wait = validateWait(waitMs, 1000);
    const job = requireSetup(ref, setupId);
    if (typeof choiceId !== 'string' || !choiceId) throw new Error('kernelChoiceId is required');
    await withKernelChoiceLock(job, async () => {
        requireAwaitingKernelChoice(job);
        const choice = job.kernelChoices?.get(choiceId);
        if (!choice) throw new Error('kernelChoiceId is stale or was not returned by the latest list_setup_kernels call.');
        job.kernelChoices = undefined;
        job.stage = 'selecting_python';
        job.resolveKernelChoice(choice.choiceId);
    });
    return waitForReceipt(job, wait);
}

export function disposeColabSetups(): void { for (const job of setups.values()) if (!job.endedAt) job.controller.abort(); }

function requireSetup(ref: string, setupId: string): Setup {
    const job = setups.get(setupId);
    if (!job || job.notebook !== ref) throw new Error('No matching Colab setup exists in this window lifetime.');
    return job;
}

function requireAwaitingKernelChoice(job: Setup): void {
    if (job.endedAt || job.controller.signal.aborted || job.state !== 'running' || job.stage !== 'awaiting_kernel_selection') {
        throw new Error('This Colab setup is not awaiting kernel selection.');
    }
}

async function withKernelChoiceLock<T>(job: Setup, work: () => Promise<T>): Promise<T> {
    const previous = job.kernelChoiceQueue;
    let release!: () => void;
    job.kernelChoiceQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
}

function validateKernelChoices(observed: DesktopSetupChoice[]): DesktopSetupChoice[] {
    if (!Array.isArray(observed) || observed.length === 0 || observed.length > 32) {
        throw new Error('The setup kernel choice listing is empty or exceeds its safe bound.');
    }
    const ids = new Set<string>();
    return observed.map((choice) => {
        if (!choice || typeof choice.choiceId !== 'string' || typeof choice.label !== 'string' ||
            !choice.choiceId || choice.choiceId.length > 160 || !choice.label || choice.label.length > 256 ||
            /[\r\n\0]/.test(choice.choiceId) || /[\r\n\0]/.test(choice.label) || ids.has(choice.choiceId)) {
            throw new Error('The setup kernel choice listing is malformed or ambiguous.');
        }
        ids.add(choice.choiceId);
        return { choiceId: choice.choiceId, label: choice.label };
    });
}

function workspaceAliasRoots(alias: string): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.name === alias && folder.uri.scheme === 'colab' && !!folder.uri.authority && !folder.uri.query && !folder.uri.fragment)
        .map((folder) => folder.uri.with({ path: '/', query: '', fragment: '' }).toString());
}

async function performSetup(job: Setup, deps: SetupDeps): Promise<void> {
    const signal = job.controller.signal;
    const timer = setTimeout(() => job.controller.abort(), deps.timeoutMs ?? SETUP_TIMEOUT_MS);
    const token = new vscode.CancellationTokenSource();
    const cancelToken = () => token.cancel();
    signal.addEventListener('abort', cancelToken, { once: true });
    let driver: DesktopSetupDriver | undefined;
    let marker: vscode.StatusBarItem | undefined;
    let release: (() => Promise<void>) | undefined;
    let startup: { doc: vscode.NotebookDocument; uri?: string; source: string; dispatch?: Promise<unknown>; complete: boolean } | undefined;
    const commands: Promise<unknown>[] = [];
    const tracked = <T>(work: PromiseLike<T>) => { const promise = Promise.resolve(work); void promise.catch(() => undefined); commands.push(promise); return promise; };
    const command = (id: string, ...args: unknown[]) => {
        alive(signal);
        return tracked(vscode.commands.executeCommand(id, ...args));
    };
    const cleanupWait = async <T>(promise: Promise<T>): Promise<T> => {
        const cleanup = new AbortController(); const timer = setTimeout(() => cleanup.abort(), deps.cleanupWaitMs ?? 5000);
        try { return await bounded(promise, cleanup.signal); }
        catch (error) {
            if (cleanup.signal.aborted) fail('cleanup_timeout', 'Setup cleanup exceeded its bounded wait; pending work may still finish. Inspect retained-cell and cleanup status.');
            throw error;
        } finally { clearTimeout(timer); }
    };
    let removingStartup: Promise<void> | undefined;
    let originalNotebook: vscode.NotebookDocument | undefined;
    const current = () => {
        alive(signal);
        if (!originalNotebook || originalNotebook.isClosed || findNotebook(job.notebook) !== originalNotebook) fail('notebook_changed', 'The target notebook closed or was replaced during setup.');
        return originalNotebook;
    };
    try {
        if (vscode.env.remoteName) fail('remote_host_unsupported', 'Automatic Colab setup needs a local VS Code extension host and desktop.');
        if (!vscode.workspace.isTrusted) fail('workspace_untrusted', 'Trust this workspace through VS Code before Colab setup.');
        if (!vscode.workspace.workspaceFolders?.length) fail('workspace_required', 'Open a folder or workspace before Colab setup; automatic setup cannot reload an empty window while mounting.');
        const extension = vscode.extensions.getExtension('google.colab');
        if (!extension) fail('colab_missing', 'Install the Google Colab extension before automatic Colab setup.');
        if (extension.packageJSON?.version !== '0.9.7') fail('colab_version_unsupported', 'Automatic picker setup currently supports Google Colab 0.9.7. Other versions need an adapter check.');
        originalNotebook = findNotebook(job.notebook);
        if (!originalNotebook) fail('notebook_changed', 'The target notebook is no longer open.');
        if (hasPendingNotebookExecutionCommand(originalNotebook.uri.toString())) {
            fail('execution_command_pending', 'A notebook execution command is still pending in VS Code/Jupyter. Wait for command settlement before Colab setup.');
        }
        // Never interleave setup with the existing tracked scientific runner.
        try {
            const run = JSON.parse(await getExecution(job.notebook, {}));
            if (['requested', 'running'].includes(run.status)) fail('execution_active', 'Wait for the notebook execution to finish before Colab setup.');
        } catch (error) { if (error instanceof SetupFailure) throw error; }
        const jupyterExtension = vscode.extensions.getExtension<{ kernels?: { getKernel(uri: vscode.Uri): Thenable<SetupKernel | undefined> } }>('ms-toolsai.jupyter');
        if (!jupyterExtension) fail('jupyter_api_unavailable', 'The public Jupyter kernel API is unavailable.');
        const jupyter = await bounded(jupyterExtension.activate(), signal);
        if (!jupyter?.kernels?.getKernel) fail('jupyter_api_unavailable', 'The public Jupyter kernel API is unavailable.');
        const active = await bounded(jupyter.kernels.getKernel(originalNotebook.uri), signal);
        if (active && active.status !== 'idle') fail('kernel_busy', 'Wait for the current kernel to become idle before Colab setup.');
        // VS Code can report isActive after a failed activation. activate() also
        // checks the cached activation error, so always await it before any UI.
        try { await bounded(extension.activate(), signal); }
        catch {
            alive(signal);
            fail('colab_activation_failed', 'The Colab extension failed to activate. Check its Output log and restore connectivity, then reload this VS Code window before retrying. No kernel picker was opened.');
        }
        if (job.operation === 'mount_colab_server') {
            if (!active) fail('active_kernel_required', 'Mount recovery requires an already active Colab kernel; no kernel was selected or started.');
            if ((active.language ?? '').toLowerCase() !== 'python') fail('kernel_language_unsupported', 'Mount recovery requires the already active kernel to use Python.');
            if ((active.status ?? '').toLowerCase() !== 'idle') fail('kernel_busy', 'Wait for the active Python kernel to become idle before mounting its Colab server.');
            if (typeof active.executeCode !== 'function') fail('jupyter_api_unavailable', 'The active Python kernel lacks the public execution API required for Colab verification.');
            const expectedKernel = active;
            const sameKernel = async () => {
                const observed = await bounded(jupyter.kernels!.getKernel(originalNotebook!.uri), signal);
                if (observed !== expectedKernel || (observed.status ?? '').toLowerCase() !== 'idle' || (observed.language ?? '').toLowerCase() !== 'python') {
                    fail('kernel_changed', 'The active Python kernel changed or became unavailable during mount recovery.');
                }
            };
            await sameKernel();
            const alias = job.serverAlias!;
            const existing = workspaceAliasRoots(alias);
            if (existing.length > 1) fail('filesystem_ambiguous', 'More than one mounted Colab workspace folder has the requested server alias.');
            let root: string;
            if (existing.length === 1) {
                root = existing[0];
            } else {
                release = await deps.lease(); alive(signal);
                driver = deps.desktop(); job.driver = driver;
                const editor = await bounded(vscode.window.showNotebookDocument(current(), { preview: false, preserveFocus: false }), signal);
                if (editor.notebook !== current()) fail('notebook_changed', 'VS Code revealed another notebook.');
                const markerText = 'MCP Colab setup ' + crypto.randomUUID();
                marker = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1_000_000);
                marker.text = markerText; marker.show();
                job.stage = 'binding_window'; await driver.bind(markerText, signal); current(); await sameKernel();
                job.stage = 'mounting_filesystem';
                const rootsBefore = new Set(getColabFileRoots());
                const mounting = command('colab.mountServer');
                const mountChoice = new AbortController();
                const abortMount = () => mountChoice.abort(); signal.addEventListener('abort', abortMount, { once: true });
                const choosing = driver.choose(['Mount Server to Workspace'], [alias], mountChoice.signal).catch((error) => {
                    if (!mountChoice.signal.aborted) throw error;
                });
                void choosing.catch(() => undefined);
                try {
                    while (true) {
                        current(); await sameKernel();
                        const added = getColabFileRoots().filter((candidate) => !rootsBefore.has(candidate));
                        if (added.length > 1) fail('filesystem_ambiguous', 'More than one Colab filesystem appeared during mount recovery.');
                        if (added.length === 1) {
                            const mounted = workspaceAliasRoots(alias);
                            if (mounted.length !== 1 || mounted[0] !== added[0]) {
                                fail('filesystem_alias_mismatch', 'The newly mounted Colab filesystem did not match the requested server alias.');
                            }
                            root = added[0]; break;
                        }
                        await Promise.race([pause(signal), choosing.then(() => pause(signal)), mounting.then(() => pause(signal))]);
                    }
                } finally { mountChoice.abort(); signal.removeEventListener('abort', abortMount); await choosing.catch(() => undefined); }
                await bounded(mounting, signal); current(); await sameKernel();
            }
            job.stage = 'verifying_runtime';
            const verification = JSON.parse(await bounded(tracked(deps.check(job.notebook, root!, token.token)), signal));
            await sameKernel();
            if (verification.verified !== true) fail('verification_failed', 'The mounted server did not pass same-kernel Colab filesystem verification.');
            job.verification = verification; job.state = 'ready'; return;
        }
        const requestedAlias = job.serverAlias;
        if (active && requestedAlias) {
            const matching = workspaceAliasRoots(requestedAlias);
            if (matching.length > 1) fail('filesystem_ambiguous', 'More than one mounted Colab workspace folder has the requested server alias.');
            if (matching.length === 1) {
                job.stage = 'verifying_runtime';
                const verified = JSON.parse(await bounded(tracked(deps.check(job.notebook, matching[0], token.token)), signal));
                if (verified.verified !== true) fail('verification_failed', 'The requested existing Colab server did not pass runtime verification.');
                job.verification = verified; job.state = 'ready'; return;
            }
        }
        const oldRoots = getColabFileRoots();
        if (active && !requestedAlias && oldRoots.length === 1) {
            job.stage = 'verifying_runtime';
            const verified = JSON.parse(await bounded(tracked(deps.check(job.notebook, oldRoots[0], token.token)), signal));
            if (verified.verified !== true) fail('verification_failed', 'The existing kernel did not pass Colab verification.');
            job.verification = verified; job.state = 'ready'; return;
        }
        release = await deps.lease(); alive(signal);
        driver = deps.desktop();
        if (typeof driver.listChoices !== 'function' || typeof driver.chooseListed !== 'function') {
            fail('kernel_choice_unsupported', 'The desktop adapter cannot list and select setup-owned kernel choices safely.');
        }
        job.driver = driver;
        const editor = await bounded(vscode.window.showNotebookDocument(current(), { preview: false, preserveFocus: false }), signal);
        if (editor.notebook !== current()) fail('notebook_changed', 'VS Code revealed another notebook.');
        const markerText = 'MCP Colab setup ' + crypto.randomUUID();
        marker = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1_000_000);
        marker.text = markerText; marker.show();
        job.stage = 'binding_window'; await driver.bind(markerText, signal); current();
        job.stage = 'selecting_provider'; job.providerStep = 'opening_kernel_picker';
        const selection = command('notebook.selectKernel', { notebookEditor: editor });
        // A rejected/false command means VS Code has already closed this picker. Race
        // every provider step against that outcome, while deliberately ignoring an
        // early true until an explicitly listed choice has been selected below.
        const selectionFailure: Promise<void> = selection.then(
            (confirmed) => confirmed === true ? new Promise<void>(() => undefined) : undefined,
            () => undefined
        );
        const picker = async <T>(work: (stepSignal: AbortSignal) => Promise<T>): Promise<T> => {
            const step = new AbortController();
            const abortStep = () => step.abort();
            signal.addEventListener('abort', abortStep, { once: true });
            let selectionEnded = false;
            const ended = selectionFailure.then(() => { selectionEnded = true; step.abort(); fail('kernel_selection_unconfirmed', 'VS Code closed the notebook kernel picker before an explicit setup kernel was selected.'); });
            try { return await bounded(Promise.race([work(step.signal), ended]), signal); }
            catch (error) {
                if (selectionEnded) fail('kernel_selection_unconfirmed', 'VS Code closed the notebook kernel picker before an explicit setup kernel was selected.');
                throw error;
            } finally { signal.removeEventListener('abort', abortStep); }
        };
        // VS Code first shows notebook-specific suggestions when controllers are
        // already available. Match this exact target's relative label, never a
        // generic "Select kernel for" prefix or an inferred default controller.
        const relativeLabel = vscode.workspace.asRelativePath(originalNotebook.uri, false);
        const notebookFolder = vscode.workspace.getWorkspaceFolder(originalNotebook.uri);
        const folderPrefix = notebookFolder && (vscode.workspace.workspaceFolders?.length ?? 0) > 1
            ? `${notebookFolder.name} • ` : '';
        // The public API returns slash-separated relative paths; the Windows
        // workbench's file label uses backslashes. Both are exact target labels.
        const notebookLabels = [...new Set([relativeLabel, relativeLabel.split('/').join(path.sep)].map(label => {
            // Outside a workspace, asRelativePath returns URI.fsPath with a
            // lowercase drive. The Windows workbench label uppercases only
            // that drive letter. Keep the entire remaining target path exact.
            if (process.platform === 'win32' && !notebookFolder && editor.notebook.uri.scheme === 'file' && /^[a-zA-Z]:[\\/]/.test(label)) {
                label = label[0].toUpperCase() + label.slice(1);
            }
            return folderPrefix + label;
        }))];
        // A remembered controller can open the source picker directly after a
        // workspace/extension-host refresh, without the suggestions screen.
        const initialHeaders = ['Select Kernel', 'Select Another Kernel', ...notebookLabels.flatMap(label => [`Select kernel for '${label}'`, `Change kernel for '${label}'`])];
        const first = await picker((stepSignal) => driver!.choose(initialHeaders, ['Select Another Kernel...', 'Colab'], stepSignal));
        if (first !== 'Colab') {
            job.providerStep = 'choosing_colab_source';
            await picker((stepSignal) => driver!.choose(['Select Kernel', 'Select Another Kernel'], ['Colab'], stepSignal));
        }
        // After a workspace refresh VS Code can reopen its source picker once
        // before handing control to Colab. Require an empty new prompt, then
        // permit only one additional exact Colab selection, never a retry loop.
        job.providerStep = 'awaiting_server_picker';
        const providerPrompt = await picker((stepSignal) => driver!.waitForInput(['Select a Jupyter Server', 'Select Kernel', 'Select Another Kernel'], stepSignal));
        if (providerPrompt !== 'Select a Jupyter Server') {
            job.providerStep = 'choosing_colab_handoff';
            await picker((stepSignal) => driver!.choose([providerPrompt], ['Colab'], stepSignal));
        }
        let alias: string;
        if (requestedAlias) {
            alias = requestedAlias;
            job.providerStep = 'choosing_existing_server';
            await picker((stepSignal) => driver!.choose(['Select a Jupyter Server'], [alias], stepSignal)); current();
        } else {
            job.providerStep = 'choosing_new_server';
            await picker((stepSignal) => driver!.choose(['Select a Jupyter Server'], ['New Colab Server'], stepSignal)); current();
            job.stage = 'creating_cpu_server';
            await picker((stepSignal) => driver!.choose(['Select a variant'], ['CPU'], stepSignal));
            let next = await picker((stepSignal) => driver!.waitForInput(['Select a machine shape', 'Select a runtime version', 'Alias your server'], stepSignal));
            if (next === 'Select a machine shape') {
                await picker((stepSignal) => driver!.choose([next], ['Standard'], stepSignal));
                next = await picker((stepSignal) => driver!.waitForInput(['Select a runtime version', 'Alias your server'], stepSignal));
            }
            if (next === 'Select a runtime version') {
                await picker((stepSignal) => driver!.choose([next], ['Latest'], stepSignal));
                await picker((stepSignal) => driver!.waitForInput(['Alias your server'], stepSignal));
            }
            // Colab 0.9.7 rejects aliases longer than ten characters. Nine also
            // satisfies its user-facing "less than 10" validation message.
            alias = 'm' + crypto.randomBytes(4).toString('hex');
            job.serverAlias = alias;
            // The provider can finish a non-cancellable assignment after a cancelled setup.
            job.serverMayRemain = true;
            job.stage = 'naming_server';
            await picker((stepSignal) => driver!.enter(['Alias your server'], alias, stepSignal)); current();
        }
        job.kernelHeader = 'Select a Kernel from ' + alias;
        job.kernelChoices = undefined;
        job.stage = 'awaiting_kernel_selection';
        job.resolveActionReady();
        const kernelChoiceId = await bounded(Promise.race([
            job.kernelChoiceGate,
            selectionFailure.then(() => fail('kernel_selection_unconfirmed', 'VS Code closed the notebook kernel picker before an explicit setup kernel was selected.'))
        ]), signal);
        current();
        await driver.chooseListed!([job.kernelHeader], kernelChoiceId, signal);
        if (await bounded(selection, signal) !== true) fail('kernel_selection_unconfirmed', 'VS Code did not confirm the exact notebook kernel selection.');
        current(); job.stage = 'starting_kernel';
        const source = '# jupyter-mcp-colab-startup ' + crypto.randomUUID() + '\npass';
        const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, 'python');
        const edit = new vscode.WorkspaceEdit();
        edit.set(originalNotebook.uri, [vscode.NotebookEdit.insertCells(originalNotebook.cellCount, [data])]);
        // Record possible insertion before dispatch: an editor request may finish after cancellation.
        startup = { doc: originalNotebook, source, complete: false }; job.startupCellRetained = true;
        if (!await bounded(tracked(vscode.workspace.applyEdit(edit)), signal)) {
            startup = undefined; job.startupCellRetained = false;
            fail('startup_edit_failed', 'Cannot insert the temporary Colab startup cell.');
        }
        const cell = current().getCells().find((candidate) => candidate.document.getText() === source);
        if (!cell) fail('startup_edit_failed', 'The temporary startup cell was not found.');
        startup = { doc: originalNotebook, uri: cell.document.uri.toString(), source, complete: false };
        job.startupCellRetained = true;
        startup.dispatch = command('notebook.cell.execute', { document: originalNotebook.uri, ranges: [{ start: cell.index, end: cell.index + 1 }] });
        let dispatchError = false; void startup.dispatch.catch(() => { dispatchError = true; });
        while (true) {
            const owned = current().getCells().find((candidate) => candidate.document.uri.toString() === startup!.uri);
            if (!owned || owned.document.getText() !== source) fail('startup_cell_changed', 'The temporary startup cell was edited or removed; setup stopped.');
            if (dispatchError || owned.executionSummary?.success === false) fail('startup_failed', 'The Colab startup cell failed.');
            if (owned.executionSummary?.success === true && owned.executionSummary.timing?.endTime !== undefined) {
                startup.complete = true; break;
            }
            await pause(signal);
        }
        await bounded(startup.dispatch, signal);
        await cleanupWait(removeStartup()); current();
        job.stage = 'mounting_filesystem';
        const rootsBefore = new Set(getColabFileRoots());
        const mounting = command('colab.mountServer');
        let mountingDone = false; void mounting.then(() => { mountingDone = true; }, () => undefined);
        const mountChoice = new AbortController();
        const abortMount = () => mountChoice.abort(); signal.addEventListener('abort', abortMount, { once: true });
        // A single server mounts directly. With several, select only our exact alias.
        const choosing = driver.choose(['Mount Server to Workspace'], [alias], mountChoice.signal).catch((error) => {
            if (!mountChoice.signal.aborted) throw error;
        });
        void choosing.catch(() => undefined);
        let root: string;
        try {
            while (true) {
                current();
                const added = getColabFileRoots().filter((candidate) => !rootsBefore.has(candidate));
                if (added.length > 1) fail('filesystem_ambiguous', 'More than one Colab filesystem appeared during setup.');
                if (added.length === 1) {
                    if (requestedAlias) {
                        const mounted = workspaceAliasRoots(alias);
                        if (mounted.length !== 1 || mounted[0] !== added[0]) fail('filesystem_alias_mismatch', 'The newly mounted Colab filesystem did not match the requested server alias.');
                    }
                    root = added[0]; break;
                }
                if (requestedAlias && mountingDone) {
                    const mounted = workspaceAliasRoots(alias);
                    if (mounted.length > 1) fail('filesystem_ambiguous', 'More than one mounted Colab workspace folder has the requested server alias.');
                    if (mounted.length === 1) { root = mounted[0]; break; }
                }
                await Promise.race([pause(signal), choosing.then(() => pause(signal)), mounting.then(() => pause(signal))]);
            }
        } finally { mountChoice.abort(); signal.removeEventListener('abort', abortMount); await choosing.catch(() => undefined); }
        await bounded(mounting, signal); current();
        job.stage = 'verifying_runtime';
        const verification = JSON.parse(await bounded(tracked(deps.check(job.notebook, root!, token.token)), signal));
        current();
        if (verification.verified !== true) fail('verification_failed', 'Colab setup did not pass runtime and filesystem verification.');
        job.verification = verification; job.state = 'ready'; job.serverMayRemain = false;
    } catch (error) {
        job.failedStage = job.stage;
        if (job.stage === 'selecting_provider') job.failedProviderStep = job.providerStep;
        if (error instanceof DesktopSetupError) { job.desktopOperation = error.operation; job.desktopError = error.providerCode; }
        job.state = signal.aborted ? 'cancelled' : 'failed';
        if (error instanceof SetupFailure || error instanceof DesktopSetupError) { job.code = error.code; job.reason = error.message; }
        else { job.code = 'setup_failed'; job.reason = 'Colab setup failed at ' + job.stage + '. Check the normal Colab/Jupyter UI for sign-in, consent, quota, or connection errors. No readiness is claimed.'; }
    } finally {
        clearTimeout(timer); signal.removeEventListener('abort', cancelToken); token.dispose();
        // Never delete a queued/running or user-modified cell. A failed setup leaves it visible.
        await cleanupWait(removeStartup()).catch(() => { job.startupCellRetained = true; });
        if (marker) await cleanupWait(tracked(vscode.commands.executeCommand('workbench.action.closeQuickOpen'))).catch(() => undefined);
        marker?.dispose(); driver?.dispose(); job.driver = undefined; job.kernelChoices = undefined;
        const settled = Promise.allSettled(commands);
        let complete = false; void settled.then(() => { complete = true; });
        await Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
        if (complete) { if (release) await release(); }
        else {
            job.cleanupPending = true;
            void settled.then(async () => { if (release) await release(); job.cleanupPending = false; });
        }
        job.stage = 'finished'; job.endedAt = new Date().toISOString();
    }
    async function removeStartup(): Promise<void> {
        if (removingStartup) return removingStartup;
        if (!startup || !startup.complete || startup.doc.isClosed) return;
        const owned = startup.doc.getCells().find((candidate) => candidate.document.uri.toString() === startup!.uri);
        if (!owned || owned.document.getText() !== startup.source) return;
        const edit = new vscode.WorkspaceEdit();
        edit.set(startup.doc.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(owned.index, owned.index + 1))]);
        const target = startup;
        removingStartup = tracked(vscode.workspace.applyEdit(edit)).then((applied) => {
            if (!applied || target.doc.getCells().some((candidate) => candidate.document.uri.toString() === target.uri)) throw new Error('startup cleanup not observed');
            job.startupCellRetained = false; startup = undefined;
        });
        void removingStartup.catch(() => undefined);
        return removingStartup;
    }
}
