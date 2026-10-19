import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as vscode from 'vscode';

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const TRANSFER_CHUNK_BYTES = 256 * 1024;
export const TRANSFER_EXECUTION_TIMEOUT_MS = 60_000;
export const TRANSFER_CLEANUP_TIMEOUT_MS = 5_000;
// Large payloads must use a file service, not hundreds of kernel executions.
export const MAX_KERNEL_TRANSFER_BYTES = 4 * 1024 * 1024;
export const NATIVE_TRANSFER_TIMEOUT_MS = 120_000;
// Cumulative chunk payload (request code for uploads, base64 receipts for downloads) that one
// kernel object may carry. Colab runtimes were lost after roughly 90-150 MB of chunk traffic.
export const KERNEL_WIRE_BUDGET_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_CHARS = 2 * TRANSFER_CHUNK_BYTES + 4096;
const RECEIPT = '__JUPYTER_MCP_FILE_RECEIPT__';
// IPython stores the source of every executed cell in linecache for the kernel's lifetime,
// including executions outside history. Every transfer request starts with this tag and
// removes earlier tagged sources, so payload-bearing requests are not retained in memory.
export const TRANSFER_TAG = '# jupyter-mcp-transfer';
// Use zlib only when it saves at least this fraction; incompressible data is sent as is.
const COMPRESSION_RATIO = 0.9;
const kernelWireBytes = new WeakMap<ActiveKernelLike, number>();

export interface KernelOutputItem { mime?: string; data?: unknown; }
export interface KernelOutput { items?: KernelOutputItem[]; text?: unknown; value?: unknown; data?: unknown; }
export interface ActiveKernelLike { language?: string; status?: string; onDidChangeStatus?: (listener: (status: string) => void) => { dispose(): void }; executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<KernelOutput> | Promise<AsyncIterable<KernelOutput>>; }
interface ReadHandle { size: number; read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>; close(): Promise<void>; }
interface WriteHandle { write(data: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>; close(): Promise<void>; }
export interface ColabFileSystem {
    stat(kernelPath: string): Promise<{ size: number }>;
    readFile(kernelPath: string): Promise<Uint8Array>;
    writeFile(kernelPath: string, content: Uint8Array): Promise<void>;
}
export interface FileTransferArgs { notebookRef: string; hostPath: string; kernelPath: string; overwrite?: boolean; maxBytes?: number; colabFileUri?: string; }
export interface ColabRuntimeCheckArgs { notebookRef: string; colabFileUri?: string; }
export interface KernelFileDeps {
    getKernel(notebookRef: string): Promise<ActiveKernelLike | undefined>;
    openRead(filePath: string): Promise<ReadHandle>;
    openWrite(filePath: string): Promise<WriteHandle>;
    rename(from: string, to: string): Promise<void>;
    link(from: string, to: string): Promise<void>;
    unlink(filePath: string): Promise<void>;
    stat(filePath: string): Promise<{ size: number }>;
    colabFileSystems?(args: FileTransferArgs): ColabFileSystem[];
    /** Local test seam; production discovers roots from registered VS Code resources. */
    getColabFileRoots?(): string[];
    /** Local test seam; not an MCP tool parameter. */
    executionTimeoutMs?: number;
    cleanupTimeoutMs?: number;
    nativeTimeoutMs?: number;
    bindingTimeoutMs?: number;
    kernelWireBudgetBytes?: number;
}
const activeTargets = new Set<string>();
const activeKernels = new WeakSet<ActiveKernelLike>();
const unsettledKernels = new WeakSet<ActiveKernelLike>();
class TransferFailure extends Error {
    constructor(message: string, readonly unsettled = false) { super(message); }
}

const fsDeps: KernelFileDeps = {
    getKernel: async (ref) => {
        const ext = vscode.extensions.getExtension<{ kernels?: { getKernel(uri: vscode.Uri): Thenable<ActiveKernelLike | undefined> } }>('ms-toolsai.jupyter');
        if (!ext) return undefined;
        const api = await ext.activate();
        return api?.kernels ? await api.kernels.getKernel(vscode.Uri.parse(ref)) : undefined;
    },
    openRead: async (filePath) => {
        const handle = await fs.promises.open(filePath, 'r');
        try {
            const info = await handle.stat();
            return { size: info.size, read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position), close: () => handle.close() };
        } catch (error) { await handle.close().catch(() => undefined); throw error; }
    },
    openWrite: async (filePath) => {
        const handle = await fs.promises.open(filePath, 'wx');
        return { write: (data, offset, length) => handle.write(data, offset, length), close: () => handle.close() };
    },
    rename: (from, to) => fs.promises.rename(from, to),
    link: (from, to) => fs.promises.link(from, to),
    unlink: (filePath) => fs.promises.unlink(filePath),
    stat: async (filePath) => fs.promises.stat(filePath),
    colabFileSystems: colabFileSystems,
    getColabFileRoots
};

