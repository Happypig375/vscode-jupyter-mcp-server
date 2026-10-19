/** Actual Python receipts and real host files; the Colab filesystem is a local adapter.
 * This exercises production routing/verification, not Colab network reliability. */
import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ActiveKernelLike, checkColabRuntime, downloadFile, getColabFileRoots, uploadFile } from '../kernelFiles';
import { extensionRegistry, Uri, workspace } from './vscodeStub';

const python = process.env.MCP_TEST_PYTHON ?? 'python';
/** Replays real transfer requests through IPython (when installed) and returns the source it still caches. */
function ipythonRetainedBytes(codes: string[], directory: string): number | undefined {
    if (spawnSync(python, ['-c', 'import IPython'], { windowsHide: true }).status !== 0) return undefined;
    const codesFile = path.join(directory, 'requests.json');
    fs.writeFileSync(codesFile, JSON.stringify(codes));
    const script = [
        'import json, linecache, sys',
        'from IPython.core.interactiveshell import InteractiveShell',
        'shell = InteractiveShell.instance()',
        'for code in json.load(open(sys.argv[1], encoding="utf-8")):',
        '    shell.run_cell(code, store_history=False)',
        'total = 0',
        'for cache in (linecache.cache, getattr(linecache, "_ipython_cache", {})):',
        '    for v in cache.values():',
        '        if isinstance(v, tuple) and len(v) > 2 and v[2] and str(v[2][0]).startswith("# jupyter-mcp-transfer"):',
        '            total += sum(len(line) for line in v[2])',
        'print("RETAINED", total)'
    ].join('\n');
    const run = spawnSync(python, ['-', codesFile], { input: script, encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(run.status, 0, run.stderr);
    return Number(run.stdout.match(/RETAINED (\d+)/)![1]);
}

async function main() {
    const parent = path.resolve('.vscode-test');
    await fs.promises.mkdir(parent, { recursive: true });
    const root = await fs.promises.mkdtemp(path.join(parent, 'native-python-'));
    const content = path.join(root, 'content');
    await fs.promises.mkdir(content);
    let calls = 0, largestCode = 0, payloadReads = 0, payloadWrites = 0, corruptWrite = false, corruptRead = false;
    let pythonCwd: string | undefined, forceLinux = false, auditNamespace = false;
    let replaceNonceOnStat: Buffer | undefined;
    const namespaceAudits: string[] = [];
    const checkPaths = new Set<string>();
    const remotePath = (p: string): string => {
        assert.ok(p.startsWith('/content/'), 'Fixture only exposes its /content directory');
        assert.ok(!path.posix.basename(p).startsWith('.'), 'Match default Jupyter hidden-file rejection');
        if (p.includes('jupyter-mcp-colab-check-')) { assert.match(p, /^\/content\/jupyter-mcp-colab-check-[0-9a-f-]{36}$/); checkPaths.add(p); }
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
    let nativePhase = true;
    const mappedCodes: string[] = [];
    const kernel: ActiveKernelLike = {
        language: 'python', status: 'idle',
        async *executeCode(code) {
            calls++; largestCode = Math.max(largestCode, Buffer.byteLength(code));
            if (nativePhase) assert.ok(Buffer.byteLength(code) < 12_000, 'File payload must never be encoded into a native kernel request');
            const outer = code.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)!;
            let source = Buffer.from(outer[1], 'base64').toString();
            const encodedArgs = source.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)!;
            const args = mapArgs(JSON.parse(Buffer.from(encodedArgs[1], 'base64').toString()));
            // Translate only argument paths into the Windows/Linux fixture directory, then run the
            // complete generated request (wrapper, payload literal, command and receipt) unchanged.
            source = source.replace(encodedArgs[1], Buffer.from(JSON.stringify(args)).toString('base64'));
            const mapped = code.replace(outer[1], Buffer.from(source).toString('base64'));
            if (!nativePhase) mappedCodes.push(mapped);
            const namespacePrelude = auditNamespace ? "a='user-a'\nhas_colab='user-module'\nf='user-file'\nresult='user-result'\n_mcp_test_before=set(globals())\n" : '';
            const platformPrelude = forceLinux ? "import sys as _mcp_test_sys\n_mcp_test_sys.platform='linux'\n" : '';
            const namespacePostlude = auditNamespace ? "\n_mcp_test_after=set(globals())\nprint('__MCP_NAMESPACE__'+('unchanged' if (a,has_colab,f,result)==('user-a','user-module','user-file','user-result') else 'changed')+':'+','.join(sorted((_mcp_test_after-_mcp_test_before)-{'_mcp_test_before','_mcp_test_after'})))\n" : '';
            const input = platformPrelude + namespacePrelude + mapped + namespacePostlude;
            const run = spawnSync(python, ['-'], { input, cwd: pythonCwd, encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
            if (run.error) throw run.error;
            if (run.status !== 0) { yield { text: 'Python execution failed' }; return; }
            if (auditNamespace) {
                const audit = run.stdout.match(/^__MCP_NAMESPACE__(.*)$/m);
                assert.ok(audit, 'Python namespace audit marker missing'); namespaceAudits.push(audit![1]);
            }
            yield { text: run.stdout };
        }
    };
    extensionRegistry.set('ms-toolsai.jupyter', { activate: async () => ({ kernels: { getKernel: async () => kernel } }) });
    extensionRegistry.set('google.colab', { isActive: true });
    workspace.workspaceFolders = [{ uri: Uri.parse('colab://fixture/content') }];
    workspace.fs = {
        stat: async (uri: any) => {
            assert.strictEqual(uri.authority, 'fixture');
            if (replaceNonceOnStat && /^\/content\/jupyter-mcp-colab-check-[0-9a-f-]{36}$/.test(uri.path)) {
                await fs.promises.writeFile(remotePath(uri.path), replaceNonceOnStat); replaceNonceOnStat = undefined;
            }
            try { return await fs.promises.stat(remotePath(uri.path)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(new Error('FileNotFound'), { code: 'FileNotFound' }); throw error; }
        },
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
        const missingModuleCwd = path.join(root, 'missing-module'), syntheticModuleCwd = path.join(root, 'synthetic-module');
        await fs.promises.mkdir(missingModuleCwd); await fs.promises.writeFile(path.join(missingModuleCwd, 'google.py'), '# Deliberately not a package.\n');
        await fs.promises.mkdir(path.join(syntheticModuleCwd, 'google'), { recursive: true });
        await fs.promises.writeFile(path.join(syntheticModuleCwd, 'google', '__init__.py'), '');
        await fs.promises.writeFile(path.join(syntheticModuleCwd, 'google', 'colab.py'), '# Synthetic import target for algorithm validation only.\n');

        // Run the production-generated probe and cleanup in real Python. The Linux override is a
        // subprocess-only seam because this regression also runs on Windows; it is not live-Colab proof.
        forceLinux = true; auditNamespace = true; pythonCwd = missingModuleCwd;
        await assert.rejects(checkColabRuntime({ notebookRef: 'file:///fixture.ipynb' }), /does not provide the google.colab module/);
        assert.deepStrictEqual(await fs.promises.readdir(content), [], 'missing-module failure removes its private nonce');
        assert.deepStrictEqual(namespaceAudits.splice(0), ['unchanged:', 'unchanged:'], 'probe and cleanup leave seeded user names unchanged');

        pythonCwd = syntheticModuleCwd;
        const syntheticCheck = JSON.parse(await checkColabRuntime({ notebookRef: 'file:///fixture.ipynb' }));
        assert.strictEqual(syntheticCheck.verified, true); assert.strictEqual(syntheticCheck.runtime, 'colab');
        assert.strictEqual(syntheticCheck.kernel.platform, 'linux'); assert.strictEqual(syntheticCheck.checks.cleanup, true);
        assert.deepStrictEqual(await fs.promises.readdir(content), [], 'successful synthetic check removes its private nonce');
        assert.deepStrictEqual(namespaceAudits.splice(0), ['unchanged:', 'unchanged:'], 'successful probe and cleanup keep the seeded namespace isolated');

        const sentinel = Buffer.alloc(36, 0x53); replaceNonceOnStat = sentinel;
        await assert.rejects(checkColabRuntime({ notebookRef: 'file:///fixture.ipynb' }), /cleanup of its private nonce file could not be verified/);
        const retainedNonceFiles = await fs.promises.readdir(content); assert.strictEqual(retainedNonceFiles.length, 1);
        assert.match(retainedNonceFiles[0], /^jupyter-mcp-colab-check-[0-9a-f-]{36}$/); assert.ok(!retainedNonceFiles[0].startsWith('.'));
        const retainedNoncePath = path.join(content, retainedNonceFiles[0]);
        assert.ok((await fs.promises.readFile(retainedNoncePath)).equals(sentinel), 'generated cleanup preserves a replaced non-owned nonce file');
        assert.deepStrictEqual(namespaceAudits.splice(0), ['unchanged:', 'unchanged:'], 'ownership-failed cleanup remains namespace-isolated');
        await fs.promises.rm(retainedNoncePath);
        assert.ok(checkPaths.size >= 3); assert.ok([...checkPaths].every((p) => p.startsWith('/content/jupyter-mcp-colab-check-') && !path.posix.basename(p).startsWith('.')));
        console.log('Real Python Colab-check algorithm validation: generated missing-module failure and synthetic-module success cleaned owned nonces; changed-nonce cleanup preserved its sentinel; isolated namespace checks passed. This is not proof of a live Colab runtime.');
        pythonCwd = undefined; forceLinux = false; auditNamespace = false;
        calls = 0; largestCode = 0; payloadReads = 0; payloadWrites = 0;

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

        // Kernel-execute route (files at or below 4 MiB): real Python decodes the single payload
        // literal, decompresses when flagged and verifies hashes; IPython must not retain requests.
        nativePhase = false;
        const mixed = Buffer.concat([crypto.randomBytes(400_000), Buffer.from('2026-09-01T08:00:00Z,CARPARK,23.4\n'.repeat(30_000))]);
        const kernelSource = path.join(root, 'kernel-source.bin'), kernelDestination = path.join(root, 'kernel-download.bin');
        await fs.promises.writeFile(kernelSource, mixed);
        const kernelArgs = { notebookRef: 'file:///fixture.ipynb', hostPath: kernelSource, kernelPath: '/content/kernel-route.bin' };
        const kup = JSON.parse(await uploadFile(kernelArgs));
        assert.strictEqual(kup.transport, 'kernel-execute'); assert.strictEqual(kup.bytes, mixed.length);
        assert.ok((await fs.promises.readFile(remotePath(kernelArgs.kernelPath))).equals(mixed), 'kernel-route upload is byte-identical');
        const kdown = JSON.parse(await downloadFile({ ...kernelArgs, hostPath: kernelDestination }));
        assert.strictEqual(kdown.sha256, kup.sha256);
        assert.ok((await fs.promises.readFile(kernelDestination)).equals(mixed), 'kernel-route download is byte-identical');
        const largestKernelRequest = Math.max(...mappedCodes.map((c) => Buffer.byteLength(c)));
        assert.ok(largestKernelRequest < 262_144 * 4 / 3 + 8192, `single payload encoding expected, got ${largestKernelRequest}`);
        const retained = ipythonRetainedBytes(mappedCodes, root);
        if (retained === undefined) console.log('IPython is not installed; skipped the code-cache retention replay.');
        else {
            assert.strictEqual(retained, 0, 'IPython retained transfer request sources');
            console.log(`IPython replay of ${mappedCodes.length} real transfer requests retained ${retained} bytes of request source.`);
        }
        await fs.promises.rm(remotePath(kernelArgs.kernelPath));
        console.log(`Real Python kernel-route round trip: ${mixed.length} bytes in ${mappedCodes.length} requests; largest request ${largestKernelRequest} bytes.`);
    } finally {
        extensionRegistry.clear(); workspace.workspaceFolders = []; workspace.fs = {};
        assert.strictEqual(path.dirname(root), parent);
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
