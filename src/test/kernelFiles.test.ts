import * as assert from 'assert';
import * as crypto from 'crypto';
import * as path from 'path';
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
    executeCode(code: string, token: any): AsyncIterable<any> {
        assert.strictEqual(typeof token?.isCancellationRequested, 'boolean');
        assert.strictEqual(typeof token?.onCancellationRequested, 'function');
        const { source, args: a, marker } = decode(code); this.sources.push(source); let r: any;
        if (source.includes("kind':'init")) { this.files.set(a.tmp, Buffer.alloc(0)); r = { kind: 'init' }; }
        else if (source.includes("bytes':n")) { const c = Buffer.from(a.chunk, 'base64'); this.files.set(a.tmp, Buffer.concat([this.files.get(a.tmp)!, c])); r = { kind: 'chunk', offset: a.offset, bytes: c.length }; }
        else if (source.includes("chunk':base64")) { const c = this.files.get(a.path)!.subarray(a.offset, a.offset + a.length); r = { kind: 'chunk', offset: a.offset, bytes: c.length, chunk: c.toString('base64') }; }
        else if (source.includes("kind':'meta")) r = { kind: 'meta', bytes: this.files.get(a.path)!.length };
        else if (source.includes("kind':'done")) { const v = this.files.get(a.tmp ?? a.path)!; const sha256 = crypto.createHash('sha256').update(v).digest('hex'); if (a.tmp) { this.files.set(a.dest, v); this.files.delete(a.tmp); } r = { kind: 'done', bytes: v.length, sha256: this.badHash ? 'bad' : sha256 }; }
        else { this.files.delete(a.tmp); r = { kind: 'clean' }; }
        const line = marker + JSON.stringify(r) + '\n', cut = Math.floor(line.length / 2), missing = this.missing;
        return (async function* () { if (missing) { yield { items: [{ data: Buffer.from('error output') }] }; return; } yield { items: [{ data: Buffer.from(line.slice(0, cut)) }] }; yield { items: [{ data: Buffer.from(line.slice(cut)) }] }; })();
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
    const up = JSON.parse(await uploadFile({ notebookRef: 'file:///n', localPath: src, kernelPath: "/tmp/quoted-'α" }, undefined, d));
    assert.deepStrictEqual(kernel.files.get("/tmp/quoted-'α"), payload); assert.strictEqual(up.verified, true);
    const down = JSON.parse(await downloadFile({ notebookRef: 'file:///n', localPath: dest, kernelPath: "/tmp/quoted-'α" }, undefined, d));
    assert.deepStrictEqual(host.get(dest), payload); assert.strictEqual(down.sha256, up.sha256); assert.strictEqual(d.temps.size, 0);
    assert.ok(kernel.sources.every((s) => !s.includes('def __jupyter_mcp_transfer')));
    const empty = path.resolve('empty'); host.set(empty, Buffer.alloc(0)); await uploadFile({ notebookRef: 'n', localPath: empty, kernelPath: '/tmp/empty' }, undefined, d);
    kernel.missing = true; await assert.rejects(downloadFile({ notebookRef: 'n', localPath: path.resolve('missing'), kernelPath: '/tmp/empty' }, undefined, d), /failed before destination commit/); kernel.missing = false;
    kernel.badHash = true; await assert.rejects(downloadFile({ notebookRef: 'n', localPath: path.resolve('hash'), kernelPath: '/tmp/empty' }, undefined, d), /failed before destination commit/); kernel.badHash = false;
    const race = path.resolve('race'); host.set(race, Buffer.from('winner')); await assert.rejects(downloadFile({ notebookRef: 'n', localPath: race, kernelPath: '/tmp/empty' }, undefined, d), /failed before destination commit/); assert.strictEqual(host.get(race)!.toString(), 'winner');
    await assert.rejects(uploadFile({ notebookRef: 'n', localPath: src, kernelPath: '/tmp/cancel' }, { isCancellationRequested: true } as any, d), /cancelled/);
    const short = { ...d, openRead: async () => ({ size: 1, read: async () => ({ bytesRead: 0 }), close: async () => undefined }) };
    await assert.rejects(uploadFile({ notebookRef: 'n', localPath: src, kernelPath: '/tmp/short' }, undefined, short), /failed before destination commit/);
    console.log('kernelFiles tests passed');
}
if (require.main === module) void main().catch((e) => { console.error(e); process.exit(1); });
export { main };