/** Exposed workspace/document roots are candidates, not proof of kernel identity. */
export function getColabFileRoots(): string[] {
    const uris = [
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
        ...(vscode.workspace.textDocuments ?? []).map((doc) => doc.uri),
        ...(vscode.workspace.notebookDocuments ?? []).map((doc) => doc.uri)
    ];
    return [...new Set(uris.filter((uri) => uri.scheme === 'colab' && uri.authority && !uri.query && !uri.fragment)
        .map((uri) => uri.with({ path: '/', query: '', fragment: '' }).toString()))];
}
function colabFileSystems(args: FileTransferArgs): ColabFileSystem[] {
    const explicit = args.colabFileUri ? vscode.Uri.parse(args.colabFileUri, true) : undefined;
    if (explicit && (explicit.scheme !== 'colab' || !explicit.authority || explicit.query || explicit.fragment || explicit.path !== args.kernelPath)) {
        throw new TransferFailure('colabFileUri must be an exact colab://server/absolute/path URI matching kernelPath, without a query or fragment');
    }
    if (!vscode.extensions.getExtension('google.colab')?.isActive) return [];
    const roots = explicit ? [explicit] : getColabFileRoots().map((root) => vscode.Uri.parse(root));
    return roots.map((root) => ({
        stat: async (p) => vscode.workspace.fs.stat(root.with({ path: p })),
        readFile: async (p) => vscode.workspace.fs.readFile(root.with({ path: p })),
        writeFile: async (p, bytes) => vscode.workspace.fs.writeFile(root.with({ path: p }), bytes)
    }));
}

function nativeCandidates(args: FileTransferArgs, bytes: number, deps: KernelFileDeps): ColabFileSystem[] | undefined {
    if (!args.colabFileUri && bytes <= MAX_KERNEL_TRANSFER_BYTES) return undefined;
    if (bytes > DEFAULT_MAX_BYTES) throw new TransferFailure('Native Colab transfers are limited to 64 MiB because the provider buffers a whole file');
    const candidates = deps.colabFileSystems?.(args) ?? [];
    if (!candidates.length) throw new TransferFailure('The native Colab file service is unavailable. Transfers above 4 MiB require it. Use Colab: Mount Server to Workspace and get_kernel_info to discover its root, or provide colabFileUri from the Colab contents view. No large kernel transfer was attempted');
    if (candidates.length > 1) throw new TransferFailure('Multiple Colab filesystem roots are exposed. Provide colabFileUri to choose one explicitly; no native transfer was attempted');
    return candidates;
}

/** workspace.fs cannot cancel in-flight I/O. Quarantine it until it actually settles. */
async function nativeStep<T>(kernel: ActiveKernelLike, current: () => Promise<void>, work: () => Promise<T>, deps: KernelFileDeps, token?: vscode.CancellationToken, binding = false): Promise<T> {
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    let abortedReason: TransferFailure | undefined;
    const abort = (reason: string) => { abortedReason = new TransferFailure(reason, !binding); rejectAbort(abortedReason); };
    const timeoutMs = binding ? deps.bindingTimeoutMs ?? 15_000 : deps.nativeTimeoutMs ?? NATIVE_TRANSFER_TIMEOUT_MS;
    const timer = setTimeout(() => abort(binding ? 'native filesystem binding timed out; no payload was transferred' : 'native file service timed out; an in-flight request may still finish'), timeoutMs);
    const cancellation = token?.onCancellationRequested(() => abort('cancelled'));
    const status = kernel.onDidChangeStatus?.((value) => { if (value !== 'idle' && value !== 'busy') abort('kernel became unavailable during native file transfer'); });
    let pending: Promise<T> | undefined;
    let settled = false;
    try {
        ensureNotCancelled(token);
        await Promise.race([current(), aborted]);
        ensureNotCancelled(token);
        if (abortedReason) throw abortedReason;
        pending = Promise.resolve().then(() => { if (abortedReason) throw abortedReason; ensureNotCancelled(token); return work(); });
        void pending.then(() => { settled = true; }, () => { settled = true; });
        const result = await Promise.race([pending, aborted]);
        await Promise.race([current(), aborted]);
        ensureNotCancelled(token);
        return result;
    } finally {
        clearTimeout(timer); cancellation?.dispose(); status?.dispose();
        // A pending nonce read is small and read-only, potentially on a stale root.
        // It must not quarantine the selected kernel or block a corrected explicit URI.
        if (!binding && pending && !settled) {
            unsettledKernels.add(kernel);
            void pending.then(() => unsettledKernels.delete(kernel), () => unsettledKernels.delete(kernel));
        }
    }
}

async function bindColab(candidates: ColabFileSystem[], bindingPath: string, nonce: string, kernel: ActiveKernelLike, current: () => Promise<void>, deps: KernelFileDeps, token?: vscode.CancellationToken): Promise<ColabFileSystem> {
    const matches: ColabFileSystem[] = [];
    for (const candidate of candidates) {
        try {
            const matchesNonce = await nativeStep(kernel, current, async () => {
                const info = await candidate.stat(bindingPath);
                if (info.size !== Buffer.byteLength(nonce)) return false;
                return Buffer.from(await candidate.readFile(bindingPath)).equals(Buffer.from(nonce));
            }, deps, token, true);
            if (matchesNonce) matches.push(candidate);
        } catch (error) { if (error instanceof TransferFailure || token?.isCancellationRequested) throw error; }
    }
    if (matches.length !== 1) throw new TransferFailure('Native Colab filesystem did not uniquely match the selected kernel; no file payload was transferred');
    return matches[0];
}

