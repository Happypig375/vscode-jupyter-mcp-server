import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const TRANSFER_CHUNK_BYTES = 256 * 1024;
const RECEIPT = '__JUPYTER_MCP_FILE_RECEIPT__';

export interface KernelOutputItem { mime?: string; data?: unknown; }
export interface KernelOutput { items?: KernelOutputItem[]; text?: unknown; value?: unknown; data?: unknown; }
export interface ActiveKernelLike { language?: string; status?: string; executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<KernelOutput> | Promise<AsyncIterable<KernelOutput>>; }
interface ReadHandle { size: number; read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>; close(): Promise<void>; }
interface WriteHandle { write(data: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>; close(): Promise<void>; }
export interface KernelFileDeps {
    getKernel(notebookRef: string): Promise<ActiveKernelLike | undefined>;
    openRead(filePath: string): Promise<ReadHandle>;
    openWrite(filePath: string): Promise<WriteHandle>;
    rename(from: string, to: string): Promise<void>;
    link(from: string, to: string): Promise<void>;
    unlink(filePath: string): Promise<void>;
    stat(filePath: string): Promise<{ size: number }>;
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
    stat: async (filePath) => fs.promises.stat(filePath)
};

function transferCode(command: string, args: Record<string, unknown>, nonce: string): string {
    const source = [`import base64, hashlib, json, os`, `a=json.loads(base64.b64decode(${JSON.stringify(Buffer.from(JSON.stringify(args), 'utf8').toString('base64'))}).decode('utf-8'))`, command, `print(${JSON.stringify(RECEIPT + nonce + ':')}+json.dumps(result,separators=(',',':')))`].join('\n');
    const encoded = Buffer.from(source, 'utf8').toString('base64');
    return `exec(compile(__import__('base64').b64decode(${JSON.stringify(encoded)}),'<jupyter-mcp-transfer>','exec'),{'__builtins__':__builtins__})`;
}
function outputText(value: unknown): string { if (typeof value === 'string') return value; if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8'); return ''; }
async function receipt(kernel: ActiveKernelLike, code: string, nonce: string, token?: vscode.CancellationToken): Promise<Record<string, unknown>> {
    let combined = '';
    const source = new vscode.CancellationTokenSource();
    const cancellation = token?.onCancellationRequested(() => source.cancel());
    if (token?.isCancellationRequested) source.cancel();
    try {
        const stream = await kernel.executeCode(code, source.token);
        for await (const output of stream) for (const value of [...(output.items ?? []).map((item) => item.data), output.text, output.value, output.data]) combined += outputText(value);
    } finally {
        cancellation?.dispose();
        source.dispose();
    }
    const marker = `${RECEIPT}${nonce}:`;
    const matches = combined.split(/\r?\n/).filter((line) => line.startsWith(marker));
    if (matches.length !== 1) throw new Error('invalid receipt');
    try {
        const value = JSON.parse(matches[0].slice(marker.length));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid receipt');
        return value as Record<string, unknown>;
    } catch { throw new Error('invalid receipt'); }
}
function validate(a: { notebookRef: string; localPath: string; kernelPath: string; maxBytes: number }): void {
    if (!a.notebookRef || !a.localPath || !a.kernelPath) throw new Error('notebookRef, localPath, and kernelPath are required.');
    if (!path.isAbsolute(a.localPath)) throw new Error('localPath must be an absolute path on the VS Code host.');
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

export async function uploadFile(a: { notebookRef: string; localPath: string; kernelPath: string; overwrite?: boolean; maxBytes?: number }, token?: vscode.CancellationToken, deps: KernelFileDeps = fsDeps): Promise<string> {
    const maxBytes = a.maxBytes ?? DEFAULT_MAX_BYTES;
    validate({ ...a, maxBytes });
    const localPath = path.resolve(a.localPath);
    const kernel = await kernelFor(a.notebookRef, deps);
    ensureNotCancelled(token);
    const input = await deps.openRead(localPath);
    const nonce = crypto.randomUUID();
    const temporaryPath = `${a.kernelPath}.jupyter-mcp-${nonce}.part`;
    let closed = false;
    let finalAttempted = false;
    let phase = 'validate source';
    try {
        if (input.size > maxBytes) throw new Error('too large');
        phase = 'initialize remote temporary file';
        const initialized = await receipt(kernel, transferCode("open(a['tmp'],'xb').close()\nresult={'kind':'init'}", { tmp: temporaryPath }, nonce), nonce, token);
        if (initialized.kind !== 'init') throw new Error('invalid init');
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES);
        let bytes = 0;
        while (bytes < input.size) {
            phase = 'transfer chunk';
            ensureNotCancelled(token);
            const requested = Math.min(buffer.length, input.size - bytes);
            const { bytesRead } = await input.read(buffer, 0, requested, bytes);
            if (bytesRead !== requested) throw new Error('short read');
            const chunk = buffer.subarray(0, bytesRead);
            const appended = await receipt(kernel, transferCode("d=base64.b64decode(a['chunk'])\nf=open(a['tmp'],'r+b')\nf.seek(0,2)\nif f.tell()!=a['offset']: f.close(); raise RuntimeError('offset')\nn=f.write(d); f.flush(); os.fsync(f.fileno()); f.close()\nif n!=len(d): raise RuntimeError('write')\nresult={'kind':'chunk','offset':a['offset'],'bytes':n}", { tmp: temporaryPath, chunk: chunk.toString('base64'), offset: bytes }, nonce), nonce, token);
            if (appended.kind !== 'chunk' || exactNumber(appended.offset, bytes) !== bytes) throw new Error('invalid chunk');
            exactNumber(appended.bytes, bytesRead);
            hash.update(chunk);
            bytes += bytesRead;
        }
        await input.close(); closed = true; ensureNotCancelled(token);
        const digest = hash.digest('hex');
        finalAttempted = true;
        phase = 'verify and promote destination';
        const completed = await receipt(kernel, transferCode("h=hashlib.sha256()\nf=open(a['tmp'],'rb')\nwhile True:\n d=f.read(262144)\n if not d: break\n h.update(d)\nf.close()\nsize=os.path.getsize(a['tmp'])\nif size!=a['bytes'] or h.hexdigest()!=a['sha256']: raise RuntimeError('verification')\nif a['overwrite']: os.replace(a['tmp'],a['dest'])\nelse: os.link(a['tmp'],a['dest']); os.unlink(a['tmp'])\nresult={'kind':'done','bytes':size,'sha256':h.hexdigest()}", { tmp: temporaryPath, dest: a.kernelPath, overwrite: a.overwrite === true, bytes, sha256: digest }, nonce), nonce, token);
        if (completed.kind !== 'done') throw new Error('invalid final');
        exactNumber(completed.bytes, bytes);
        if (completed.sha256 !== digest) throw new Error('invalid hash');
        return JSON.stringify({ operation: 'upload_file', bytes, sha256: digest, localPath, kernelPath: a.kernelPath, verified: true });
    } catch {
        if (!closed) await input.close().catch(() => undefined);
        try { await receipt(kernel, transferCode("try:\n os.unlink(a['tmp'])\nexcept FileNotFoundError:\n pass\nresult={'kind':'clean'}", { tmp: temporaryPath }, nonce), nonce, undefined); } catch { /* Cleanup is limited to this operation's random temporary path. */ }
        if (finalAttempted) throw new Error(`Upload outcome is uncertain because kernel confirmation was not received (phase: ${phase}).`);
        throw new Error(token?.isCancellationRequested ? `File upload cancelled before destination commit (phase: ${phase}).` : `File upload failed before destination commit (phase: ${phase}; kernel execution or receipt validation failed).`);
    }
}

export async function downloadFile(a: { notebookRef: string; localPath: string; kernelPath: string; overwrite?: boolean; maxBytes?: number }, token?: vscode.CancellationToken, deps: KernelFileDeps = fsDeps): Promise<string> {
    const maxBytes = a.maxBytes ?? DEFAULT_MAX_BYTES;
    validate({ ...a, maxBytes });
    const kernel = await kernelFor(a.notebookRef, deps);
    ensureNotCancelled(token);
    const localPath = path.resolve(a.localPath);
    const nonce = crypto.randomUUID();
    const temporaryPath = `${localPath}.jupyter-mcp-${nonce}.part`;
    const output = await deps.openWrite(temporaryPath);
    let closed = false;
    let committed = false;
    let phase = 'inspect remote source';
    try {
        const metadata = await receipt(kernel, transferCode("s=os.stat(a['path'])\nif not os.path.isfile(a['path']): raise RuntimeError('not-file')\nresult={'kind':'meta','bytes':s.st_size}", { path: a.kernelPath }, nonce), nonce, token);
        if (metadata.kind !== 'meta') throw new Error('invalid metadata');
        const remoteSize = exactNumber(metadata.bytes);
        if (remoteSize > maxBytes) throw new Error('too large');
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        while (bytes < remoteSize) {
            phase = 'transfer chunk';
            ensureNotCancelled(token);
            const requested = Math.min(TRANSFER_CHUNK_BYTES, remoteSize - bytes);
            const part = await receipt(kernel, transferCode("f=open(a['path'],'rb'); f.seek(a['offset']); d=f.read(a['length']); f.close()\nresult={'kind':'chunk','offset':a['offset'],'bytes':len(d),'chunk':base64.b64encode(d).decode('ascii')}", { path: a.kernelPath, offset: bytes, length: requested }, nonce), nonce, token);
            if (part.kind !== 'chunk' || exactNumber(part.offset, bytes) !== bytes) throw new Error('invalid chunk');
            const chunk = Buffer.from(typeof part.chunk === 'string' ? part.chunk : '', 'base64');
            exactNumber(part.bytes, requested);
            if (chunk.length !== requested) throw new Error('invalid chunk');
            await writeAll(output, chunk); hash.update(chunk); bytes += chunk.length;
        }
        const digest = hash.digest('hex');
        phase = 'verify remote source';
        const completed = await receipt(kernel, transferCode("h=hashlib.sha256()\nf=open(a['path'],'rb')\nwhile True:\n d=f.read(262144)\n if not d: break\n h.update(d)\nf.close()\nresult={'kind':'done','bytes':os.path.getsize(a['path']),'sha256':h.hexdigest()}", { path: a.kernelPath }, nonce), nonce, token);
        if (completed.kind !== 'done') throw new Error('invalid final');
        exactNumber(completed.bytes, bytes);
        if (completed.sha256 !== digest) throw new Error('invalid hash');
        await output.close(); closed = true; ensureNotCancelled(token);
        phase = 'promote destination';
        if (a.overwrite) await deps.rename(temporaryPath, localPath);
        else { await deps.link(temporaryPath, localPath); committed = true; await deps.unlink(temporaryPath); }
        committed = true;
        return JSON.stringify({ operation: 'download_file', bytes, sha256: digest, localPath, kernelPath: a.kernelPath, verified: true });
    } catch {
        if (!closed) await output.close().catch(() => undefined);
        if (!committed) await deps.unlink(temporaryPath).catch(() => undefined);
        if (committed) throw new Error('Download committed, but temporary-file cleanup could not be confirmed.');
        throw new Error(token?.isCancellationRequested ? `File download cancelled before destination commit (phase: ${phase}).` : `File download failed before destination commit (phase: ${phase}; kernel execution, receipt validation, or destination promotion failed).`);
    }
}
