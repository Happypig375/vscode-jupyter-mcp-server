import * as assert from 'assert';
import * as crypto from 'crypto';
import * as path from 'path';
import { CancellationTokenSource } from './vscodeStub';
import { ActiveKernelLike, ColabFileSystem, downloadFile, KernelFileDeps, MAX_KERNEL_TRANSFER_BYTES, TRANSFER_CHUNK_BYTES, uploadFile } from '../kernelFiles';

function decode(code: string) {
    const outer = code.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)!;
    const source = Buffer.from(outer[1], 'base64').toString();
    const encodedArgs = source.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)!;
    const marker = source.match(/print\("([^\"]+:)"\+json/)!;
    return { source, args: JSON.parse(Buffer.from(encodedArgs[1], 'base64').toString()), marker: marker[1] };
}
class Kernel implements ActiveKernelLike {
    language = 'python'; status = 'idle'; files = new Map<string, Buffer>(); missing = false; badHash = false; sources: string[] = [];
    afterExecution?: (source: string) => void;
    hang?: (source: string) => boolean;
    flooded = false;
    returned = 0;
    cancelledExecutions = 0;
    private listeners = new Set<(status: string) => void>();
    onDidChangeStatus = (listener: (status: string) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    setStatus(status: string) { this.status = status; for (const listener of this.listeners) listener(status); }
    executeCode(code: string, token: any): AsyncIterable<any> {
        assert.strictEqual(typeof token?.isCancellationRequested, 'boolean');
        assert.strictEqual(typeof token?.onCancellationRequested, 'function');
        token.onCancellationRequested(() => { this.cancelledExecutions++; });
        const { source, args: a, marker } = decode(code); this.sources.push(source); let r: any;
        if (this.hang?.(source)) {
            const self = this;
            return { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<any>>(() => undefined), return: () => { self.returned++; return new Promise<IteratorResult<any>>(() => undefined); } }; } };
        }
        if (this.flooded) return (async function* () { yield { text: 'x'.repeat(3 * TRANSFER_CHUNK_BYTES) }; })();
        if (source.includes("kind':'init")) { this.files.set(a.tmp, Buffer.alloc(0)); if (a.binding) this.files.set(a.binding, Buffer.from(a.nonce)); r = { kind: 'init' }; }
        else if (source.includes("kind':'bind")) { this.files.set(a.binding, Buffer.from(a.nonce)); r = { kind: 'bind' }; }
        else if (source.includes("bytes':n")) { const c = Buffer.from(a.chunk, 'base64'); this.files.set(a.tmp, Buffer.concat([this.files.get(a.tmp)!, c])); r = { kind: 'chunk', offset: a.offset, bytes: c.length }; }
        else if (source.includes("chunk':base64")) { const c = this.files.get(a.path)!.subarray(a.offset, a.offset + a.length); r = { kind: 'chunk', offset: a.offset, bytes: c.length, chunk: c.toString('base64') }; }
        else if (source.includes("kind':'meta")) r = { kind: 'meta', bytes: this.files.get(a.path)!.length };
        else if (source.includes("kind':'done")) { const v = this.files.get(a.tmp ?? a.path)!; const sha256 = crypto.createHash('sha256').update(v).digest('hex'); if (a.tmp) { if (sha256 !== a.sha256) throw new Error('verification'); if (!a.overwrite && this.files.has(a.dest)) throw new Error('EEXIST'); this.files.set(a.dest, v); this.files.delete(a.tmp); } if (a.binding) this.files.delete(a.binding); r = { kind: 'done', bytes: v.length, sha256: this.badHash ? 'bad' : sha256 }; }
        else { for (const p of a.paths ?? [a.tmp, a.binding]) this.files.delete(p); r = { kind: 'clean' }; }
        const line = marker + JSON.stringify(r) + '\n', cut = Math.floor(line.length / 2), missing = this.missing;
        const afterExecution = this.afterExecution;
        return (async function* () { if (missing) { yield { items: [{ data: Buffer.from('error output') }] }; return; } yield { items: [{ data: Buffer.from(line.slice(0, cut)) }] }; yield { items: [{ data: Buffer.from(line.slice(cut)) }] }; afterExecution?.(source); })();
    }
}
function deps(kernel: Kernel, host = new Map<string, Buffer>(), partial = false): KernelFileDeps & { temps: Set<string> } {
    const temps = new Set<string>();
    return { temps, getKernel: async () => kernel,
        openRead: async (p) => { const v = host.get(p)!; return { size: v.length, read: async (b, o, l, pos) => { v.copy(b, o, pos, pos + l); return { bytesRead: l }; }, close: async () => undefined }; },
        openWrite: async (p) => { temps.add(p); host.set(p, Buffer.alloc(0)); return { write: async (b, o, l) => { const n = partial ? Math.max(1, Math.floor(l / 2)) : l; host.set(p, Buffer.concat([host.get(p)!, b.subarray(o, o + n)])); return { bytesWritten: n }; }, close: async () => undefined }; },
        rename: async (a, b) => { host.set(b, host.get(a)!); host.delete(a); temps.delete(a); },
        link: async (a, b) => { if (host.has(b)) throw new Error('EEXIST'); host.set(b, host.get(a)!); },
        unlink: async (p) => { host.delete(p); temps.delete(p); }, stat: async (p) => ({ size: host.get(p)!.length }) };
}
async function main() {
    const host = new Map<string, Buffer>(), kernel = new Kernel(), d = deps(kernel, host, true);
    const src = path.resolve('quoted α.bin'), dest = path.resolve('download α.bin');
    const payload = crypto.randomBytes(TRANSFER_CHUNK_BYTES + 17); host.set(src, payload);
    const up = JSON.parse(await uploadFile({ notebookRef: 'file:///n', hostPath: src, kernelPath: "/tmp/quoted-'α" }, undefined, d));
    assert.deepStrictEqual(kernel.files.get("/tmp/quoted-'α"), payload); assert.strictEqual(up.verified, true);
    const down = JSON.parse(await downloadFile({ notebookRef: 'file:///n', hostPath: dest, kernelPath: "/tmp/quoted-'α" }, undefined, d));
    assert.deepStrictEqual(host.get(dest), payload); assert.strictEqual(down.sha256, up.sha256); assert.strictEqual(d.temps.size, 0);
    assert.ok(kernel.sources.every((s) => !s.includes('def __jupyter_mcp_transfer')));
    const empty = path.resolve('empty'); host.set(empty, Buffer.alloc(0)); await uploadFile({ notebookRef: 'n', hostPath: empty, kernelPath: '/tmp/empty' }, undefined, d);
    kernel.missing = true; await assert.rejects(downloadFile({ notebookRef: 'n', hostPath: path.resolve('missing'), kernelPath: '/tmp/empty' }, undefined, d), /failed before destination commit/); kernel.missing = false;
    kernel.badHash = true; await assert.rejects(downloadFile({ notebookRef: 'n', hostPath: path.resolve('hash'), kernelPath: '/tmp/empty' }, undefined, d), /failed before destination commit/); kernel.badHash = false;
    const race = path.resolve('race'); host.set(race, Buffer.from('winner')); await assert.rejects(downloadFile({ notebookRef: 'n', hostPath: race, kernelPath: '/tmp/empty' }, undefined, d), /failed before destination commit/); assert.strictEqual(host.get(race)!.toString(), 'winner');
    await assert.rejects(uploadFile({ notebookRef: 'n', hostPath: src, kernelPath: '/tmp/cancel' }, { isCancellationRequested: true } as any, d), /cancelled/);
    const short = { ...d, openRead: async () => ({ size: 1, read: async () => ({ bytesRead: 0 }), close: async () => undefined }) };
    await assert.rejects(uploadFile({ notebookRef: 'n', hostPath: src, kernelPath: '/tmp/short' }, undefined, short), /failed before destination commit/);
    await lifecycleTests();
    await nativeTransferTests();
    console.log('kernelFiles tests passed');
}
async function lifecycleTests() {
    const src = path.resolve('lifecycle-input'), dest = path.resolve('lifecycle-output');
    const args = { notebookRef: 'lifecycle', hostPath: src, kernelPath: '/tmp/input', overwrite: true };
    const make = () => {
        const kernel = new Kernel(), host = new Map([[src, Buffer.from('payload')]]);
        kernel.files.set('/tmp/input', Buffer.from('payload'));
        return { kernel, host, d: { ...deps(kernel, host), executionTimeoutMs: 20, cleanupTimeoutMs: 10 } };
    };
    for (const upload of [true, false]) {
        const { kernel, host, d } = make(); kernel.hang = () => true;
        await assert.rejects(upload ? uploadFile(args, undefined, d) : downloadFile({ ...args, hostPath: dest }, undefined, d), /timed out/);
        assert.strictEqual(kernel.sources.length, 1, 'no queued cleanup after unsettled execution');
        assert.strictEqual(kernel.returned, 1, 'stalled iterator.return must not block caller');
        assert.strictEqual(kernel.cancelledExecutions, 1, 'deadline requests public execution cancellation');
        assert.strictEqual(d.temps.size, 0); assert.strictEqual(host.has(dest), false);
    }
    for (const upload of [true, false]) {
        const { kernel, d } = make(); kernel.hang = () => true;
        const source = new CancellationTokenSource();
        const operation = upload ? uploadFile(args, source.token as any, d) : downloadFile({ ...args, hostPath: dest }, source.token as any, d);
        await new Promise((resolve) => setImmediate(resolve)); source.cancel();
        await assert.rejects(operation, /cancelled/); source.dispose();
        assert.strictEqual(kernel.sources.length, 1);
        assert.strictEqual(kernel.cancelledExecutions, 1);
    }
    {
        const { kernel, d } = make(); kernel.hang = () => true;
        const original = kernel.executeCode.bind(kernel);
        kernel.executeCode = (code, token) => { const stream = original(code, token); setImmediate(() => kernel.setStatus('dead')); return stream; };
        await assert.rejects(downloadFile({ ...args, hostPath: dest }, undefined, d), /became unavailable/);
    }
    for (const upload of [true, false]) {
        const { kernel, d } = make(), replacement = new Kernel();
        let active: Kernel = kernel;
        kernel.afterExecution = () => { active = replacement; };
        d.getKernel = async () => active;
        await assert.rejects(upload ? uploadFile(args, undefined, d) : downloadFile({ ...args, hostPath: dest }, undefined, d), /changed or became unavailable/);
        assert.strictEqual(kernel.sources.length, 1); assert.strictEqual(replacement.sources.length, 0, 'no chunk or cleanup in replacement runtime');
    }
    {
        const { kernel, d } = make();
        kernel.afterExecution = () => { kernel.setStatus('restarting'); kernel.setStatus('idle'); };
        await assert.rejects(uploadFile(args, undefined, d), /changed or became unavailable/);
        assert.strictEqual(kernel.sources.length, 1, 'restart on same API object must invalidate transfer');
    }
    {
        const { kernel, d } = make(); kernel.missing = true; kernel.hang = (source) => source.includes("kind':'clean");
        await assert.rejects(uploadFile(args, undefined, d), /failed before destination commit/);
        assert.strictEqual(kernel.sources.length, 2, 'failed settled receipt permits one bounded cleanup');
    }
    {
        const { kernel, d } = make(); kernel.flooded = true;
        await assert.rejects(downloadFile({ ...args, hostPath: dest }, undefined, d), /output limit/);
        assert.strictEqual(d.temps.size, 0);
    }
    {
        const { kernel, d } = make(); kernel.hang = () => true;
        const first = uploadFile(args, undefined, d);
        await new Promise((resolve) => setImmediate(resolve));
        await assert.rejects(downloadFile({ ...args, hostPath: dest }, undefined, d), /already active for this notebook/);
        await assert.rejects(downloadFile({ ...args, notebookRef: 'alias', hostPath: dest }, undefined, d), /already active for this kernel/);
        await assert.rejects(first, /timed out/);
        await assert.rejects(downloadFile({ ...args, hostPath: dest }, undefined, d), /prior file transfer execution has not settled/);
        const replacement = new Kernel(); replacement.files.set('/tmp/input', Buffer.from('replacement')); d.getKernel = async () => replacement;
        await downloadFile({ ...args, hostPath: dest }, undefined, d);
    }
    {
        const { kernel, d } = make();
        const up = JSON.parse(await uploadFile(args, undefined, d));
        assert.strictEqual(up.bytes, 7); assert.strictEqual(kernel.sources.length, 3, 'init, one chunk, final');
        kernel.sources.length = 0;
        await downloadFile({ ...args, hostPath: dest }, undefined, d);
        assert.strictEqual(kernel.sources.length, 3, 'metadata, one chunk, final');
        kernel.sources.length = 0;
        await assert.rejects(uploadFile({ ...args, maxBytes: 1 }, undefined, d), /failed before destination commit/);
        assert.strictEqual(kernel.sources.length, 0, 'oversize upload cannot initialize or transfer');
        kernel.sources.length = 0;
        await assert.rejects(downloadFile({ ...args, hostPath: path.resolve('oversize'), maxBytes: 1 }, undefined, d), /failed before destination commit/);
        assert.strictEqual(kernel.sources.length, 1, 'oversize download stops after metadata');
    }
    {
        const { kernel, d } = make();
        d.getKernel = () => new Promise(() => undefined);
        await assert.rejects(uploadFile(args, undefined, d), /kernel lookup timed out/);
        assert.strictEqual(kernel.sources.length, 0);
    }
    {
        const { kernel, d } = make();
        kernel.hang = (source) => source.includes("kind':'done");
        await assert.rejects(uploadFile(args, undefined, d), /outcome is uncertain.*timed out/);
        assert.strictEqual(kernel.sources.length, 3, 'no cleanup after uncertain promotion');
    }
    {
        const { kernel, d } = make();
        const original = kernel.executeCode.bind(kernel);
        let settleRead!: (value: IteratorResult<any>) => void, settleClose!: (value: IteratorResult<any>) => void;
        const read = new Promise<IteratorResult<any>>((resolve) => { settleRead = resolve; });
        const close = new Promise<IteratorResult<any>>((resolve) => { settleClose = resolve; });
        kernel.executeCode = () => ({ [Symbol.asyncIterator]() { return { next: () => read, return: () => close }; } });
        await assert.rejects(uploadFile(args, undefined, d), /timed out/);
        await assert.rejects(uploadFile(args, undefined, d), /prior file transfer execution has not settled/);
        kernel.executeCode = original;
        settleClose({ done: true, value: undefined });
        await new Promise((resolve) => setImmediate(resolve));
        await assert.rejects(uploadFile(args, undefined, d), /prior file transfer execution has not settled/, 'closure alone does not settle pending read');
        settleRead({ done: true, value: undefined });
        await new Promise((resolve) => setImmediate(resolve));
        await uploadFile(args, undefined, d);
    }
    {
        const { kernel, d } = make();
        const promised: ActiveKernelLike = { language: 'python', status: 'idle', executeCode: () => new Promise(() => undefined) };
        d.getKernel = async () => promised;
        await assert.rejects(uploadFile(args, undefined, d), /timed out/);
        await assert.rejects(uploadFile(args, undefined, d), /prior file transfer execution has not settled/);
        assert.strictEqual(kernel.sources.length, 0);
    }
}
function nativeFs(kernel: Kernel): ColabFileSystem & { payloadReads: number; payloadWrites: number } {
    return {
        payloadReads: 0, payloadWrites: 0,
        stat: async (p) => { const v = kernel.files.get(p); if (!v) throw new Error('FileNotFound'); return { size: v.length }; },
        async readFile(p) { if (!p.includes('jupyter-mcp-bind-')) this.payloadReads++; const v = kernel.files.get(p); if (!v) throw new Error('FileNotFound'); return v; },
        async writeFile(p, bytes) { this.payloadWrites++; kernel.files.set(p, Buffer.from(bytes)); }
    };
}
async function nativeTransferTests() {
    const src = path.resolve('native-source'), dest = path.resolve('native-destination');
    const args = { notebookRef: 'native', hostPath: src, kernelPath: '/content/native.bin', colabFileUri: 'colab://selected/content/native.bin' };
    const make = (bytes = Buffer.from('native payload')) => {
        const kernel = new Kernel(), host = new Map([[src, bytes]]), native = nativeFs(kernel);
        kernel.files.set(args.kernelPath, bytes);
        const d: KernelFileDeps = { ...deps(kernel, host), colabFileSystems: () => [native], nativeTimeoutMs: 30 };
        return { kernel, host, native, d };
    };
    {
        const size = 65_568_700, bytes = Buffer.alloc(size, 90);
        bytes.write('native-contents-large-regression');
        const { kernel, host, native, d } = make(bytes);
        kernel.files.delete(args.kernelPath);
        const up = JSON.parse(await uploadFile({ ...args, colabFileUri: undefined }, undefined, d));
        assert.strictEqual(up.transport, 'colab-contents'); assert.strictEqual(up.bytes, size);
        assert.strictEqual(kernel.sources.length, 2); assert.strictEqual(native.payloadWrites, 1);
        assert.ok(Math.max(...kernel.sources.map((s) => Buffer.byteLength(s))) < 4096, 'No file bytes in kernel code');
        const down = JSON.parse(await downloadFile({ ...args, hostPath: dest, colabFileUri: undefined }, undefined, d));
        assert.strictEqual(down.transport, 'colab-contents'); assert.strictEqual(down.sha256, up.sha256);
        assert.strictEqual(kernel.sources.length, 5); assert.strictEqual(native.payloadReads, 1);
        assert.deepStrictEqual(host.get(dest), bytes);
        assert.ok([...kernel.files.keys()].every((p) => !p.includes('jupyter-mcp-')));
        console.log(`native synthetic round trip: ${size} bytes, 2 upload / 3 download kernel calls, zero payload bytes in code`);
    }
    for (const upload of [true, false]) {
        const { kernel, host, d } = make(Buffer.alloc(MAX_KERNEL_TRANSFER_BYTES + 1));
        d.colabFileSystems = undefined;
        const a = { ...args, colabFileUri: undefined };
        await assert.rejects(upload ? uploadFile(a, undefined, d) : downloadFile({ ...a, hostPath: dest }, undefined, d), /native Colab file service/);
        assert.strictEqual(kernel.sources.length, upload ? 0 : 1, 'No chunked fallback');
        assert.strictEqual(host.has(dest), false);
    }
    for (const upload of [true, false]) {
        const { kernel, native, d } = make(); const wrong = nativeFs(new Kernel());
        d.colabFileSystems = () => [wrong];
        await assert.rejects(upload ? uploadFile(args, undefined, d) : downloadFile({ ...args, hostPath: dest }, undefined, d), /did not uniquely match/);
        assert.strictEqual(wrong.payloadWrites + wrong.payloadReads + native.payloadWrites + native.payloadReads, 0);
        assert.ok([...kernel.files.keys()].every((p) => !p.includes('jupyter-mcp-')));
    }
    {
        const { native, d } = make(); d.colabFileSystems = () => [native, native];
        await assert.rejects(uploadFile(args, undefined, d), /Multiple Colab filesystem roots/);
        assert.strictEqual(native.payloadWrites, 0);
    }
    {
        const { kernel, native, d } = make();
        d.bindingTimeoutMs = 15;
        d.colabFileSystems = () => [{ ...native, stat: () => new Promise(() => undefined) }];
        await assert.rejects(uploadFile(args, undefined, d), /binding timed out/);
        assert.strictEqual(native.payloadWrites, 0);
        assert.ok([...kernel.files.keys()].every((p) => !p.includes('jupyter-mcp-')));
        d.colabFileSystems = () => [native];
        await downloadFile({ ...args, hostPath: dest }, undefined, d);
        assert.strictEqual(native.payloadReads, 1, 'A stale read-only root must not quarantine the actual kernel');
    }
    {
        const { kernel, native, d } = make();
        const stat = native.stat.bind(native);
        native.stat = async (p) => { const info = await stat(p); kernel.status = 'busy'; return info; };
        await assert.rejects(uploadFile(args, undefined, d), /active kernel is busy or unavailable/);
        assert.strictEqual(native.payloadWrites, 0, 'Busy kernel is not a filesystem mismatch and cannot receive payloads');
        assert.strictEqual([...kernel.files.keys()].filter((p) => p.includes('jupyter-mcp-')).length, 2, 'Busy kernels retain the nonce and temporary file; cleanup must not queue execution');
    }
    {
        const { kernel, native, d } = make(); kernel.files.delete(args.kernelPath);
        const write = native.writeFile.bind(native);
        native.writeFile = async (p, bytes) => { const corrupt = Buffer.from(bytes); corrupt[0] ^= 1; await write(p, corrupt); };
        await assert.rejects(uploadFile(args, undefined, d), /outcome is uncertain/);
        assert.strictEqual(kernel.files.has(args.kernelPath), false, 'Corruption cannot promote');
    }
    {
        const { host, native, d } = make();
        const read = native.readFile.bind(native);
        native.readFile = async (p) => { const data = Buffer.from(await read(p)); if (!p.includes('jupyter-mcp-bind-')) data[0] ^= 1; return data; };
        await assert.rejects(downloadFile({ ...args, hostPath: dest }, undefined, d), /failed before destination commit/);
        assert.strictEqual(host.has(dest), false);
    }
    for (const upload of [true, false]) {
        const { kernel, native, d } = make(); let resolve!: (value: any) => void;
        const hanging = new Promise<any>((r) => { resolve = r; });
        if (upload) native.writeFile = async () => hanging;
        else { const read = native.readFile.bind(native); native.readFile = async (p) => p.includes('jupyter-mcp-bind-') ? read(p) : hanging; }
        const a = upload ? args : { ...args, hostPath: dest };
        await assert.rejects(upload ? uploadFile(a, undefined, d) : downloadFile(a, undefined, d), /native file service timed out/);
        const calls = kernel.sources.length;
        await assert.rejects(uploadFile(args, undefined, d), /prior file transfer execution has not settled/);
        assert.strictEqual(kernel.sources.length, calls, 'No cleanup or next transfer behind pending native I/O');
        resolve(upload ? undefined : Buffer.from('native payload'));
        await new Promise((r) => setImmediate(r));
        d.colabFileSystems = () => [nativeFs(kernel)];
        const down = JSON.parse(await downloadFile({ ...args, hostPath: dest }, undefined, d));
        assert.strictEqual(down.transport, 'colab-contents', 'Settled I/O releases quarantine');
    }
    for (const stop of ['cancel', 'dead'] as const) {
        const { kernel, native, d } = make();
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => { finish = resolve; });
        const cancellation = new CancellationTokenSource();
        native.writeFile = async () => {
            queueMicrotask(() => stop === 'cancel' ? cancellation.cancel() : kernel.setStatus('dead'));
            return pending;
        };
        await assert.rejects(uploadFile(args, cancellation.token as any, d), stop === 'cancel' ? /cancelled/ : /kernel became unavailable during native/);
        const calls = kernel.sources.length;
        kernel.setStatus('idle');
        await assert.rejects(downloadFile({ ...args, hostPath: dest }, undefined, d), /prior file transfer execution has not settled/);
        assert.strictEqual(kernel.sources.length, calls, 'No kernel cleanup behind in-flight native writes');
        finish(); await new Promise((resolve) => setImmediate(resolve)); cancellation.dispose();
    }
    {
        const { kernel, native, d } = make(); const replacement = new Kernel();
        const write = native.writeFile.bind(native);
        native.writeFile = async (p, bytes) => { await write(p, bytes); d.getKernel = async () => replacement; };
        const before = kernel.files.get(args.kernelPath);
        await assert.rejects(uploadFile(args, undefined, d), /active kernel changed/);
        assert.strictEqual(kernel.files.get(args.kernelPath), before);
        assert.strictEqual(replacement.sources.length, 0);
    }
    {
        const { kernel, host, d } = make(); const existing = kernel.files.get(args.kernelPath);
        await assert.rejects(uploadFile(args, undefined, d), /outcome is uncertain/);
        assert.strictEqual(kernel.files.get(args.kernelPath), existing);
        host.set(dest, Buffer.from('keep local'));
        await assert.rejects(downloadFile({ ...args, hostPath: dest }, undefined, d), /failed before destination commit/);
        assert.strictEqual(host.get(dest)!.toString(), 'keep local');
        await uploadFile({ ...args, overwrite: true }, undefined, d);
        await downloadFile({ ...args, hostPath: dest, overwrite: true }, undefined, d);
        assert.strictEqual(host.get(dest)!.toString(), 'native payload');
    }
}
if (require.main === module) void main().catch((e) => { console.error(e); process.exit(1); });
export { main };