const PURGE_CACHED_TRANSFER_SOURCES = [
    'import linecache as _mcp_lc',
    "for _mcp_cache in (getattr(_mcp_lc, '_ipython_cache', None), _mcp_lc.cache):",
    ' if isinstance(_mcp_cache, dict):',
    `  for _mcp_key in [k for k, v in list(_mcp_cache.items()) if isinstance(v, tuple) and len(v) > 2 and v[2] and str(v[2][0]).startswith(${JSON.stringify(TRANSFER_TAG)})]:`,
    '   _mcp_cache.pop(_mcp_key, None)'
].join('\n');
/** The optional payload is a single base64 literal in the request, never re-encoded with its arguments. */
function transferCode(command: string, args: Record<string, unknown>, nonce: string, payload = ''): string {
    const body = command.split('\n').map((line) => ' ' + line).join('\n');
    const source = [
        `import base64, hashlib, json, os, zlib`,
        `a=json.loads(base64.b64decode(${JSON.stringify(Buffer.from(JSON.stringify(args), 'utf8').toString('base64'))}).decode('utf-8'))`,
        PURGE_CACHED_TRANSFER_SOURCES,
        'try:', body,
        'except Exception as _mcp_error:', " result={'kind':'error','error':type(_mcp_error).__name__}",
        `print(${JSON.stringify(RECEIPT + nonce + ':')}+json.dumps(result,separators=(',',':')))`
    ].join('\n');
    const encoded = Buffer.from(source, 'utf8').toString('base64');
    return `${TRANSFER_TAG}\nexec(compile(__import__('base64').b64decode(${JSON.stringify(encoded)}),'<jupyter-mcp-transfer>','exec'),{'__builtins__':__builtins__,'_mcp_payload':${JSON.stringify(payload)}})`;
}
function chargeWire(kernel: ActiveKernelLike, bytes: number, deps: KernelFileDeps): void {
    const used = kernelWireBytes.get(kernel) ?? 0;
    const budget = deps.kernelWireBudgetBytes ?? KERNEL_WIRE_BUDGET_BYTES;
    if (used + bytes > budget) {
        throw new TransferFailure(`kernel-channel transfer budget for this kernel (${Math.round(budget / 1048576)} MiB) would be exceeded; repeated payload executions can exhaust Colab runtime memory. Use the native Colab file service (Colab explorer upload/download, or Colab: Mount Server to Workspace with colabFileUri), or restart the kernel before transferring more`);
    }
    kernelWireBytes.set(kernel, used + bytes);
}
function packChunk(chunk: Buffer): { payload: string; compressed: boolean } {
    const packed = zlib.deflateSync(chunk, { level: 6 });
    const compressed = chunk.length > 0 && packed.length < chunk.length * COMPRESSION_RATIO;
    return { payload: (compressed ? packed : chunk).toString('base64'), compressed };
}
function outputText(value: unknown): string { if (typeof value === 'string') return value; if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8'); return ''; }
async function receipt(kernel: ActiveKernelLike, code: string, nonce: string, assertCurrent: () => Promise<void>, timeoutMs: number, token?: vscode.CancellationToken, onDispatch?: () => void): Promise<Record<string, unknown>> {
    let combined = '';
    const source = new vscode.CancellationTokenSource();
    let iterator: AsyncIterator<KernelOutput> | undefined;
    let pending: Promise<unknown> | undefined;
    let dispatched = false;
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = (reason: string) => { rejectAbort(new TransferFailure(reason, true)); source.cancel(); };
    const cancellation = token?.onCancellationRequested(() => abort('cancelled'));
    const timer = setTimeout(() => abort('kernel execution timed out'), timeoutMs);
    const status = kernel.onDidChangeStatus?.((value) => { if (value !== 'idle' && value !== 'busy') abort('kernel became unavailable'); });
    if (token?.isCancellationRequested) abort('cancelled');
    let complete = false;
    try {
        await Promise.race([assertCurrent(), aborted]);
        ensureNotCancelled(token);
        ensureNotCancelled(source.token);
        onDispatch?.();
        dispatched = true;
        const execution = Promise.resolve(kernel.executeCode(code, source.token));
        pending = execution;
        const stream = await Promise.race([execution, aborted]);
        iterator = stream[Symbol.asyncIterator]();
        while (true) {
            const output = iterator.next();
            pending = Promise.resolve(output);
            const next = await Promise.race([output, aborted]);
            if (next.done) { complete = true; break; }
            const valueOutput = next.value;
            for (const value of [...(valueOutput.items ?? []).map((item) => item.data), valueOutput.text, valueOutput.value, valueOutput.data]) {
                const text = outputText(value);
                if (combined.length + text.length > MAX_RECEIPT_CHARS) throw new TransferFailure('kernel receipt exceeded output limit', true);
                combined += text;
            }
        }
    } finally {
        clearTimeout(timer);
        cancellation?.dispose();
        status?.dispose();
        if (!complete) {
            source.cancel();
            if (dispatched && pending) {
                unsettledKernels.add(kernel);
                // Observe completion without waiting on an iterator that ignores cancellation.
                const close = async () => {
                    if (!iterator && pending) {
                        const stream = await pending as AsyncIterable<KernelOutput>;
                        iterator = stream[Symbol.asyncIterator]();
                    }
                    if (!iterator?.return) return false;
                    await iterator.return();
                    await pending?.catch(() => undefined);
                    return true;
                };
                void close().then((settled) => { if (settled) unsettledKernels.delete(kernel); }, () => undefined);
            }
        }
        source.dispose();
    }
    const marker = `${RECEIPT}${nonce}:`;
    const matches = combined.split(/\r?\n/).filter((line) => line.startsWith(marker));
    if (matches.length !== 1) throw new Error('invalid receipt');
    let value: unknown;
    try {
        value = JSON.parse(matches[0].slice(marker.length));
    } catch { throw new Error('invalid receipt'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid receipt');
    const record = value as Record<string, unknown>;
    // The kernel reports only the exception class, never its message or file contents.
    if (record.kind === 'error') throw new TransferFailure(`kernel reported ${typeof record.error === 'string' && /^[A-Za-z_][A-Za-z0-9_.]{0,80}$/.test(record.error) ? record.error : 'an exception'}`);
    return record;
}
async function boundedKernel(ref: string, deps: KernelFileDeps, token?: vscode.CancellationToken): Promise<ActiveKernelLike> {
    ensureNotCancelled(token);
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const timer = setTimeout(() => rejectAbort(new TransferFailure('kernel lookup timed out')), deps.executionTimeoutMs ?? TRANSFER_EXECUTION_TIMEOUT_MS);
    const cancellation = token?.onCancellationRequested(() => rejectAbort(new TransferFailure('cancelled')));
    try { ensureNotCancelled(token); return await Promise.race([kernelFor(ref, deps), aborted]); }
    finally { clearTimeout(timer); cancellation?.dispose(); }
}
async function withTransfer<T>(ref: string, deps: KernelFileDeps, work: (kernel: ActiveKernelLike, current: () => Promise<void>) => Promise<T>, token?: vscode.CancellationToken): Promise<T> {
    if (activeTargets.has(ref)) throw new Error('A file transfer is already active for this notebook.');
    activeTargets.add(ref);
    let kernel: ActiveKernelLike | undefined;
    let ownsKernel = false;
    let invalidated = false;
    let status: { dispose(): void } | undefined;
    try {
        kernel = await boundedKernel(ref, deps, token);
        if (activeKernels.has(kernel)) throw new Error('A file transfer is already active for this kernel.');
        if (unsettledKernels.has(kernel)) throw new Error('A prior file transfer execution has not settled in this kernel; transfer was not attempted.');
        activeKernels.add(kernel); ownsKernel = true;
        status = kernel.onDidChangeStatus?.((value) => { if (value !== 'idle' && value !== 'busy') invalidated = true; });
        const original = kernel;
        const current = async () => {
            let active: ActiveKernelLike;
            try { active = await kernelFor(ref, deps); }
            catch { throw new TransferFailure('active kernel is busy or unavailable'); }
            if (invalidated || active !== original) throw new TransferFailure('active kernel changed or became unavailable');
        };
        return await work(original, current);
    } finally {
        status?.dispose();
        if (kernel && ownsKernel) activeKernels.delete(kernel);
        activeTargets.delete(ref);
    }
}
function failureReason(error: unknown): string { return error instanceof TransferFailure ? error.message : 'kernel execution or receipt validation failed'; }
function validate(a: { notebookRef: string; hostPath: string; kernelPath: string; maxBytes: number }): void {
    if (!a.notebookRef || !a.hostPath || !a.kernelPath) throw new Error('notebookRef, hostPath, and kernelPath are required.');
    if (!path.isAbsolute(a.hostPath)) throw new Error('hostPath must be an absolute path on the VS Code extension host.');
    if (!path.posix.isAbsolute(a.kernelPath.replace(/\\/g, '/'))) throw new Error('kernelPath must be an absolute path in the kernel filesystem.');
    if (!Number.isSafeInteger(a.maxBytes) || a.maxBytes <= 0) throw new Error('maxBytes must be a positive safe integer.');
}
async function kernelFor(ref: string, deps: KernelFileDeps): Promise<ActiveKernelLike> {
    const kernel = await deps.getKernel(ref);
    if (!kernel) throw new Error('No active Python kernel is available.');
    if ((kernel.language ?? '').toLowerCase() !== 'python') throw new Error('File transfer requires an active Python kernel.');
    if ((kernel.status ?? '').toLowerCase() !== 'idle') throw new Error('Kernel is busy or unavailable; file transfer was not attempted.');
    if (typeof kernel.executeCode !== 'function') throw new Error('Active kernel lacks the public executeCode API.');
    return kernel;
}
function ensureNotCancelled(token?: vscode.CancellationToken): void { if (token?.isCancellationRequested) throw new Error('cancelled'); }
async function writeAll(output: WriteHandle, chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
        const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.length - offset) throw new Error('short write');
        offset += bytesWritten;
    }
}
function exactNumber(value: unknown, expected?: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (expected !== undefined && value !== expected)) throw new Error('invalid count');
    return value as number;
}

