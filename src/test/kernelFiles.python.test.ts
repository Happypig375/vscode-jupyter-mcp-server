/** Actual Python receipts and real host files; the Colab filesystem is a local adapter.
 * This exercises production routing/verification, not Colab network reliability. */
import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ActiveKernelLike, downloadFile, getColabFileRoots, uploadFile } from '../kernelFiles';
import { extensionRegistry, Uri, workspace } from './vscodeStub';

async function main() {
    const parent = path.resolve('.vscode-test');
    await fs.promises.mkdir(parent, { recursive: true });
    const root = await fs.promises.mkdtemp(path.join(parent, 'native-python-'));
    const content = path.join(root, 'content');
    await fs.promises.mkdir(content);
    let calls = 0, largestCode = 0, payloadReads = 0, payloadWrites = 0, corruptWrite = false, corruptRead = false;
    const remotePath = (p: string): string => {
        assert.ok(p.startsWith('/content/'), 'Fixture only exposes its /content directory');
        assert.ok(!path.posix.basename(p).startsWith('.'), 'Match default Jupyter hidden-file rejection');
        const resolved = path.resolve(content, p.slice('/content/'.length));
        assert.strictEqual(path.dirname(resolved), content, 'Fixture paths stay inside the isolated directory');
        return resolved;
    };
    const mapArgs = (value: any): any => {
        if (typeof value === 'string' && value.startsWith('/content/')) return remotePath(value);
        if (Array.isArray(value)) return value.map(mapArgs);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapArgs(v)]));
        return value;
    };
    const kernel: ActiveKernelLike = {
        language: 'python', status: 'idle',
        async *executeCode(code) {
            calls++; largestCode = Math.max(largestCode, Buffer.byteLength(code));
            assert.ok(Buffer.byteLength(code) < 12_000, 'File payload must never be encoded into a native kernel request');
            const outer = code.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)!;
            let source = Buffer.from(outer[1], 'base64').toString();
            const encodedArgs = source.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)!;
            const args = mapArgs(JSON.parse(Buffer.from(encodedArgs[1], 'base64').toString()));
            // Translate only argument paths into the Windows/Linux fixture directory;
            // execute the generated Python command and its receipt logic unchanged.
            source = source.replace(encodedArgs[1], Buffer.from(JSON.stringify(args)).toString('base64'));
            const run = spawnSync(process.env.MCP_TEST_PYTHON ?? 'python', ['-c', source], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
            if (run.error) throw run.error;
            if (run.status !== 0) { yield { text: 'Python execution failed' }; return; }
            yield { text: run.stdout };
        }
    };
    extensionRegistry.set('ms-toolsai.jupyter', { activate: async () => ({ kernels: { getKernel: async () => kernel } }) });
    extensionRegistry.set('google.colab', { isActive: true });
    workspace.workspaceFolders = [{ uri: Uri.parse('colab://fixture/content') }];
    workspace.fs = {
        stat: async (uri: any) => { assert.strictEqual(uri.authority, 'fixture'); return fs.promises.stat(remotePath(uri.path)); },
        readFile: async (uri: any) => {
            assert.strictEqual(uri.authority, 'fixture');
            const bytes = await fs.promises.readFile(remotePath(uri.path));
            if (!uri.path.includes('jupyter-mcp-bind-')) { payloadReads++; if (corruptRead && bytes.length) bytes[0] ^= 1; }
            return bytes;
        },
        writeFile: async (uri: any, bytes: Uint8Array) => {
            assert.strictEqual(uri.authority, 'fixture'); payloadWrites++;
            const data = Buffer.from(bytes); if (corruptWrite && data.length) data[0] ^= 1;
            await fs.promises.writeFile(remotePath(uri.path), data);
        }
    };
    try {
        assert.deepStrictEqual(getColabFileRoots(), ['colab://fixture/']);
        const size = 65_568_700, data = Buffer.alloc(size, 0x5a);
        crypto.randomFillSync(data, 0, 1024);
        const source = path.join(root, 'source.bin'), destination = path.join(root, 'download.bin');
        await fs.promises.writeFile(source, data);
        const args = { notebookRef: 'file:///fixture.ipynb', hostPath: source, kernelPath: '/content/roundtrip.bin' };
        const up = JSON.parse(await uploadFile(args));
        assert.strictEqual(up.transport, 'colab-contents'); assert.strictEqual(up.bytes, size);
        assert.strictEqual(calls, 2); assert.strictEqual(payloadWrites, 1);
        const down = JSON.parse(await downloadFile({ ...args, hostPath: destination }));
        assert.strictEqual(calls, 5); assert.strictEqual(payloadReads, 1);
        assert.strictEqual(down.sha256, up.sha256);
        assert.strictEqual(crypto.createHash('sha256').update(await fs.promises.readFile(destination)).digest('hex'), up.sha256);
        assert.deepStrictEqual(await fs.promises.readdir(content), ['roundtrip.bin']);

        const small = path.join(root, 'small.bin'); await fs.promises.writeFile(small, 'replacement');
        const explicit = { ...args, hostPath: small, colabFileUri: 'colab://fixture/content/roundtrip.bin' };
        await assert.rejects(uploadFile(explicit), /outcome is uncertain/);
        assert.strictEqual((await fs.promises.stat(remotePath(args.kernelPath))).size, size, 'Existing destination preserved');
        await uploadFile({ ...explicit, overwrite: true });
        assert.strictEqual(await fs.promises.readFile(remotePath(args.kernelPath), 'utf8'), 'replacement');
        corruptWrite = true;
        await assert.rejects(uploadFile({ ...explicit, overwrite: true }), /outcome is uncertain/);
        assert.strictEqual(await fs.promises.readFile(remotePath(args.kernelPath), 'utf8'), 'replacement', 'Bad checksum cannot overwrite');
        corruptWrite = false; corruptRead = true;
        await assert.rejects(downloadFile({ ...explicit, hostPath: destination, overwrite: true }), /failed before destination commit/);
        assert.strictEqual((await fs.promises.stat(destination)).size, size, 'Failed download preserves local destination');
        corruptRead = false;
        await downloadFile({ ...explicit, hostPath: destination, overwrite: true });
        assert.strictEqual(await fs.promises.readFile(destination, 'utf8'), 'replacement');
        for (const uri of ['file:///content/roundtrip.bin', 'colab://fixture/content/wrong.bin', 'colab://fixture/content/roundtrip.bin?token=unwanted', 'colab://fixture/content/roundtrip.bin#fragment']) {
            const before: number = payloadWrites;
            await assert.rejects(uploadFile({ ...explicit, colabFileUri: uri }), /colabFileUri must be an exact/);
            assert.strictEqual(payloadWrites, before);
        }
        const before = payloadWrites;
        await assert.rejects(uploadFile({ ...explicit, colabFileUri: 'colab://wrong/content/roundtrip.bin' }), /did not uniquely match/);
        assert.strictEqual(payloadWrites, before);
        await fs.promises.writeFile(small, '');
        await uploadFile({ ...explicit, overwrite: true });
        await downloadFile({ ...explicit, hostPath: destination, overwrite: true });
        assert.strictEqual((await fs.promises.stat(destination)).size, 0);
        assert.deepStrictEqual(await fs.promises.readdir(content), ['roundtrip.bin']);
        console.log(`Real Python native round trip: ${size} bytes; actual hashes, atomic no-overwrite, overwrite, corruption, URI mismatch and empty-file checks passed; largest kernel request ${largestCode} bytes.`);
    } finally {
        extensionRegistry.clear(); workspace.workspaceFolders = []; workspace.fs = {};
        assert.strictEqual(path.dirname(root), parent);
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
