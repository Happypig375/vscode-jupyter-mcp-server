import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configureColab, getColabSetup, listColabSetupKernels, mountColabServer, selectColabSetupKernel, assertNoColabSetup, acquireDesktopLease, SetupDeps } from '../colabSetup';
import { createColabNativeDriverForTest } from '../colabNative';
import { DesktopSetupError } from '../colabDesktop';
import { runNotebookCells, getExecution, interruptKernels, hasPendingNotebookExecutionCommand } from '../notebookOps';
import { state, reset, uri } from './colabSetupStub';

const ref = 'file:///test.ipynb';
function fixture(options: {
    optional?: boolean; checkFails?: boolean; checkFalse?: boolean; failChoice?: boolean; close?: boolean;
    omitListing?: boolean; listFails?: boolean; listDelay?: boolean; selectDelay?: boolean; providerDelay?: boolean;
    productionBind?: boolean; missingServerAlias?: boolean; directSourcePicker?: boolean; providerHandoff?: string;
    failAt?: 'initial' | 'source' | 'server_prompt' | 'handoff' | 'existing_alias' | 'new_server';
    listings?: Array<Array<{ choiceId: string; label: string }>>;
} = {}) {
    reset();
    const events: string[] = []; const headerSelections: string[][] = []; const checkedRoots: Array<string | undefined> = []; let released = 0; let checked = 0; let enteredAlias: string; let listing = 0; let nativeBinds = 0;
    let inputs = options.optional ? ['Select a machine shape', 'Select a runtime version', 'Alias your server'] : ['Alias your server'];
    const listed = options.listings ?? [[{ choiceId: 'kernel-python', label: 'Python 3 (ipykernel)' }]];
    const nativeBindingDriver = options.productionBind ? createColabNativeDriverForTest(9222, {
        targets: async () => [{ id: 'owner', type: 'page', url: 'vscode-file://vscode-app/workbench/workbench.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/owner' }],
        connect: async () => ({
            evaluate: async () => { nativeBinds++; return { dom: true, markers: 1, widgets: 0, inputCount: 0, title: '', placeholder: '', ariaLabel: '', value: '', active: false, focused: true, incomplete: false, rows: [] }; },
            bringToFront: async () => { throw new Error('Binding must not focus the page'); },
            dispose() {}
        })
    }) : undefined;
    const desktop: any = {
        bind: async (marker: string, signal: AbortSignal) => {
            assert.ok(state.markers.some((m: any) => m.text === marker));
            if (nativeBindingDriver) await nativeBindingDriver.bind(marker, signal);
            events.push('bind');
        },
        choose: async (_headers: readonly string[], labels: readonly string[], signal: AbortSignal) => {
            headerSelections.push([..._headers]);
            if ((options.failAt === 'initial' && headerSelections.length === 1) ||
                (options.failAt === 'source' && labels[0] === 'Colab' && headerSelections.length === 2) ||
                (options.failAt === 'handoff' && labels[0] === 'Colab' && headerSelections.length === 3) ||
                (options.failAt === 'existing_alias' && _headers[0] === 'Select a Jupyter Server' && /^m[a-f0-9]{8}$/.test(labels[0])) ||
                (options.failAt === 'new_server' && labels[0] === 'New Colab Server')) throw new DesktopSetupError('picker_timeout');
            if (options.directSourcePicker && headerSelections.length === 1) {
                assert.ok(_headers.includes('Select Another Kernel'));
                assert.ok(labels.includes('Colab')); events.push('Colab'); return 'Colab';
            }
            events.push(labels[0]); if (options.failChoice) throw new Error('secret UI content');
            if (options.missingServerAlias && _headers[0] === 'Select a Jupyter Server' && /^m[a-f0-9]{8}$/.test(labels[0])) throw new Error('secret missing alias row');
            if (_headers[0] === 'Select a Jupyter Server' && /^m[a-f0-9]{8}$/.test(labels[0])) enteredAlias = labels[0];
            if (options.close) state.notebook.isClosed = true;
            if (options.providerDelay) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
                events.push('provider-aborted'); reject(new Error('private pending picker'));
            }, { once: true }));
            if (_headers.includes('Mount Server to Workspace') && state.mountMode !== 'noRoot') {
                if (!state.folders.some((folder: any) => folder.name === labels[0] && folder.uri.scheme === 'colab')) {
                    state.folders.push({ name: labels[0], uri: uri('colab://test-server/content') });
                }
                if (state.mountMode === 'ambiguous') state.folders.push({ name: 'Other', uri: uri('colab://other-server/content') });
            }
            return labels[0] === 'Select Another Kernel...' ? 'Select Another Kernel...' : labels[0];
        },
        waitForInput: async (headers: readonly string[]) => {
            if (options.failAt === 'server_prompt' && headers.includes('Select a Jupyter Server')) throw new DesktopSetupError('picker_timeout');
            const result = headers.includes('Select a Jupyter Server') ? (options.providerHandoff ?? 'Select a Jupyter Server') : inputs.shift()!;
            assert.ok(headers.includes(result)); return result;
        },
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
        dispose: () => { nativeBindingDriver?.dispose(); events.push('dispose'); }
    };
    if (options.omitListing) { delete desktop.listChoices; delete desktop.chooseListed; }
    const deps: SetupDeps = {
        timeoutMs: 500,
        lease: async () => { events.push('lease'); return async () => { released++; }; },
        check: async (_ref, root) => { checked++; checkedRoots.push(root); assert.strictEqual(_ref, ref); assert.ok(root?.startsWith('colab://')); if (options.checkFails) throw new Error('secret runtime'); return JSON.stringify({ verified: !options.checkFalse, checks: { nonce: true } }); },
        desktop: () => desktop
    };
    return { deps, events, headerSelections, checkedRoots, get released() { return released; }, get checked() { return checked; }, get nativeBinds() { return nativeBinds; } };
}
async function waitForActionOrFinish(setupId: string): Promise<any> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        const current = JSON.parse(await getColabSetup(ref, setupId));
        if (current.stage === 'awaiting_kernel_selection' || current.stage === 'finished') return current;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('setup did not reach an action or terminal state');
}
async function start(f: ReturnType<typeof fixture>, serverAlias?: string): Promise<any> {
    const initial = JSON.parse(await configureColab(ref, { waitMs: 0, serverAlias }, f.deps));
    return waitForActionOrFinish(initial.setupId);
}
async function result(f: ReturnType<typeof fixture>, serverAlias?: string): Promise<any> {
    const pending = await start(f, serverAlias);
    if (pending.stage === 'finished') return pending;
    const listed = JSON.parse(await listColabSetupKernels(ref, pending.setupId));
    return JSON.parse(await selectColabSetupKernel(ref, pending.setupId, listed.choices[0].choiceId, 1000));
}
async function main() {
    let count = 0;
    const test = async (name: string, work: () => Promise<void>) => { await work(); count++; console.log('PASS ' + name); };
    for (const settlement of ['resolve', 'reject_after_history_expiry'] as const) {
        await test('interrupt keeps unsettled notebook command quarantined until ' + settlement, async () => {
            const f = fixture(); state.notebook.isUntitled = true; state.userExecutionMode = 'unsettled';
            const running = JSON.parse(await runNotebookCells(ref, [0, 1], { waitMs: 0 }));
            const deadline = Date.now() + 2000;
            while (!state.finishUserCommand && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
            assert.strictEqual(typeof state.finishUserCommand, 'function');
            assert.strictEqual(hasPendingNotebookExecutionCommand(ref), true);
            await interruptKernels([ref]);
            const interrupted = JSON.parse(await getExecution(ref, { executionId: running.executionId, waitMs: 1000 }));
            assert.strictEqual(interrupted.status, 'unavailable');
            assert.strictEqual(interrupted.notebookCommandPending, true);
            assert.strictEqual(interrupted.cells[1].state, 'not-run');
            if (settlement === 'reject_after_history_expiry') {
                const originalNow = Date.now, expired = originalNow() + 3600001;
                try {
                    Date.now = () => expired;
                    await assert.rejects(getExecution(ref, { executionId: running.executionId }), /Unknown executionId/);
                } finally { Date.now = originalNow; }
            }
            const blocked = await result(f, 'm7ae91d89');
            assert.strictEqual(blocked.code, 'execution_command_pending');
            assert.strictEqual(blocked.failedStage, 'preflight');
            assert.deepStrictEqual(f.events, []);
            assert.ok(!state.calls.some((call: any) => call[0] === 'notebook.selectKernel'));
            await assert.rejects(runNotebookCells(ref, [0], { waitMs: 0 }), /execution command is still pending/);
            state.finishUserCommand(settlement === 'resolve' ? undefined : new Error('private command detail'));
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(hasPendingNotebookExecutionCommand(ref), false);
            const recovered = await result(f, 'm7ae91d89');
            assert.strictEqual(recovered.ready, true);
            assert.ok(!JSON.stringify(recovered).includes('private command detail'));
            assert.strictEqual(state.calls.filter((call: any) => call[0] === 'notebook.cell.execute').length, 2, 'only the first user-cell dispatch and owned setup cell; no later user cell');
        });
    }
    for (const [failAt, failedProviderStep] of [
        ['initial', 'opening_kernel_picker'], ['source', 'choosing_colab_source'],
        ['server_prompt', 'awaiting_server_picker'], ['handoff', 'choosing_colab_handoff'],
        ['existing_alias', 'choosing_existing_server'], ['new_server', 'choosing_new_server']
    ] as const) {
        await test('provider timeout identifies ' + failedProviderStep, async () => {
            const f = fixture({ failAt, providerHandoff: failAt === 'handoff' ? 'Select Another Kernel' : undefined });
            const r = await result(f, failAt === 'new_server' ? undefined : 'm7ae91d89');
            assert.strictEqual(r.code, 'picker_timeout');
            assert.strictEqual(r.failedStage, 'selecting_provider');
            assert.strictEqual(r.failedProviderStep, failedProviderStep);
            assert.strictEqual(r.providerStep, undefined, 'finished receipt uses failedProviderStep');
            assert.strictEqual(r.startupCellRetained, false);
            assert.ok(!state.calls.some((call: any) => call[0] === 'notebook.cell.execute'));
        });
    }
    await test('all CPU selections, exact temporary startup, mounting and verification run inside setup', async () => {
        const f = fixture(); const before = state.notebook.getCells().map((c: any) => c.document.getText()); const r = await result(f);
        assert.strictEqual(r.ready, true); assert.strictEqual(f.checked, 1); assert.strictEqual(f.released, 1);
        assert.deepStrictEqual(state.notebook.getCells().map((c: any) => c.document.getText()), before);
        assert.deepStrictEqual(f.events, ['lease', 'bind', 'Select Another Kernel...', 'Colab', 'New Colab Server', 'CPU', 'alias', 'list', 'chosen:kernel-python', f.events[9], 'dispose']);
        assert.match(f.events[9], /^m[a-f0-9]{8}$/); assert.strictEqual(r.serverAlias, f.events[9]); assert.strictEqual(r.operation, 'configure_kernel'); assert.strictEqual(r.startupCellRetained, false);
        assert.ok(state.calls.find((c: any) => c[0] === 'notebook.selectKernel')[1].notebookEditor.notebook === state.notebook);
    });
    await test('optional Standard and Latest stages are handled, never GPU/TPU/upgrade', async () => {
        const f = fixture({ optional: true }); assert.strictEqual((await result(f)).ready, true);
        assert.ok(f.events.includes('Standard')); assert.ok(f.events.includes('Latest')); assert.ok(!f.events.some((s) => /GPU|TPU|Pro/.test(s)));
    });
    await test('initial controller suggestions bind the exact notebook label before the source picker', async () => {
        const f = fixture(); state.relativeNotebookLabel = 'nested/target.ipynb';
        assert.strictEqual((await result(f, 'm7ae91d89')).ready, true);
        assert.deepStrictEqual(f.headerSelections[0], process.platform === 'win32'
            ? ['Select Kernel', 'Select Another Kernel', "Select kernel for 'nested/target.ipynb'", "Change kernel for 'nested/target.ipynb'", "Select kernel for 'nested\\target.ipynb'", "Change kernel for 'nested\\target.ipynb'"]
            : ['Select Kernel', 'Select Another Kernel', "Select kernel for 'nested/target.ipynb'", "Change kernel for 'nested/target.ipynb'"]);
        assert.deepStrictEqual(f.headerSelections[1], ['Select Kernel', 'Select Another Kernel']);
        assert.ok(!f.events.includes('Python'), 'a suggested local controller is never selected');
    });
    await test('requested existing alias skips server creation and continues explicit kernel selection', async () => {
        const alias = 'm7ae91d89'; const f = fixture(); state.active = { status: 'idle' };
        state.folders.push({ name: 'stale', uri: uri('colab://stale/content') });
        const r = await result(f, alias);
        assert.strictEqual(r.ready, true); assert.strictEqual(r.serverAlias, alias); assert.strictEqual(r.serverMayRemain, false);
        assert.deepStrictEqual(f.events, ['lease', 'bind', 'Select Another Kernel...', 'Colab', alias, 'list', 'chosen:kernel-python', alias, 'dispose']);
        assert.ok(!f.events.some((event) => ['New Colab Server', 'CPU', 'Standard', 'Latest', 'alias'].includes(event)));
        assert.ok(state.calls.some((call: any) => call[0] === 'notebook.cell.execute'));
        assert.ok(state.calls.some((call: any) => call[0] === 'colab.mountServer'));
    });
    await test('a direct source picker recovers the exact server without a suggestions action', async () => {
        const alias = 'm7ae91d89'; const f = fixture({ directSourcePicker: true });
        state.folders.push({ name: alias, uri: uri('colab://matching/content') });
        const r = await result(f, alias);
        assert.strictEqual(r.ready, true); assert.strictEqual(r.serverAlias, alias);
        assert.deepStrictEqual(f.events, ['lease', 'bind', 'Colab', alias, 'list', 'chosen:kernel-python', alias, 'dispose']);
        assert.ok(!f.events.includes('Select Another Kernel...'));
        assert.deepStrictEqual(f.checkedRoots, ['colab://matching/']);
    });
    await test('one reopened provider picker selects only Colab before the exact existing alias', async () => {
        for (const providerHandoff of ['Select Kernel', 'Select Another Kernel']) {
            const alias = 'm7ae91d89'; const f = fixture({ directSourcePicker: true, providerHandoff });
            const r = await result(f, alias);
            assert.strictEqual(r.ready, true); assert.strictEqual(r.serverAlias, alias);
            assert.deepStrictEqual(f.headerSelections[1], [providerHandoff]);
            assert.deepStrictEqual(f.events, ['lease', 'bind', 'Colab', 'Colab', alias, 'list', 'chosen:kernel-python', alias, 'dispose']);
            assert.ok(!f.events.includes('New Colab Server'));
        }
    });
    await test('multi-folder recovery uses the notebook folder name and workbench bullet separator', async () => {
        const f = fixture(); state.relativeNotebookLabel = 'nested/target.ipynb';
        state.folders.push({ name: 'm7ae91d89', uri: uri('colab://matching/content') });
        assert.strictEqual((await result(f, 'm7ae91d89')).ready, true);
        assert.deepStrictEqual(f.headerSelections[0], process.platform === 'win32'
            ? ['Select Kernel', 'Select Another Kernel', "Select kernel for 'workspace • nested/target.ipynb'", "Change kernel for 'workspace • nested/target.ipynb'", "Select kernel for 'workspace • nested\\target.ipynb'", "Change kernel for 'workspace • nested\\target.ipynb'"]
            : ['Select Kernel', 'Select Another Kernel', "Select kernel for 'workspace • nested/target.ipynb'", "Change kernel for 'workspace • nested/target.ipynb'"]);
    });
    await test('requested alias reuses only its unique mounted root with fresh verification', async () => {
        const alias = 'm7ae91d89'; const f = fixture(); state.active = { status: 'idle' };
        state.folders.push({ name: alias, uri: uri('colab://matching/content') }, { name: 'stale', uri: uri('colab://stale/content') });
        const r = await result(f, alias);
        assert.strictEqual(r.ready, true); assert.strictEqual(r.serverAlias, alias);
        assert.deepStrictEqual(f.checkedRoots, ['colab://matching/']); assert.deepStrictEqual(f.events, []); assert.deepStrictEqual(state.calls, []);
    });
    await test('requested alias can rediscover its kernel while reusing an existing exact mount', async () => {
        const alias = 'm7ae91d89'; const f = fixture();
        state.folders.push({ name: alias, uri: uri('colab://matching/content') });
        const r = await result(f, alias);
        assert.strictEqual(r.ready, true); assert.deepStrictEqual(f.checkedRoots, ['colab://matching/']);
        assert.deepStrictEqual(f.events, ['lease', 'bind', 'Select Another Kernel...', 'Colab', alias, 'list', 'chosen:kernel-python', alias, 'dispose']);
        assert.ok(state.calls.some((call: any) => call[0] === 'notebook.cell.execute'));
        assert.ok(state.calls.some((call: any) => call[0] === 'colab.mountServer'));
    });
    await test('invalid requested aliases fail before setup or UI', async () => {
        const f = fixture();
        for (const alias of ['', 'Colab CPU', 'mABCDEF12', 'm1234567', 'm123456789', 'm1234567g']) {
            await assert.rejects(() => configureColab(ref, { serverAlias: alias }, f.deps), /serverAlias/);
        }
        assert.deepStrictEqual(f.events, []); assert.deepStrictEqual(state.calls, []); assert.strictEqual(f.checked, 0);
    });
    await test('missing requested alias fails without creating a fallback server', async () => {
        const alias = 'm7ae91d89'; const f = fixture({ missingServerAlias: true });
        const r = await result(f, alias);
        assert.strictEqual(r.ready, false); assert.strictEqual(r.serverAlias, alias); assert.strictEqual(r.code, 'setup_failed');
        assert.deepStrictEqual(f.events, ['lease', 'bind', 'Select Another Kernel...', 'Colab', alias, 'dispose']);
        assert.ok(!f.events.some((event) => ['New Colab Server', 'CPU', 'Standard', 'Latest', 'alias'].includes(event)));
        assert.ok(!state.calls.some((call: any) => ['notebook.cell.execute', 'colab.mountServer'].includes(call[0])));
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
    for (const isActive of [false, true]) await test('failed Colab activation stops before UI even when isActive=' + isActive, async () => {
        const f = fixture(); state.colabIsActive = isActive; state.activationFailure = true;
        const r = await result(f);
        assert.strictEqual(state.activationCalls, 1); assert.strictEqual(r.code, 'colab_activation_failed');
        assert.strictEqual(r.ready, false); assert.strictEqual(r.failedStage, 'preflight');
        assert.doesNotMatch(JSON.stringify(r), /secret/); assert.deepStrictEqual(f.events, []);
        assert.deepStrictEqual(state.calls, []); assert.strictEqual(f.checked, 0);
    });
    await test('mount recovery requires an exact generated alias before starting a lifecycle', async () => {
        const f = fixture();
        for (const alias of ['', 'Colab CPU', 'mABCDEF12', 'm1234567', 'm123456789', 'm1234567g']) {
            await assert.rejects(() => mountColabServer(ref, alias, {}, f.deps), /serverAlias/);
        }
        assert.deepStrictEqual(f.events, []); assert.deepStrictEqual(state.calls, []); assert.strictEqual(f.checked, 0);
    });
    for (const [name, active, code] of [
        ['missing', undefined, 'active_kernel_required'],
        ['busy', { language: 'python', status: 'busy', executeCode() {} }, 'kernel_busy'],
        ['wrong language', { language: 'julia', status: 'idle', executeCode() {} }, 'kernel_language_unsupported'],
        ['missing public execution', { language: 'python', status: 'idle' }, 'jupyter_api_unavailable']
    ] as const) await test('mount recovery rejects ' + name + ' active kernel before UI', async () => {
        const f = fixture(); state.active = active;
        const r = JSON.parse(await mountColabServer(ref, 'm0123abcd', { waitMs: 1000 }, f.deps));
        assert.strictEqual(r.code, code); assert.strictEqual(r.ready, false); assert.deepStrictEqual(f.events, []);
        assert.ok(!state.calls.some((call: any) => ['notebook.selectKernel', 'notebook.cell.execute', 'colab.mountServer'].includes(call[0])));
    });
    await test('mount recovery selects only the exact alias and performs no kernel or cell action', async () => {
        const f = fixture({ productionBind: true }); state.active = { language: 'python', status: 'idle', executeCode() {} };
        state.folders.push({ name: 'stale', uri: uri('colab://stale-server/content') });
        const before = state.notebook.getCells().map((cell: any) => cell.document.getText());
        const r = JSON.parse(await mountColabServer(ref, 'm0123abcd', { waitMs: 1000 }, f.deps));
        assert.strictEqual(r.ready, true); assert.strictEqual(r.operation, 'mount_colab_server'); assert.strictEqual(r.serverAlias, 'm0123abcd');
        assert.deepStrictEqual(f.events, ['lease', 'bind', 'm0123abcd', 'dispose']);
        assert.strictEqual(f.nativeBinds, 2, 'mount marker must pass production native bind validation and its ownership recheck');
        assert.deepStrictEqual(f.checkedRoots, ['colab://test-server/']); assert.strictEqual(f.released, 1);
        assert.deepStrictEqual(state.notebook.getCells().map((cell: any) => cell.document.getText()), before);
        assert.deepStrictEqual(state.calls.map((call: any) => call[0]), ['colab.mountServer', 'workbench.action.closeQuickOpen']);
    });
    await test('mount recovery verifies one existing alias-named Colab workspace without UI', async () => {
        const f = fixture(); state.active = { language: 'python', status: 'idle', executeCode() {} };
        state.folders.push({ name: 'm0123abcd', uri: uri('colab://existing-server/content') });
        const r = JSON.parse(await mountColabServer(ref, 'm0123abcd', { waitMs: 1000 }, f.deps));
        assert.strictEqual(r.ready, true); assert.deepStrictEqual(f.checkedRoots, ['colab://existing-server/']);
        assert.deepStrictEqual(f.events, []); assert.deepStrictEqual(state.calls, []); assert.strictEqual(f.released, 0);
    });
    await test('mount recovery rejects ambiguous existing alias mounts before verification or UI', async () => {
        const f = fixture(); state.active = { language: 'python', status: 'idle', executeCode() {} };
        state.folders.push({ name: 'm0123abcd', uri: uri('colab://one/content') }, { name: 'm0123abcd', uri: uri('colab://two/content') });
        const r = JSON.parse(await mountColabServer(ref, 'm0123abcd', { waitMs: 1000 }, f.deps));
        assert.strictEqual(r.code, 'filesystem_ambiguous'); assert.strictEqual(f.checked, 0);
        assert.deepStrictEqual(f.events, []); assert.deepStrictEqual(state.calls, []);
    });
    await test('mount recovery never claims readiness when fresh verification is negative', async () => {
        const f = fixture({ checkFalse: true }); state.active = { language: 'python', status: 'idle', executeCode() {} };
        const r = JSON.parse(await mountColabServer(ref, 'm0123abcd', { waitMs: 1000 }, f.deps));
        assert.strictEqual(r.code, 'verification_failed'); assert.strictEqual(r.ready, false); assert.strictEqual(f.checked, 1);
    });
    await test('cancelled mount command retains the desktop lease until the command settles', async () => {
        const f = fixture(); state.active = { language: 'python', status: 'idle', executeCode() {} }; state.mountCommandHang = true;
        const initial = JSON.parse(await mountColabServer(ref, 'm0123abcd', { waitMs: 0 }, f.deps));
        while (!f.events.includes('m0123abcd')) await new Promise((resolve) => setTimeout(resolve, 1));
        const cancelled = JSON.parse(await getColabSetup(ref, initial.setupId, 1000, true));
        assert.strictEqual(cancelled.status, 'cancelled'); assert.strictEqual(cancelled.cleanupPending, true); assert.strictEqual(f.released, 0);
        assert.throws(() => assertNoColabSetup(ref), /still active/);
        state.finishMountCommand(); await new Promise((resolve) => setTimeout(resolve, 5));
        assert.strictEqual(f.released, 1); assertNoColabSetup(ref);
    });
    await test('cancelled mount verification retains its guard and lease until verification settles', async () => {
        const f = fixture(); state.active = { language: 'python', status: 'idle', executeCode() {} };
        let finishCheck!: (value: string) => void;
        f.deps.check = () => new Promise<string>((resolve) => { finishCheck = resolve; });
        const initial = JSON.parse(await mountColabServer(ref, 'm0123abcd', { waitMs: 0 }, f.deps));
        while (!f.events.includes('m0123abcd')) await new Promise((resolve) => setTimeout(resolve, 1));
        while (JSON.parse(await getColabSetup(ref, initial.setupId)).stage !== 'verifying_runtime') await new Promise((resolve) => setTimeout(resolve, 1));
        const cancelled = JSON.parse(await getColabSetup(ref, initial.setupId, 1000, true));
        assert.strictEqual(cancelled.status, 'cancelled'); assert.strictEqual(cancelled.cleanupPending, true); assert.strictEqual(f.released, 0);
        finishCheck(JSON.stringify({ verified: true })); await new Promise((resolve) => setTimeout(resolve, 5));
        assert.strictEqual(f.released, 1); assertNoColabSetup(ref);
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