function exactRecord(record: Record<string, unknown>, keys: string[]): void {
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error('invalid diagnostic receipt');
}

function colabCheckTarget(a: ColabRuntimeCheckArgs, deps: KernelFileDeps): { root: string; fileSystem: ColabFileSystem } {
    if (!a.notebookRef) throw new Error('notebookRef is required.');
    let explicit: vscode.Uri | undefined;
    if (a.colabFileUri !== undefined) {
        try { explicit = vscode.Uri.parse(a.colabFileUri, true); }
        catch { throw new Error('colabFileUri must be an exact Colab root URI such as colab://server/.'); }
        if (explicit.scheme !== 'colab' || !explicit.authority || explicit.path !== '/' || explicit.query || explicit.fragment || !a.colabFileUri.startsWith('colab://')) {
            throw new Error('colabFileUri must be an exact Colab root URI such as colab://server/.');
        }
    }
    let roots: string[];
    try { roots = explicit ? [explicit.with({ path: '/', query: '', fragment: '' }).toString()] : [...new Set((deps.getColabFileRoots ?? getColabFileRoots)())]; }
    catch { throw new Error('Colab filesystem roots could not be inspected; no runtime check was executed.'); }
    if (!roots.length) throw new Error('No registered Colab filesystem root is available; mount the active Colab server in VS Code before checking the runtime.');
    if (roots.length > 1) throw new Error('Multiple Colab filesystem roots are available; provide colabFileUri to select one before checking the runtime.');
    const root = roots[0];
    let candidates: ColabFileSystem[];
    try { candidates = deps.colabFileSystems?.({ notebookRef: a.notebookRef, hostPath: '', kernelPath: '/', colabFileUri: root }) ?? []; }
    catch { throw new Error('The selected Colab filesystem provider is unavailable; no runtime check was executed.'); }
    if (candidates.length !== 1) throw new Error(candidates.length ? 'The selected Colab root did not resolve to one filesystem provider; no runtime check was executed.' : 'The active Google Colab filesystem provider is unavailable; activate it and mount the server before checking the runtime.');
    return { root, fileSystem: candidates[0] };
}

