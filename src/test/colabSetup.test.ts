import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configureColab, getColabSetup, listColabSetupKernels, selectColabSetupKernel, assertNoColabSetup, acquireDesktopLease, SetupDeps } from '../colabSetup';
import { state, reset, uri } from './colabSetupStub';

const ref = 'file:///test.ipynb';
function fixture(options: {
    optional?: boolean; checkFails?: boolean; checkFalse?: boolean; failChoice?: boolean; close?: boolean;
    omitListing?: boolean; listFails?: boolean; listDelay?: boolean; selectDelay?: boolean; providerDelay?: boolean;
    listings?: Array<Array<{ choiceId: string; label: string }>>;
} = {}) {
    reset();
    const events: string[] = []; let released = 0; let checked = 0; let enteredAlias: string; let listing = 0;
    let inputs = options.optional ? ['Select a machine shape', 'Select a runtime version', 'Alias your server'] : ['Alias your server'];
    const listed = options.listings ?? [[{ choiceId: 'kernel-python', label: 'Python 3 (ipykernel)' }]];
    const desktop: any = {
        bind: async (marker: string) => { assert.ok(state.markers.some((m: any) => m.text === marker)); events.push('bind'); },
        choose: async (_headers: readonly string[], labels: readonly string[], signal: AbortSignal) => {
            events.push(labels[0]); if (options.failChoice) throw new Error('secret UI content');
            if (options.close) state.notebook.isClosed = true;
            if (options.providerDelay) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
                events.push('provider-aborted'); reject(new Error('private pending picker'));
            }, { once: true }));
            return labels[0] === 'Select Another Kernel...' ? 'Select Another Kernel...' : labels[0];
        },
        waitForInput: async (headers: readonly string[]) => { const result = inputs.shift()!; assert.ok(headers.includes(result)); return result; },
        enter: async (headers: readonly string[], value: string) => { assert.deepStrictEqual(headers, ['Alias your server']); assert.ok(value.length < 10, 'Colab 0.9.7 alias length limit'); assert.match(value, /^m[a-f0-9]{8}$/); enteredAlias = value; events.push('alias'); },
        listChoices: async (headers: readonly string[], signal: AbortSignal) => {
            assert.deepStrictEqual(headers, ['Select a Kernel from ' + enteredAlias]); events.push('list');
            if (options.listFails) throw new Error('secret picker content');
            if (options.listDelay) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private cancelled listing')), { once: true }));
            return listed[Math.min(listing++, listed.length - 1)];
        },
        chooseListed: async (headers: readonly string[], choiceId: string, signal: AbortSignal) => {
            assert.deepStrictEqual(headers, ['Select a Kernel from ' + enteredAlias]); events.push('chosen:' + choiceId);
            if (options.selectDelay) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private cancelled selection')), { once: true }));
        },
        dispose: () => { events.push('dispose'); }
    };
    if (options.omitListing) { delete desktop.listChoices; delete desktop.chooseListed; }
    const deps: SetupDeps = {
        timeoutMs: 500,
        lease: async () => { events.push('lease'); return async () => { released++; }; },
        check: async (_ref, root) => { checked++; assert.strictEqual(_ref, ref); assert.ok(root?.startsWith('colab://')); if (options.checkFails) throw new Error('secret runtime'); return JSON.stringify({ verified: !options.checkFalse, checks: { nonce: true } }); },
        desktop: () => desktop
    };
    return { deps, events, get released() { return released; }, get checked() { return checked; } };
}
async function waitForActionOrFinish(setupId: string): Promise<any> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const current = JSON.parse(await getColabSetup(ref, setupId));
        if (current.stage === 'awaiting_kernel_selection' || current.stage === 'finished') return current;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('setup did not reach an action or terminal state');
}
async function start(f: ReturnType<typeof fixture>): Promise<any> {
    const initial = JSON.parse(await configureColab(ref, { waitMs: 0 }, f.deps));
    return waitForActionOrFinish(initial.setupId);
}
async function result(f: ReturnType<typeof fixture>): Promise<any> {
    const pending = await start(f);
    if (pending.stage === 'finished') return pending;
    const listed = JSON.parse(await listColabSetupKernels(ref, pending.setupId));
    return JSON.parse(await selectColabSetupKernel(ref, pending.setupId, listed.choices[0].choiceId, 1000));
}
async function main() {
    let count = 0;
    const test = async (name: string, work: () => Promise<void>) => { await work(); count++; console.log('PASS ' + name); };
    await test('all CPU selections, exact temporary startup, mounting and verification run inside setup', async () => {
        const f = fixture(); const before = state.notebook.getCells().map((c: any) => c.document.getText()); const r = await result(f);
        assert.strictEqual(r.ready, true); assert.strictEqual(f.checked, 1); assert.strictEqual(f.released, 1);
        assert.deepStrictEqual(state.notebook.getCells().map((c: any) => c.document.getText()), before);
        assert.deepStrictEqual(f.events, ['lease', 'bind', 'Select Another Kernel...', 'Colab', 'New Colab Server', 'CPU', 'alias', 'list', 'chosen:kernel-python', f.events[9], 'dispose']);
        assert.match(f.events[9], /^m[a-f0-9]{8}$/); assert.strictEqual(r.startupCellRetained, false);
        assert.ok(state.calls.find((c: any) => c[0] === 'notebook.selectKernel')[1].notebookEditor.notebook === state.notebook);
    });
    await test('optional Standard and Latest stages are handled, never GPU/TPU/upgrade', async () => {
        const f = fixture({ optional: true }); assert.strictEqual((await result(f)).ready, true);
        assert.ok(f.events.includes('Standard')); assert.ok(f.events.includes('Latest')); assert.ok(!f.events.some((s) => /GPU|TPU|Pro/.test(s)));
    });
    await test('verified existing runtime is reused without UI, startup or a new server', async () => {
        const f = fixture(); state.active = { status: 'idle' }; state.folders.push({ uri: uri('colab://existing/content') });
        assert.strictEqual((await result(f)).ready, true); assert.strictEqual(f.checked, 1); assert.deepStrictEqual(f.events, []); assert.deepStrictEqual(state.calls, []);
    });
    for (const [name, mutate, code] of [
        ['remote host', () => { state.remoteName = 'ssh-remote'; }, 'remote_host_unsupported'],
        ['untrusted workspace', () => { state.trusted = false; }, 'workspace_untrusted'],
        ['empty workspace', () => { state.folders = []; }, 'workspace_required'],
        ['missing Colab', () => { state.installed = false; }, 'colab_missing'],
        ['changed Colab UI version', () => { state.version = '1.0.0'; }, 'colab_version_unsupported'],
        ['busy kernel', () => { state.active = { status: 'busy' }; }, 'kernel_busy']
    ] as const) await test('preflight rejects ' + name, async () => {
        const f = fixture(); mutate(); const r = await result(f); assert.strictEqual(r.code, code); assert.strictEqual(r.ready, false); assert.strictEqual(f.checked, 0); assert.deepStrictEqual(f.events, []);
    });
    await test('wrong revealed notebook prevents picker and startup', async () => {
        const f = fixture(); state.editorMismatch = true; const r = await result(f); assert.strictEqual(r.code, 'notebook_changed'); assert.strictEqual(f.released, 1); assert.deepStrictEqual(state.calls, []);
    });
    await test('UI failure is sanitized and cannot pass readiness', async () => {
        const f = fixture({ failChoice: true }); const r = await result(f); assert.strictEqual(r.ready, false); assert.doesNotMatch(JSON.stringify(r), /secret/); assert.strictEqual(f.checked, 0); assert.strictEqual(f.released, 1);
    });
    await test('closed notebook stops before startup', async () => {
        const f = fixture({ close: true }); const r = await result(f); assert.strictEqual(r.code, 'notebook_changed'); assert.ok(!state.calls.some((c: any) => c[0] === 'notebook.cell.execute'));
    });
    for (const rejected of [false, true]) await test('early ' + (rejected ? 'rejected' : 'false') + ' kernel command cancels picker work without running a cell', async () => {
        const f = fixture(); state.selection = rejected ? Promise.reject(new Error('secret picker rejection')) : false;
        const r = await result(f); assert.strictEqual(r.code, 'kernel_selection_unconfirmed');
        assert.doesNotMatch(JSON.stringify(r), /secret/);
        assert.ok(!state.calls.some((c: any) => c[0] === 'notebook.cell.execute'));
        assert.ok(!f.events.some((event) => event.startsWith('chosen:')));
    });
    await test('a later false kernel command aborts the pending provider observation', async () => {
        const f = fixture({ providerDelay: true }); let finishSelection!: (value: boolean) => void;
        state.selection = new Promise<boolean>((resolve) => { finishSelection = resolve; });
        const initial = JSON.parse(await configureColab(ref, { waitMs: 0 }, f.deps));
        while (!f.events.includes('Select Another Kernel...')) await new Promise((resolve) => setTimeout(resolve, 1));
        finishSelection(false);
        const r = JSON.parse(await getColabSetup(ref, initial.setupId, 1000));
        assert.strictEqual(r.code, 'kernel_selection_unconfirmed'); assert.ok(f.events.includes('provider-aborted'));
        assert.ok(!state.calls.some((call: any) => call[0] === 'notebook.cell.execute'));
    });
    await test('setup waits for an explicit listed kernel and never chooses a default', async () => {
        const f = fixture(); const pending = await start(f);
        assert.strictEqual(pending.stage, 'awaiting_kernel_selection');
        assert.deepStrictEqual(pending.actionRequired, {
            kind: 'kernel_selection', listTool: 'list_setup_kernels', selectTool: 'select_setup_kernel', choicesListed: false
        });
        assert.ok(!f.events.some((event) => event.startsWith('chosen:')));
        assert.ok(!state.calls.some((call: any) => call[0] === 'notebook.cell.execute'));
        const cancelled = JSON.parse(await getColabSetup(ref, pending.setupId, 1000, true));
        assert.strictEqual(cancelled.status, 'cancelled'); assert.strictEqual(f.checked, 0); assert.strictEqual(f.released, 1);
    });
    await test('listing support is required before provider UI is mutated', async () => {
        const f = fixture({ omitListing: true }); const r = await result(f);
        assert.strictEqual(r.code, 'kernel_choice_unsupported'); assert.strictEqual(r.ready, false);
        assert.deepStrictEqual(f.events, ['lease', 'dispose']); assert.deepStrictEqual(state.calls, []);
    });
    await test('only an exact choice from the latest listing can continue the owned setup', async () => {
        const f = fixture({ listings: [
            [{ choiceId: 'old-python', label: 'Python 3' }],
            [{ choiceId: 'new-python', label: 'Python 3' }, { choiceId: 'new-r', label: 'R' }]
        ] });
        const pending = await start(f);
        const first = JSON.parse(await listColabSetupKernels(ref, pending.setupId));
        const second = JSON.parse(await listColabSetupKernels(ref, pending.setupId));
        assert.strictEqual(first.listingVersion + 1, second.listingVersion);
        assert.deepStrictEqual(second.choices, [{ choiceId: 'new-python', label: 'Python 3' }, { choiceId: 'new-r', label: 'R' }]);
        await assert.rejects(() => selectColabSetupKernel(ref, pending.setupId, 'old-python'), /stale/);
        await assert.rejects(() => selectColabSetupKernel('file:\/\/\/wrong.ipynb', pending.setupId, 'new-python'), /No matching/);
        await assert.rejects(() => selectColabSetupKernel(ref, 'wrong-setup', 'new-python'), /No matching/);
        assert.ok(!f.events.some((event) => event.startsWith('chosen:')));
        const r = JSON.parse(await selectColabSetupKernel(ref, pending.setupId, 'new-r', 1000));
        assert.strictEqual(r.ready, true); assert.ok(f.events.includes('chosen:new-r'));
    });
    await test('selection without a current listing fails before any desktop action', async () => {
        const f = fixture(); const pending = await start(f);
        await assert.rejects(() => selectColabSetupKernel(ref, pending.setupId, 'kernel-python'), /stale/);
        assert.ok(!f.events.some((event) => event.startsWith('chosen:')));
        await getColabSetup(ref, pending.setupId, 1000, true);
    });
    await test('listing failures are sanitized and leave the setup cancellable', async () => {
        const f = fixture({ listFails: true }); const pending = await start(f);
        await assert.rejects(() => listColabSetupKernels(ref, pending.setupId), (error: Error) => {
            assert.doesNotMatch(error.message, /secret/); return true;
        });
        const cancelled = JSON.parse(await getColabSetup(ref, pending.setupId, 1000, true));
        assert.strictEqual(cancelled.status, 'cancelled'); assert.strictEqual(f.checked, 0);
    });
    await test('malformed or duplicate choice ids are never exposed or selectable', async () => {
        const f = fixture({ listings: [[
            { choiceId: 'duplicate', label: 'Python 3' }, { choiceId: 'duplicate', label: 'Hostile duplicate' }
        ]] });
        const pending = await start(f);
        await assert.rejects(() => listColabSetupKernels(ref, pending.setupId), /malformed or ambiguous/);
        await assert.rejects(() => selectColabSetupKernel(ref, pending.setupId, 'duplicate'), /stale/);
        assert.ok(!f.events.some((event) => event.startsWith('chosen:')));
        await getColabSetup(ref, pending.setupId, 1000, true);
    });
    await test('cancellation aborts an in-flight listing without selecting or starting a cell', async () => {
        const f = fixture({ listDelay: true }); const pending = await start(f);
        const listing = listColabSetupKernels(ref, pending.setupId);
        while (!f.events.includes('list')) await new Promise((resolve) => setTimeout(resolve, 1));
        const cancelled = JSON.parse(await getColabSetup(ref, pending.setupId, 1000, true));
        assert.strictEqual(cancelled.status, 'cancelled'); await assert.rejects(() => listing);
        assert.ok(!f.events.some((event) => event.startsWith('chosen:')));
        assert.ok(!state.calls.some((call: any) => call[0] === 'notebook.cell.execute'));
    });
    await test('cancellation aborts a listed selection before startup', async () => {
        const f = fixture({ selectDelay: true }); const pending = await start(f);
        const listed = JSON.parse(await listColabSetupKernels(ref, pending.setupId));
        const selection = selectColabSetupKernel(ref, pending.setupId, listed.choices[0].choiceId, 0);
        while (!f.events.some((event) => event.startsWith('chosen:'))) await new Promise((resolve) => setTimeout(resolve, 1));
        const cancelled = JSON.parse(await getColabSetup(ref, pending.setupId, 1000, true));
        assert.strictEqual(cancelled.status, 'cancelled');
        const selectionReceipt = JSON.parse(await selection); assert.strictEqual(selectionReceipt.status, 'running');
        assert.ok(!state.calls.some((call: any) => call[0] === 'notebook.cell.execute'));
    });
    await test('startup failure retains visible cell and does not verify', async () => {
        const f = fixture(); state.startupMode = 'failure'; const r = await result(f); assert.strictEqual(r.code, 'startup_failed'); assert.strictEqual(r.startupCellRetained, true); assert.strictEqual(f.checked, 0);
    });
    await test('user-modified temporary cell is never deleted', async () => {
        const f = fixture(); state.startupMode = 'edit'; const r = await result(f); assert.strictEqual(r.code, 'startup_cell_changed'); assert.ok(state.notebook.getCells().some((c: any) => c.document.getText() === 'human edit'));
    });
    await test('failed cleanup prevents success', async () => {
        const f = fixture(); state.cleanupFailure = true; const r = await result(f); assert.strictEqual(r.ready, false); assert.strictEqual(r.startupCellRetained, true); assert.strictEqual(f.checked, 0);
    });
    await test('ambiguous filesystem never reaches verifier', async () => {
        const f = fixture(); state.mountMode = 'ambiguous'; const r = await result(f); assert.strictEqual(r.code, 'filesystem_ambiguous'); assert.strictEqual(f.checked, 0);
    });
    for (const checkFails of [true, false]) await test('failed or negative nonce check never becomes ready ' + checkFails, async () => {
        const f = fixture({ checkFails, checkFalse: !checkFails }); const r = await result(f); assert.strictEqual(r.ready, false); assert.doesNotMatch(JSON.stringify(r), /secret/);
    });
    await test('tracked setup can be recovered and cancelled; request wait does not cancel', async () => {
        const f = fixture(); state.startupMode = 'hang'; const r = JSON.parse(await configureColab(ref, { waitMs: 0 }, f.deps));
        assert.strictEqual(r.status, 'running'); assert.throws(() => assertNoColabSetup(ref), /still active/);
        const cancelled = JSON.parse(await getColabSetup(ref, r.setupId, 1000, true)); assert.strictEqual(cancelled.ready, false); assert.strictEqual(cancelled.status, 'cancelled');
        assertNoColabSetup(ref); await assert.rejects(() => getColabSetup('file:///wrong', r.setupId), /No matching/);
    });
    await test('wait bounds and unknown setup fail before work', async () => {
        const f = fixture(); await assert.rejects(() => configureColab(ref, { waitMs: -1 }, f.deps), /waitMs/); await assert.rejects(() => getColabSetup(ref, 'missing'), /No matching/);
    });
    await test('unsettled startup keeps its cell and lease until the command settles', async () => {
        const f = fixture(); state.startupMode = 'unsettled'; const r = await result(f);
        assert.strictEqual(r.status, 'cancelled'); assert.strictEqual(r.ready, false);
        assert.strictEqual(r.cleanupPending, true); assert.strictEqual(r.startupCellRetained, true); assert.strictEqual(f.released, 0);
        assert.throws(() => assertNoColabSetup(ref), /still active/);
        state.finishCommand(); await new Promise((resolve) => setTimeout(resolve, 5));
        assert.strictEqual(f.released, 1); assertNoColabSetup(ref);
        const final = JSON.parse(await getColabSetup(ref, r.setupId)); assert.strictEqual(final.cleanupPending, false); assert.strictEqual(final.ready, false);
    });
    await test('desktop lease excludes another owner and releases normally', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jupyter-mcp-lease-test-'));
        const release = await acquireDesktopLease(directory);
        try { await assert.rejects(() => acquireDesktopLease(directory), /Another Colab setup/); }
        finally { await release(); }
        const again = await acquireDesktopLease(directory); await again(); fs.rmdirSync(directory);
    });
    for (const reuse of [false, true]) await test('cancelled verification retains the guard until its cleanup settles; reuse=' + reuse, async () => {
        const f = fixture();
        if (reuse) { state.active = { status: 'idle' }; state.folders.push({ uri: uri('colab://existing/content') }); }
        let finishCheck!: (value: string) => void;
        f.deps.check = () => new Promise<string>((resolve) => { finishCheck = resolve; });
        const r = await result(f);
        assert.strictEqual(r.status, 'cancelled'); assert.strictEqual(r.ready, false); assert.strictEqual(r.cleanupPending, true);
        assert.throws(() => assertNoColabSetup(ref), /still active/); assert.strictEqual(f.released, 0);
        finishCheck(JSON.stringify({ verified: true })); await new Promise((resolve) => setTimeout(resolve, 5));
        const final = JSON.parse(await getColabSetup(ref, r.setupId)); assert.strictEqual(final.cleanupPending, false); assert.strictEqual(final.ready, false);
        assert.strictEqual(f.released, reuse ? 0 : 1); assertNoColabSetup(ref);
    });
    await test('cleanup expiry has its own failure and retains pending editor work', async () => {
        const f = fixture(); f.deps.cleanupWaitMs = 10; state.cleanupHang = true;
        const r = await result(f);
        assert.strictEqual(r.status, 'failed'); assert.strictEqual(r.code, 'cleanup_timeout');
        assert.strictEqual(r.ready, false); assert.strictEqual(r.cleanupPending, true); assert.strictEqual(r.startupCellRetained, true);
        assert.strictEqual(f.checked, 0); assert.strictEqual(f.released, 0);
        state.finishCleanup(); await new Promise((resolve) => setTimeout(resolve, 5));
        assert.strictEqual(f.released, 1); assertNoColabSetup(ref);
    });
    console.log(`${count} Colab setup tests passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
