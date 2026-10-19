import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createColabDesktopDriver, DesktopSetupDriver, DesktopSetupError } from './colabDesktop';
import { checkColabRuntime, getColabFileRoots } from './kernelFiles';
import { findNotebook, getExecution } from './notebookOps';

const SETUP_TIMEOUT_MS = 300_000;
const MAX_HISTORY = 16;
type Stage = 'preflight' | 'binding_window' | 'selecting_provider' | 'creating_cpu_server' | 'naming_server' | 'selecting_python' | 'starting_kernel' | 'mounting_filesystem' | 'verifying_runtime' | 'finished';
type State = 'running' | 'ready' | 'failed' | 'cancelled';
interface Setup {
    id: string; notebook: string; state: State; stage: Stage; startedAt: string;
    endedAt?: string; reason?: string; code?: string; verification?: unknown; failedStage?: Stage;
    startupCellRetained?: boolean; serverMayRemain?: boolean; cleanupPending?: boolean;
    desktopOperation?: string; desktopError?: string;
    controller: AbortController; promise: Promise<void>;
}
export interface SetupOptions { waitMs?: number; }
export interface SetupDeps {
    desktop(): DesktopSetupDriver;
    lease(): Promise<() => Promise<void>>;
    check(ref: string, root?: string, token?: vscode.CancellationToken): Promise<string>;
    timeoutMs?: number;
    cleanupWaitMs?: number;
}
const defaults: SetupDeps = {
    desktop: () => createColabDesktopDriver(vscode.workspace.getConfiguration('jupyterMcp').get<string>('orcaPath') || undefined),
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
    return JSON.stringify({ setupId: job.id, notebook: job.notebook, runtime: 'colab', status: job.endedAt ? job.state : 'running', stage: job.stage,
        ready: !!job.endedAt && job.state === 'ready', startedAt: job.startedAt, endedAt: job.endedAt,
        code: job.code, reason: job.reason, failedStage: job.failedStage, desktopOperation: job.desktopOperation,
        desktopError: job.desktopError, verification: job.verification,
        startupCellRetained: job.startupCellRetained ?? false, serverMayRemain: job.serverMayRemain ?? false,
        cleanupPending: job.cleanupPending ?? false }, null, 2);
}
function validateWait(value: number | undefined, fallback: number): number {
    const wait = value ?? fallback;
    if (!Number.isSafeInteger(wait) || wait < 0 || wait > 60_000) throw new Error('waitMs must be an integer from 0 to 60000.');
    return wait;
}
async function waitForReceipt(job: Setup, wait: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (wait && !job.endedAt) {
        try { await Promise.race([job.promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, wait); })]); }
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
export async function configureColab(ref: string, options: SetupOptions = {}, deps = defaults): Promise<string> {
    const wait = validateWait(options.waitMs, 1000);
    if (!findNotebook(ref)) throw new Error('The target notebook is no longer open.');
    assertNoColabSetup(ref);
    if ([...setups.values()].some((job) => !job.endedAt || job.cleanupPending)) throw new Error('This VS Code window already has an active Colab setup.');
    while (setups.size >= MAX_HISTORY) {
        const oldest = [...setups.values()].find((job) => job.endedAt && !job.cleanupPending);
        if (!oldest) throw new Error('Colab setup history is full.');
        setups.delete(oldest.id);
    }
    const job: Setup = { id: 'setup_' + crypto.randomUUID(), notebook: ref, state: 'running', stage: 'preflight', startedAt: new Date().toISOString(), controller: new AbortController(), promise: Promise.resolve() };
    setups.set(job.id, job);
    job.promise = performSetup(job, deps).catch(() => {
        job.state = 'failed'; job.code = 'setup_internal_failure';
        job.reason = 'Colab setup could not complete its lifecycle cleanup; no readiness is claimed.';
        job.endedAt = new Date().toISOString();
    });
    return waitForReceipt(job, wait);
}
export async function getColabSetup(ref: string, setupId?: string, waitMs?: number, cancel = false): Promise<string> {
    const wait = validateWait(waitMs, 0);
    const job = setupId ? setups.get(setupId) : [...setups.values()].reverse().find((value) => value.notebook === ref);
    if (!job || job.notebook !== ref) throw new Error('No matching Colab setup exists in this window lifetime.');
    if (cancel && !job.endedAt) job.controller.abort();
    return waitForReceipt(job, wait);
}
export function disposeColabSetups(): void { for (const job of setups.values()) if (!job.endedAt) job.controller.abort(); }

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
        // Never interleave setup with the existing tracked scientific runner.
        try {
            const run = JSON.parse(await getExecution(job.notebook, {}));
            if (['requested', 'running'].includes(run.status)) fail('execution_active', 'Wait for the notebook execution to finish before Colab setup.');
        } catch (error) { if (error instanceof SetupFailure) throw error; }
        const jupyterExtension = vscode.extensions.getExtension<{ kernels?: { getKernel(uri: vscode.Uri): Thenable<{ status?: string } | undefined> } }>('ms-toolsai.jupyter');
        if (!jupyterExtension) fail('jupyter_api_unavailable', 'The public Jupyter kernel API is unavailable.');
        const jupyter = await bounded(jupyterExtension.activate(), signal);
        if (!jupyter?.kernels?.getKernel) fail('jupyter_api_unavailable', 'The public Jupyter kernel API is unavailable.');
        const active = await bounded(jupyter.kernels.getKernel(originalNotebook.uri), signal);
        if (active && active.status !== 'idle') fail('kernel_busy', 'Wait for the current kernel to become idle before Colab setup.');
        if (!extension.isActive) await bounded(extension.activate(), signal);
        const oldRoots = getColabFileRoots();
        if (active && oldRoots.length === 1) {
            job.stage = 'verifying_runtime';
            const verified = JSON.parse(await bounded(tracked(deps.check(job.notebook, oldRoots[0], token.token)), signal));
            if (verified.verified !== true) fail('verification_failed', 'The existing kernel did not pass Colab verification.');
            job.verification = verified; job.state = 'ready'; return;
        }
        release = await deps.lease(); alive(signal);
        driver = deps.desktop();
        const editor = await bounded(vscode.window.showNotebookDocument(current(), { preview: false, preserveFocus: false }), signal);
        if (editor.notebook !== current()) fail('notebook_changed', 'VS Code revealed another notebook.');
        const markerText = 'MCP Colab setup ' + crypto.randomUUID();
        marker = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1_000_000);
        marker.text = markerText; marker.show();
        job.stage = 'binding_window'; await driver.bind(markerText, signal); current();
        job.stage = 'selecting_provider';
        const selection = command('notebook.selectKernel', { notebookEditor: editor });
        const first = await driver.choose(['Select Kernel'], ['Select Another Kernel...', 'Colab'], signal);
        if (first !== 'Colab') await driver.choose(['Select Kernel'], ['Colab'], signal);
        await driver.choose(['Select a Jupyter Server'], ['New Colab Server'], signal); current();
        job.stage = 'creating_cpu_server';
        await driver.choose(['Select a variant'], ['CPU'], signal);
        let next = await driver.waitForInput(['Select a machine shape', 'Select a runtime version', 'Alias your server'], signal);
        if (next === 'Select a machine shape') {
            await driver.choose([next], ['Standard'], signal);
            next = await driver.waitForInput(['Select a runtime version', 'Alias your server'], signal);
        }
        if (next === 'Select a runtime version') {
            await driver.choose([next], ['Latest'], signal);
            await driver.waitForInput(['Alias your server'], signal);
        }
        // Colab 0.9.7 rejects aliases longer than ten characters. Nine also
        // satisfies its user-facing "less than 10" validation message.
        const alias = 'm' + crypto.randomBytes(4).toString('hex');
        // The provider can finish a non-cancellable assignment after a cancelled setup.
        job.serverMayRemain = true;
        job.stage = 'naming_server';
        await driver.enter(['Alias your server'], alias, signal); current();
        job.stage = 'selecting_python';
        await driver.choose(['Select a Kernel from ' + alias], ['Python 3 (ipykernel)', 'Python 3', 'python3'], signal);
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
                if (added.length === 1) { root = added[0]; break; }
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
        if (error instanceof DesktopSetupError) { job.desktopOperation = error.operation; job.desktopError = error.providerCode; }
        job.state = signal.aborted ? 'cancelled' : 'failed';
        if (error instanceof SetupFailure || error instanceof DesktopSetupError) { job.code = error.code; job.reason = error.message; }
        else { job.code = 'setup_failed'; job.reason = 'Colab setup failed at ' + job.stage + '. Check the normal Colab/Jupyter UI for sign-in, consent, quota, or connection errors. No readiness is claimed.'; }
    } finally {
        clearTimeout(timer); signal.removeEventListener('abort', cancelToken); token.dispose();
        // Never delete a queued/running or user-modified cell. A failed setup leaves it visible.
        await cleanupWait(removeStartup()).catch(() => { job.startupCellRetained = true; });
        if (marker) await cleanupWait(tracked(vscode.commands.executeCommand('workbench.action.closeQuickOpen'))).catch(() => undefined);
        marker?.dispose(); driver?.dispose();
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