function isFileNotFound(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: unknown; name?: unknown };
    return value.code === 'FileNotFound' || value.name === 'EntryNotFound (FileSystemError)';
}

function colabCheckReason(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    const allowed = [
        'cancelled', 'kernel lookup timed out', 'kernel execution timed out', 'kernel became unavailable',
        'active kernel is busy or unavailable', 'active kernel changed or became unavailable',
        'No active Python kernel is available.', 'File transfer requires an active Python kernel.',
        'Kernel is busy or unavailable; file transfer was not attempted.', 'Active kernel lacks the public executeCode API.',
        'A file transfer is already active for this notebook.', 'A file transfer is already active for this kernel.',
        'A prior file transfer execution has not settled in this kernel; transfer was not attempted.',
        'native filesystem binding timed out; no payload was transferred', 'kernel receipt exceeded output limit',
        'kernel became unavailable during native file transfer',
        'invalid receipt', 'invalid diagnostic receipt', 'Colab filesystem nonce did not match the active kernel.',
        'The active kernel is not a Linux Colab runtime.', 'The active kernel does not provide the google.colab module.'
    ];
    if (allowed.includes(message) || /^kernel reported [A-Za-z_][A-Za-z0-9_.]{0,80}$/.test(message)) return message;
    return 'diagnostic execution or validation failed';
}

class ColabCheckFailure extends Error {}

/**
 * Verify the current kernel against an active registered Colab filesystem. This is a
 * point-in-time diagnostic only: it never starts or selects a runtime and is not cached.
 */
