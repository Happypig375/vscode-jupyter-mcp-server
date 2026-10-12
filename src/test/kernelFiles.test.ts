import * as assert from 'assert';
import * as crypto from 'crypto';
import * as path from 'path';
import { CancellationTokenSource } from './vscodeStub';
import { ActiveKernelLike, downloadFile, KernelFileDeps, TRANSFER_CHUNK_BYTES, uploadFile } from '../kernelFiles';

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
        if (source.includes("kind':'init")) { this.files.set(a.tmp, Buffer.alloc(0)); r = { kind: 'init' }; }
        else if (source.includes("bytes':n")) { const c = Buffer.from(a.chunk, 'base64'); this.files.set(a.tmp, Buffer.concat([this.files.get(a.tmp)!, c])); r = { kind: 'chunk', offset: a.offset, bytes: c.length }; }
        else if (source.includes("chunk':base64")) { const c = this.files.get(a.path)!.subarray(a.offset, a.offset + a.length); r = { kind: 'chunk', offset: a.offset, bytes: c.length, chunk: c.toString('base64') }; }
        else if (source.includes("kind':'meta")) r = { kind: 'meta', bytes: this.files.get(a.path)!.length };
        else if (source.includes("kind':'done")) { const v = this.files.get(a.tmp ?? a.path)!; const sha256 = crypto.createHash('sha256').update(v).digest('hex'); if (a.tmp) { this.files.set(a.dest, v); this.files.delete(a.tmp); } r = { kind: 'done', bytes: v.length, sha256: this.badHash ? 'bad' : sha256 }; }
        else { this.files.delete(a.tmp); r = { kind: 'clean' }; }
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
    await largeSyntheticTransfer();
    console.log('kernelFiles tests passed');
}
async function lifecycleTests() {
    const src = path.resolve('lifecycle-input'), dest = path.resolve('lifecycle-output');
    const args = { notebookRef: 'lifecycle', hostPath: src, kernelPath: '/tmp/input' };
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
async function largeSyntheticTransfer() {
    const size = 62_572_000, hostPath = path.resolve('synthetic-large-file');
    let calls = 0, remoteBytes = 0, digest = '', maximumCodeBytes = 0;
    const remoteHash = crypto.createHash('sha256');
    const kernel: ActiveKernelLike = { language: 'python', status: 'idle', executeCode(code) {
        calls++; maximumCodeBytes = Math.max(maximumCodeBytes, Buffer.byteLength(code));
        const { source, args: a, marker } = decode(code); let result: Record<string, unknown>;
        if (source.includes("kind':'init")) result = { kind: 'init' };
        else if (a.chunk) {
            assert.strictEqual(a.offset, remoteBytes);
            const chunk = Buffer.from(a.chunk, 'base64'); remoteHash.update(chunk); remoteBytes += chunk.length;
            result = { kind: 'chunk', offset: a.offset, bytes: chunk.length };
        } else if (source.includes("kind':'meta")) result = { kind: 'meta', bytes: size };
        else if (source.includes("chunk':base64")) {
            const chunk = Buffer.alloc(a.length, 90); result = { kind: 'chunk', offset: a.offset, bytes: chunk.length, chunk: chunk.toString('base64') };
        } else {
            if (a.tmp) digest = remoteHash.digest('hex');
            result = { kind: 'done', bytes: size, sha256: digest };
        }
        return (async function* () { yield { text: marker + JSON.stringify(result) + '\n' }; })();
    } };
    let written = 0, committed = false;
    const hostHash = crypto.createHash('sha256');
    const d: KernelFileDeps = {
        getKernel: async () => kernel,
        openRead: async () => ({ size, read: async (buffer, offset, length) => { buffer.fill(90, offset, offset + length); return { bytesRead: length }; }, close: async () => undefined }),
        openWrite: async () => ({ write: async (buffer, offset, length) => { hostHash.update(buffer.subarray(offset, offset + length)); written += length; return { bytesWritten: length }; }, close: async () => undefined }),
        link: async () => { committed = true; }, rename: async () => { committed = true; }, unlink: async () => undefined, stat: async () => ({ size })
    };
    const args = { notebookRef: 'synthetic-large', hostPath, kernelPath: '/tmp/synthetic-large' };
    const up = JSON.parse(await uploadFile(args, undefined, d));
    assert.strictEqual(calls, 241); assert.strictEqual(remoteBytes, size); assert.strictEqual(up.sha256, digest);
    assert.ok(maximumCodeBytes > 460_000 && maximumCodeBytes < 640_000, `nested base64 upload code measured at ${maximumCodeBytes} bytes`);
    calls = 0;
    await downloadFile(args, undefined, d);
    assert.strictEqual(calls, 241); assert.strictEqual(written, size); assert.strictEqual(hostHash.digest('hex'), digest); assert.strictEqual(committed, true);
    console.log(`large synthetic transfer: ${size} bytes, 241 calls each direction, maximum upload code ${maximumCodeBytes} bytes`);
}
if (require.main === module) void main().catch((e) => { console.error(e); process.exit(1); });
export { main };