export async function checkColabRuntime(a: ColabRuntimeCheckArgs, token?: vscode.CancellationToken, deps: KernelFileDeps = fsDeps): Promise<string> {
    const target = colabCheckTarget(a, deps); // Root/provider validation must precede any kernel execution.
    return withTransfer(a.notebookRef, deps, async (kernel, current) => {
        const nonce = crypto.randomUUID();
        // Use the established Colab Contents path and a non-hidden filename:
        // Jupyter may reject dotfiles even when the kernel can create them.
        const noncePath = `/content/jupyter-mcp-colab-check-${nonce}`;
        let probeAttempted = false;
        let kernelCleanupVerified = false;
        let cleanupVerified = false;
        const clean = async () => {
            const cleaned = await receipt(kernel, transferCode("try:\n with open(a['path'],'rb') as f: owned=f.read(len(a['nonce'])+1)==a['nonce'].encode('ascii')\n if not owned: raise ValueError('nonce ownership changed')\n os.unlink(a['path'])\nexcept FileNotFoundError: pass\nresult={'kind':'colab-clean','absent':not os.path.lexists(a['path'])}", { path: noncePath, nonce }, nonce), nonce, current, deps.cleanupTimeoutMs ?? TRANSFER_CLEANUP_TIMEOUT_MS);
            exactRecord(cleaned, ['kind', 'absent']);
            if (cleaned.kind !== 'colab-clean' || cleaned.absent !== true) throw new Error('cleanup confirmation failed');
            kernelCleanupVerified = true;
            const providerAbsent = await nativeStep(kernel, current, async () => {
                try { await target.fileSystem.stat(noncePath); return false; }
                catch (error) { return isFileNotFound(error); }
            }, deps, undefined, true);
            if (!providerAbsent) throw new Error('cleanup confirmation failed');
            cleanupVerified = true;
        };
        try {
            const probed = await receipt(kernel, transferCode("import importlib.util, os, platform, sys\nf=open(a['path'],'x',encoding='ascii'); f.write(a['nonce']); f.flush(); os.fsync(f.fileno()); f.close()\ntry: has_colab=importlib.util.find_spec('google.colab') is not None\nexcept (ImportError, AttributeError, ValueError): has_colab=False\nresult={'kind':'colab-probe','pid':os.getpid(),'platform':sys.platform,'python':platform.python_version(),'googleColabModule':has_colab}", { path: noncePath, nonce }, nonce), nonce, current, deps.executionTimeoutMs ?? TRANSFER_EXECUTION_TIMEOUT_MS, token, () => { probeAttempted = true; });
            exactRecord(probed, ['kind', 'pid', 'platform', 'python', 'googleColabModule']);
            if (probed.kind !== 'colab-probe' || !Number.isSafeInteger(probed.pid) || (probed.pid as number) <= 0 || typeof probed.python !== 'string' || !/^\d{1,2}\.\d{1,2}\.\d{1,3}$/.test(probed.python)) throw new Error('invalid diagnostic receipt');
            if (probed.platform !== 'linux') throw new Error('The active kernel is not a Linux Colab runtime.');
            if (probed.googleColabModule !== true) throw new Error('The active kernel does not provide the google.colab module.');
            try { await bindColab([target.fileSystem], noncePath, nonce, kernel, current, deps, token); }
            catch (error) {
                if (error instanceof TransferFailure && error.message.includes('did not uniquely match')) throw new Error('Colab filesystem nonce did not match the active kernel.');
                throw error;
            }
            // clean() ends with nativeStep's bounded post-I/O kernel identity check.
            await clean();
            ensureNotCancelled(token);
            return JSON.stringify({
                verified: true, runtime: 'colab', checkedAt: new Date().toISOString(), colabRoot: target.root,
                kernel: { pid: probed.pid, platform: probed.platform, python: probed.python },
                checks: { responsive: true, googleColabModule: true, nativeFilesystemNonce: true, cleanup: true }
            });
        } catch (error) {
            if (probeAttempted && !kernelCleanupVerified && !unsettledKernels.has(kernel) && !(error instanceof TransferFailure && error.unsettled)) {
                try { await clean(); } catch { /* Report uncertainty below; never clean through another kernel. */ }
            }
            if (kernelCleanupVerified && !cleanupVerified) throw new ColabCheckFailure('Colab runtime check failed: the kernel probe was removed, but absence could not be verified through the selected Colab filesystem. Check the current server and colabFileUri before retrying.');
            if (probeAttempted && !cleanupVerified) throw new ColabCheckFailure('Colab runtime check failed and cleanup of its private nonce file could not be verified; reconnect or restart the runtime before retrying.');
            throw new ColabCheckFailure(`Colab runtime check failed: ${colabCheckReason(error)}`);
        }
    }, token).catch((error: unknown) => {
        if (error instanceof ColabCheckFailure) throw error;
        // Lookup/activation errors occur outside the diagnostic callback. Do not
        // expose provider URLs, credentials, or arbitrary exception contents.
        throw new Error(`Colab runtime check failed: ${colabCheckReason(error)}`);
    });
}

export async function uploadFile(a: FileTransferArgs, token?: vscode.CancellationToken, deps: KernelFileDeps = fsDeps): Promise<string> {
    const maxBytes = a.maxBytes ?? DEFAULT_MAX_BYTES;
    validate({ ...a, maxBytes });
    const hostPath = path.resolve(a.hostPath);
    return withTransfer(a.notebookRef, deps, async (kernel, current) => {
        const receive = (code: string, nonce: string, cleanup = false, onDispatch?: () => void) => receipt(kernel, code, nonce, current, cleanup ? deps.cleanupTimeoutMs ?? TRANSFER_CLEANUP_TIMEOUT_MS : deps.executionTimeoutMs ?? TRANSFER_EXECUTION_TIMEOUT_MS, cleanup ? undefined : token, onDispatch);
        ensureNotCancelled(token);
        const input = await deps.openRead(hostPath);
        const nonce = crypto.randomUUID();
        const temporaryPath = `${a.kernelPath}.jupyter-mcp-${nonce}.part`;
        const bindingPath = `/content/jupyter-mcp-bind-${nonce}`;
        let bindingAttempted = false;
        let transport = 'kernel-execute';
        let closed = false;
        let remoteAttempted = false;
        let finalAttempted = false;
        let phase = 'validate source';
        try {
            if (input.size > maxBytes) throw new Error('too large');
            const candidates = nativeCandidates(a, input.size, deps);
            phase = 'initialize remote temporary file';
            const initialized = await receive(transferCode("open(a['tmp'],'xb').close()\nif a.get('binding'):\n f=open(a['binding'],'xb'); f.write(a['nonce'].encode('ascii')); f.close()\nresult={'kind':'init'}", { tmp: temporaryPath, binding: candidates ? bindingPath : undefined, nonce }, nonce), nonce, false, () => { remoteAttempted = true; bindingAttempted = Boolean(candidates); });
            if (initialized.kind !== 'init') throw new Error('invalid init');
            const hash = crypto.createHash('sha256');
            let bytes = 0;
            if (candidates) {
                phase = 'bind native filesystem to selected kernel';
                const native = await bindColab(candidates, bindingPath, nonce, kernel, current, deps, token);
                transport = 'colab-contents';
                const data = Buffer.allocUnsafe(input.size);
                while (bytes < input.size) {
                    ensureNotCancelled(token);
                    const requested = Math.min(TRANSFER_CHUNK_BYTES, input.size - bytes);
                    const { bytesRead } = await input.read(data, bytes, requested, bytes);
                    if (bytesRead !== requested) throw new Error('short read');
                    bytes += bytesRead;
                }
                hash.update(data);
                phase = 'native contents upload';
                await nativeStep(kernel, current, () => native.writeFile(temporaryPath, data), deps, token);
            } else {
                const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES);
                while (bytes < input.size) {
                    phase = 'transfer chunk';
                    ensureNotCancelled(token);
                    const requested = Math.min(buffer.length, input.size - bytes);
                    const { bytesRead } = await input.read(buffer, 0, requested, bytes);
                    if (bytesRead !== requested) throw new Error('short read');
                    const chunk = buffer.subarray(0, bytesRead);
                    const packed = packChunk(chunk);
                    const code = transferCode("p=base64.b64decode(_mcp_payload)\nd=zlib.decompress(p) if a['z'] else p\nf=open(a['tmp'],'r+b')\nf.seek(0,2)\nif f.tell()!=a['offset']: f.close(); raise RuntimeError('offset')\nn=f.write(d); f.flush(); os.fsync(f.fileno()); f.close()\nif n!=len(d): raise RuntimeError('write')\nresult={'kind':'chunk','offset':a['offset'],'bytes':n}", { tmp: temporaryPath, offset: bytes, z: packed.compressed }, nonce, packed.payload);
                    chargeWire(kernel, Buffer.byteLength(code), deps);
                    const appended = await receive(code, nonce);
                    if (appended.kind !== 'chunk' || exactNumber(appended.offset, bytes) !== bytes) throw new Error('invalid chunk');
                    exactNumber(appended.bytes, bytesRead);
                    hash.update(chunk);
                    bytes += bytesRead;
                }
            }
            await input.close(); closed = true; ensureNotCancelled(token);
            const digest = hash.digest('hex');
            phase = 'verify and promote destination';
            const completed = await receive(transferCode("h=hashlib.sha256()\nf=open(a['tmp'],'rb')\nwhile True:\n d=f.read(262144)\n if not d: break\n h.update(d)\nf.close()\nsize=os.path.getsize(a['tmp'])\nif size!=a['bytes'] or h.hexdigest()!=a['sha256']: raise RuntimeError('verification')\nif a.get('binding'): os.unlink(a['binding'])\nif a['overwrite']: os.replace(a['tmp'],a['dest'])\nelse: os.link(a['tmp'],a['dest']); os.unlink(a['tmp'])\nresult={'kind':'done','bytes':size,'sha256':h.hexdigest()}", { tmp: temporaryPath, dest: a.kernelPath, overwrite: a.overwrite === true, bytes, sha256: digest, binding: bindingAttempted ? bindingPath : undefined }, nonce), nonce, false, () => { finalAttempted = true; });
            if (completed.kind !== 'done') throw new Error('invalid final');
            exactNumber(completed.bytes, bytes);
            if (completed.sha256 !== digest) throw new Error('invalid hash');
            return JSON.stringify({ operation: 'upload_file', transport, bytes, sha256: digest, hostPath, kernelPath: a.kernelPath, verified: true });
        } catch (error) {
            if (!closed) await input.close().catch(() => undefined);
            if (remoteAttempted && !unsettledKernels.has(kernel) && !(error instanceof TransferFailure && error.unsettled)) try { await receive(transferCode("for p in a['paths']:\n try: os.unlink(p)\n except FileNotFoundError: pass\nresult={'kind':'clean'}", { tmp: temporaryPath, paths: [temporaryPath, ...(bindingAttempted ? [bindingPath] : [])] }, nonce), nonce, true); } catch { /* Only this operation's random temporary paths, on the original kernel. */ }
            if (finalAttempted) throw new Error(`Upload outcome is uncertain because kernel confirmation was not received (phase: ${phase}; ${failureReason(error)}).`);
            throw new Error(token?.isCancellationRequested ? `File upload cancelled before destination commit (phase: ${phase}).` : `File upload failed before destination commit (phase: ${phase}; ${failureReason(error)}).`);
        }
    }, token);
}

export async function downloadFile(a: FileTransferArgs, token?: vscode.CancellationToken, deps: KernelFileDeps = fsDeps): Promise<string> {
    const maxBytes = a.maxBytes ?? DEFAULT_MAX_BYTES;
    validate({ ...a, maxBytes });
    return withTransfer(a.notebookRef, deps, async (kernel, current) => {
        const receive = (code: string, nonce: string) => receipt(kernel, code, nonce, current, deps.executionTimeoutMs ?? TRANSFER_EXECUTION_TIMEOUT_MS, token);
        ensureNotCancelled(token);
        const hostPath = path.resolve(a.hostPath);
        const nonce = crypto.randomUUID();
        const temporaryPath = `${hostPath}.jupyter-mcp-${nonce}.part`;
        const bindingPath = `/content/jupyter-mcp-bind-${nonce}`;
        let bindingAttempted = false;
        let transport = 'kernel-execute';
        const output = await deps.openWrite(temporaryPath);
        let closed = false;
        let committed = false;
        let phase = 'inspect remote source';
        try {
            const metadata = await receive(transferCode("s=os.stat(a['path'])\nif not os.path.isfile(a['path']): raise RuntimeError('not-file')\nresult={'kind':'meta','bytes':s.st_size}", { path: a.kernelPath }, nonce), nonce);
            if (metadata.kind !== 'meta') throw new Error('invalid metadata');
            const remoteSize = exactNumber(metadata.bytes);
            if (remoteSize > maxBytes) throw new Error('too large');
            const candidates = nativeCandidates(a, remoteSize, deps);
            const hash = crypto.createHash('sha256');
            let bytes = 0;
            if (candidates) {
                phase = 'bind native filesystem to selected kernel';
                bindingAttempted = true;
                const bound = await receive(transferCode("f=open(a['binding'],'xb'); f.write(a['nonce'].encode('ascii')); f.close()\nresult={'kind':'bind'}", { binding: bindingPath, nonce }, nonce), nonce);
                if (bound.kind !== 'bind') throw new Error('invalid binding');
                const native = await bindColab(candidates, bindingPath, nonce, kernel, current, deps, token);
                transport = 'colab-contents';
                phase = 'native contents download';
                const data = await nativeStep(kernel, current, async () => {
                    const info = await native.stat(a.kernelPath);
                    if (info.size !== remoteSize) throw new TransferFailure('Native source size changed before download');
                    return native.readFile(a.kernelPath);
                }, deps, token);
                if (data.byteLength !== remoteSize) throw new Error('invalid native file size');
                const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
                await writeAll(output, buffer); hash.update(buffer); bytes = buffer.byteLength;
            } else {
                while (bytes < remoteSize) {
                    phase = 'transfer chunk';
                    ensureNotCancelled(token);
                    const requested = Math.min(TRANSFER_CHUNK_BYTES, remoteSize - bytes);
                    // Reserve the uncompressed worst case before dispatch, then charge what arrived.
                    const reserve = Math.ceil(requested / 3) * 4 + 512;
                    chargeWire(kernel, reserve, deps);
                    const part = await receive(transferCode(`f=open(a['path'],'rb'); f.seek(a['offset']); d=f.read(a['length']); f.close()\nc=zlib.compress(d,6)\nz=len(d)>0 and len(c)<len(d)*${COMPRESSION_RATIO}\nresult={'kind':'chunk','offset':a['offset'],'bytes':len(d),'z':z,'chunk':base64.b64encode(c if z else d).decode('ascii')}`, { path: a.kernelPath, offset: bytes, length: requested }, nonce), nonce);
                    kernelWireBytes.set(kernel, Math.max(0, (kernelWireBytes.get(kernel) ?? 0) - reserve + (typeof part.chunk === 'string' ? part.chunk.length : 0)));
                    if (part.kind !== 'chunk' || exactNumber(part.offset, bytes) !== bytes) throw new Error('invalid chunk');
                    const raw = Buffer.from(typeof part.chunk === 'string' ? part.chunk : '', 'base64');
                    if (part.z !== true && part.z !== false && part.z !== undefined) throw new Error('invalid chunk');
                    const chunk = part.z === true ? zlib.inflateSync(raw, { maxOutputLength: requested }) : raw;
                    exactNumber(part.bytes, requested);
                    if (chunk.length !== requested) throw new Error('invalid chunk');
                    await writeAll(output, chunk); hash.update(chunk); bytes += chunk.length;
                }
            }
            const digest = hash.digest('hex');
            phase = 'verify remote source';
            const completed = await receive(transferCode("h=hashlib.sha256()\nf=open(a['path'],'rb')\nwhile True:\n d=f.read(262144)\n if not d: break\n h.update(d)\nf.close()\nif a.get('binding'): os.unlink(a['binding'])\nresult={'kind':'done','bytes':os.path.getsize(a['path']),'sha256':h.hexdigest()}", { path: a.kernelPath, binding: bindingAttempted ? bindingPath : undefined }, nonce), nonce);
            if (completed.kind !== 'done') throw new Error('invalid final');
            exactNumber(completed.bytes, bytes);
            if (completed.sha256 !== digest) throw new Error('invalid hash');
            await output.close(); closed = true; ensureNotCancelled(token);
            phase = 'promote destination';
            if (a.overwrite) await deps.rename(temporaryPath, hostPath);
            else { await deps.link(temporaryPath, hostPath); committed = true; await deps.unlink(temporaryPath); }
            committed = true;
            return JSON.stringify({ operation: 'download_file', transport, bytes, sha256: digest, hostPath, kernelPath: a.kernelPath, verified: true });
        } catch (error) {
            if (bindingAttempted && !unsettledKernels.has(kernel) && !(error instanceof TransferFailure && error.unsettled)) try {
                await receipt(kernel, transferCode("try: os.unlink(a['binding'])\nexcept FileNotFoundError: pass\nresult={'kind':'clean'}", { binding: bindingPath }, nonce), nonce, current, deps.cleanupTimeoutMs ?? TRANSFER_CLEANUP_TIMEOUT_MS);
            } catch { /* No cleanup against a replacement or unsettled runtime. */ }
            if (!closed) await output.close().catch(() => undefined);
            if (!committed) await deps.unlink(temporaryPath).catch(() => undefined);
            if (committed) throw new Error('Download committed, but temporary-file cleanup could not be confirmed.');
            throw new Error(token?.isCancellationRequested ? `File download cancelled before destination commit (phase: ${phase}).` : `File download failed before destination commit (phase: ${phase}; ${failureReason(error)}; destination promotion may also fail).`);
        }
    }, token);
}
