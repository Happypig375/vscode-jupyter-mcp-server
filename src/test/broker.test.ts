import * as assert from 'assert';
import * as http from 'http';
import { aggregateColabEnvironmentPreflight, BrokerCoordinator } from '../broker';
import { LocalOperation } from '../localOperations';
import { notebookRefFor } from '../notebookRefs';

interface Invocation {
    operation: LocalOperation;
    args: Record<string, unknown>;
}

const IDS = {
    a: '00000000-0000-4000-8000-000000000001',
    b: '00000000-0000-4000-8000-000000000002',
    c: '00000000-0000-4000-8000-000000000003',
    d: '00000000-0000-4000-8000-000000000004',
    e: '00000000-0000-4000-8000-000000000005'
} as const;
const NAMES = new Map<string, string>([[IDS.a, 'window-a'], [IDS.b, 'window-b'], [IDS.c, 'window-c'], [IDS.d, 'window-d']]);

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') return reject(new Error('No test port.'));
            server.close(() => resolve(address.port));
        });
    });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(message);
}

function localPreflight(windowId: string, options: { native?: boolean; actualWindowCount?: number; blockers?: string[]; pid?: number; version?: string; schemaVersion?: number } = {}): string {
    const native = options.native ?? windowId === IDS.d;
    const name = NAMES.get(windowId) ?? windowId;
    return JSON.stringify({
        schemaVersion: options.schemaVersion ?? 1, observedAt: 1_800_000_000_000, readOnly: true,
        nativeBinding: {
            source: native ? 'launch_environment' : 'none', port: native ? 59267 : null,
            listenerAvailable: native, workbenchPageCount: native ? 4 : null,
            exactWindowBinding: 'not-established', correspondenceReason: 'debug-targets-do-not-expose-vscode-peer-window-ids',
            peerSecret: 'must-not-cross-boundary'
        },
        window: {
            localHost: true, trusted: true,
            workspace: { kind: name === 'window-d' ? 'empty' : 'workspace', folderCount: name === 'window-d' ? 0 : 1 },
            notebooks: { total: 0, fileBacked: 0, untitled: 0, dirty: 0, visibleEditors: 0, activeEditor: false },
            textDocuments: { total: 0, fileBacked: 0, untitled: 0, dirty: 0, blocking: 0, visibleEditors: 0, activeEditor: false },
            tabs: { total: 0, dirty: 0, benignWelcomeOnly: false }, terminals: { total: 0 }, debugging: { active: false },
            quitPolicy: { confirmBeforeClose: 'never', restoreWindows: 'all' }
        },
        application: {
            status: 'verified', version: options.version ?? '1.142.0', supportedVersion: '1.142.0', versionSupported: true,
            commit: '6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1', mainProcessPid: options.pid ?? 1234,
            mainProcessIdentity: 'verified', defaultInstall: 'verified', startupArguments: 'supported',
            actualWindowCount: options.actualWindowCount ?? 4, failureCode: null
        },
        blockers: options.blockers ?? (native ? [] : ['native_binding_unavailable', 'automatic_restart_workspace_present']),
        peerSecret: 'must-not-cross-boundary'
    });
}

function aggregated(inputs: Array<{ windowId: string; text?: string }>): any {
    return JSON.parse(aggregateColabEnvironmentPreflight(inputs, 1_800_000_000_001));
}

function testPreflightAggregationBoundaries(): void {
    const native = aggregated([{ windowId: IDS.d, text: localPreflight(IDS.d, { actualWindowCount: 1, native: true, blockers: [] }) }]);
    assert.strictEqual(native.supportedNextOperation.status, 'available');
    assert.deepStrictEqual(native.supportedNextOperation.candidateWindowIds, [IDS.d]);
    assert.ok(!native.blockers.includes('peer_window_correspondence_not_exposed'));
    assert.ok(native.limitations.some((value: string) => value.includes('correspondence')));

    const restart = aggregated([{ windowId: IDS.d, text: localPreflight(IDS.d, { actualWindowCount: 1, native: false, blockers: ['native_binding_unavailable'] }) }]);
    assert.strictEqual(restart.supportedNextOperation.status, 'available');
    assert.strictEqual(restart.supportedNextOperation.reasonCode, 'single_empty_window_candidate_requires_prepare_revalidation');

    const stale = aggregated([
        { windowId: IDS.d, text: localPreflight(IDS.d, { actualWindowCount: 1, native: false, blockers: ['native_binding_unavailable'] }) },
        { windowId: IDS.b }
    ]);
    assert.strictEqual(stale.supportedNextOperation.status, 'blocked');
    assert.ok(stale.blockers.includes('peer_preflight_unavailable'));
    assert.ok(stale.blockers.includes('connected_peer_count_differs_from_app_window_count'));

    const nativeBlocked = aggregated([{ windowId: IDS.d, text: localPreflight(IDS.d, { actualWindowCount: 1, native: true, blockers: ['terminal_present'] }) }]);
    assert.strictEqual(nativeBlocked.supportedNextOperation.status, 'blocked');

    const nativeMultiWindow = aggregated([
        { windowId: IDS.c, text: localPreflight(IDS.c, { actualWindowCount: 2, native: true, blockers: [] }) },
        { windowId: IDS.d, text: localPreflight(IDS.d, { actualWindowCount: 2, native: true, blockers: [] }) }
    ]);
    assert.strictEqual(nativeMultiWindow.supportedNextOperation.status, 'blocked');
    assert.ok(nativeMultiWindow.blockers.includes('multiple_app_windows'));

    const inconsistent = aggregated([
        { windowId: IDS.c, text: localPreflight(IDS.c, { actualWindowCount: 2, native: true, blockers: [], pid: 1234 }) },
        { windowId: IDS.d, text: localPreflight(IDS.d, { actualWindowCount: 2, native: true, blockers: [], pid: 5678 }) }
    ]);
    assert.strictEqual(inconsistent.application.corroboration, 'inconsistent');
    assert.strictEqual(inconsistent.supportedNextOperation.status, 'blocked');

    const countMismatch = aggregated([{ windowId: IDS.d, text: localPreflight(IDS.d, { actualWindowCount: 2, native: true, blockers: [] }) }]);
    assert.strictEqual(countMismatch.supportedNextOperation.status, 'blocked');
    assert.ok(countMismatch.blockers.includes('connected_peer_count_differs_from_app_window_count'));

    for (const text of [
        '{',
        'x'.repeat(65 * 1024),
        localPreflight(IDS.d, { schemaVersion: 2 }),
        localPreflight(IDS.d, { version: '1.142.0 private' })
    ]) {
        const invalid = aggregated([{ windowId: IDS.d, text }]);
        assert.strictEqual(invalid.respondingPeerCount, 0);
        assert.strictEqual(invalid.supportedNextOperation.status, 'blocked');
        assert.ok(invalid.blockers.includes('peer_preflight_unavailable'));
    }

    const invalidId = aggregated([{ windowId: 'attacker-controlled-id', text: localPreflight(IDS.d) }]);
    assert.strictEqual(invalidId.invalidPeerIdCount, 1);
    assert.deepStrictEqual(invalidId.unavailablePeerIds, []);
    assert.ok(invalidId.blockers.includes('invalid_peer_registration'));
    assert.ok(!JSON.stringify(invalidId).includes('attacker-controlled-id'));
    assert.strictEqual(invalidId.supportedNextOperation.status, 'blocked');
}

async function testSelfPreflightTimeout(): Promise<void> {
    const port = await freePort();
    const longLabel = '😀'.repeat(300);
    const coordinator = new BrokerCoordinator({
        port, id: IDS.a, label: longLabel, heartbeatMs: 50, staleMs: 300, preflightTimeoutMs: 25,
        listLocalNotebooks: () => [],
        invokeLocal: async operation => operation === 'inspect_colab_environment_preflight'
            ? new Promise<string>(() => undefined) : 'unused',
        handleMcpRequest: async (_req, res) => { res.writeHead(501); res.end(); }
    });
    try {
        assert.strictEqual(Array.from(coordinator.windowLabel).length, 256);
        assert.ok(coordinator.windowLabel.endsWith('…'));
        await coordinator.start();
        const started = Date.now();
        const result = JSON.parse(await coordinator.inspectColabEnvironmentPreflight());
        assert.ok(Date.now() - started < 1000, 'self preflight must use the bounded deadline');
        assert.strictEqual(result.respondingPeerCount, 0);
        assert.deepStrictEqual(result.unavailablePeerIds, [IDS.a]);
        assert.ok(result.blockers.includes('peer_preflight_unavailable'));
        assert.strictEqual(result.supportedNextOperation.status, 'blocked');
    } finally { await coordinator.stop(); }
}

async function testRemotePreflightTimeout(): Promise<void> {
    const port = await freePort();
    const common = {
        port, heartbeatMs: 50, staleMs: 500, preflightTimeoutMs: 25,
        listLocalNotebooks: () => [],
        handleMcpRequest: async (_req: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(501); res.end(); }
    };
    const broker = new BrokerCoordinator({
        ...common, id: IDS.a, label: 'Responsive window',
        invokeLocal: async operation => operation === 'inspect_colab_environment_preflight'
            ? localPreflight(IDS.a, { actualWindowCount: 2, native: false, blockers: ['native_binding_unavailable'] }) : 'unused'
    });
    const peer = new BrokerCoordinator({
        ...common, id: IDS.b, label: 'Stalled window',
        invokeLocal: async operation => operation === 'inspect_colab_environment_preflight'
            ? new Promise<string>(() => undefined) : 'unused'
    });
    try {
        await broker.start();
        await peer.start();
        await waitFor(() => broker.isBroker && peer.role === 'peer', 'Remote timeout peer did not register.');
        const started = Date.now();
        const result = JSON.parse(await broker.inspectColabEnvironmentPreflight());
        assert.ok(Date.now() - started < 1000, 'remote preflight must use the bounded deadline');
        assert.strictEqual(result.connectedPeerCount, 2);
        assert.strictEqual(result.respondingPeerCount, 1);
        assert.deepStrictEqual(result.unavailablePeerIds, [IDS.b]);
        assert.ok(result.blockers.includes('peer_preflight_unavailable'));
        assert.strictEqual(result.supportedNextOperation.status, 'blocked');
    } finally { await peer.stop(); await broker.stop(); }
}

async function main(): Promise<void> {
    testPreflightAggregationBoundaries();
    await testSelfPreflightTimeout();
    await testRemotePreflightTimeout();
    const port = await freePort();
    let rejectedPreflightId: string | undefined;
    const shared = 'file:///C:/shared.ipynb';
    const notebooks = new Map<string, string[]>([
        [IDS.a, [shared, 'file:///C:/a.ipynb']],
        [IDS.b, [shared, 'file:///C:/b.ipynb']],
        [IDS.c, ['file:///C:/c.ipynb']],
        [IDS.d, []]
    ]);
    const invocations = new Map<string, Invocation[]>([...notebooks.keys()].map((id) => [id, []]));

    const coordinators = [...notebooks.entries()].map(([id, uris]) => new BrokerCoordinator({
        port,
        id,
        label: NAMES.get(id)!,
        heartbeatMs: 50,
        staleMs: 300,
        listLocalNotebooks: () => uris,
        invokeLocal: async (operation, args) => {
            invocations.get(id)!.push({ operation, args });
            if (operation === 'inspect_colab_environment_preflight' && id === rejectedPreflightId) throw new Error('bounded test rejection');
            if (operation === 'inspect_colab_environment_preflight') return localPreflight(id);
            if (id === IDS.b && operation === 'get_execution' && args.waitMs === 3_600_000) {
                await new Promise((resolve) => setTimeout(resolve, 1_650));
            }
            return `${NAMES.get(id)}:${operation}`;
        },
        handleMcpRequest: async (_req, res) => {
            res.writeHead(501);
            res.end();
        }
    }));

    try {
        await Promise.all(coordinators.map((coordinator) => coordinator.start()));
        await waitFor(
            () => coordinators.filter((coordinator) => coordinator.isBroker).length === 1 && coordinators.every((coordinator) => coordinator.role === 'broker' || coordinator.role === 'peer'),
            'One broker and two peers were not elected.'
        );

        const originalBroker = coordinators.find((coordinator) => coordinator.isBroker)!;
        assert.strictEqual(originalBroker.url, `http://127.0.0.1:${port}/mcp`);
        const invalidRegistration = await fetch(`http://127.0.0.1:${port}/broker/register`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 'not-a-uuid', label: 'untrusted', peerPort: 12345, token: '0'.repeat(48) })
        });
        assert.strictEqual(invalidRegistration.status, 400);
        const longToken = '1'.repeat(48), longLabel = '😀'.repeat(300), longPeerPort = await freePort();
        const longRegistration = await fetch(`http://127.0.0.1:${port}/broker/register`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: IDS.e, label: longLabel, peerPort: longPeerPort, token: longToken })
        });
        assert.strictEqual(longRegistration.status, 200);
        const longGroup = (await originalBroker.listNotebooks()).find(group => group.windowId === IDS.e)!;
        assert.ok(longGroup, 'long-label peer must remain registered');
        assert.strictEqual(Array.from(longGroup.windowLabel).length, 256);
        assert.ok(longGroup.windowLabel.endsWith('…'));
        assert.ok(!longGroup.windowLabel.includes('\ufffd'), 'truncation must not split a Unicode surrogate pair');
        const longUnregister = await fetch(`http://127.0.0.1:${port}/broker/unregister`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: IDS.e, token: longToken })
        });
        assert.strictEqual(longUnregister.status, 200);
        await waitFor(async () => (await originalBroker.listNotebooks()).reduce((n, group) => n + group.notebooks.length, 0) === 5, 'Broker did not aggregate all windows.');

        const listed = await originalBroker.listNotebooks();
        assert.strictEqual(listed.length, 4);
        assert.ok(listed.some((group) => group.windowId === IDS.d && group.notebooks.length === 0));
        assert.strictEqual(await originalBroker.invokeWindow('list_colab_terminals', {}, IDS.d), 'window-d:list_colab_terminals');
        assert.strictEqual(await originalBroker.invokeWindow('close_colab_terminals', { inventoryId: 'inventory', terminalRefs: ['terminal'] }, IDS.d), 'window-d:close_colab_terminals');
        assert.strictEqual(await originalBroker.invokeWindow('prepare_colab_environment', { folderUri: 'file:///project' }, IDS.d), 'window-d:prepare_colab_environment');
        assert.strictEqual(await originalBroker.invokeWindow('get_colab_environment_preparation', { preparationId: 'receipt' }, IDS.d), 'window-d:get_colab_environment_preparation');
        assert.deepStrictEqual(invocations.get(IDS.d)!.splice(0), [
            { operation: 'list_colab_terminals', args: {} },
            { operation: 'close_colab_terminals', args: { inventoryId: 'inventory', terminalRefs: ['terminal'] } },
            { operation: 'prepare_colab_environment', args: { folderUri: 'file:///project' } },
            { operation: 'get_colab_environment_preparation', args: { preparationId: 'receipt' } }
        ]);

        for (const calls of invocations.values()) calls.length = 0;
        const preflight = JSON.parse(await originalBroker.inspectColabEnvironmentPreflight());
        assert.strictEqual(preflight.readOnly, true);
        assert.strictEqual(preflight.connectedPeerCount, 4);
        assert.strictEqual(preflight.respondingPeerCount, 4);
        assert.strictEqual(preflight.application.corroboration, 'consistent');
        assert.strictEqual(preflight.application.actualWindowCount, 4);
        assert.strictEqual(preflight.appWindowCountMatchesConnectedPeerCount, true);
        assert.strictEqual(preflight.supportedNextOperation.status, 'blocked');
        assert.deepStrictEqual(preflight.supportedNextOperation.candidateWindowIds, []);
        assert.strictEqual(preflight.peerWindowCorrespondence.availability, 'not-exposed');
        assert.strictEqual(preflight.peerWindowCorrespondence.countEqualityDoesNotEstablishMapping, true);
        assert.ok(!preflight.blockers.includes('peer_window_correspondence_not_exposed'));
        assert.ok(preflight.blockers.includes('multiple_app_windows'));
        assert.ok(!JSON.stringify(preflight).includes('must-not-cross-boundary'));
        for (const calls of invocations.values()) assert.deepStrictEqual(calls, [{ operation: 'inspect_colab_environment_preflight', args: {} }]);

        rejectedPreflightId = IDS.c;
        const rejected = JSON.parse(await originalBroker.inspectColabEnvironmentPreflight());
        rejectedPreflightId = undefined;
        assert.deepStrictEqual(rejected.unavailablePeerIds, [IDS.c]);
        assert.strictEqual(rejected.supportedNextOperation.status, 'blocked');
        assert.ok(rejected.blockers.includes('peer_preflight_unavailable'));

        const duplicates = listed.flatMap((group) => group.notebooks.map((notebook) => ({ ...notebook, windowId: group.windowId }))).filter((notebook) => notebook.uri === shared);
        assert.strictEqual(duplicates.length, 2);
        assert.match(duplicates[0].notebookRef, /^nb_[0-9a-f]{24}$/);
        assert.notStrictEqual(duplicates[0].notebookRef, duplicates[1].notebookRef);
        assert.strictEqual(duplicates.find((notebook) => notebook.windowId === IDS.a)!.notebookRef, notebookRefFor(IDS.a, shared));

        await assert.rejects(
            () => originalBroker.invokeNotebook('read_notebook', shared, {}),
            /open in 2 VS Code windows.*notebookRef/s
        );
        const routed = duplicates.find((notebook) => notebook.windowId === IDS.b)!;
        assert.strictEqual(
            await originalBroker.invokeNotebook('read_notebook', routed.notebookRef, {}),
            'window-b:read_notebook'
        );
        assert.strictEqual(invocations.get(IDS.b)!.at(-1)!.args.notebookRef, shared);

        const longWaitStarted = Date.now();
        assert.strictEqual(
            await originalBroker.invokeNotebook('get_execution', routed.notebookRef, { waitMs: 3_600_000 }),
            'window-b:get_execution'
        );
        assert.ok(Date.now() - longWaitStarted >= 1_500, 'operation RPC must outlive the short control-plane deadline');

        assert.strictEqual(
            await originalBroker.invokeNotebook('mount_colab_server', routed.notebookRef, { serverAlias: 'm0123abcd', waitMs: 60_000 }),
            'window-b:mount_colab_server'
        );
        assert.deepStrictEqual(invocations.get(IDS.b)!.at(-1), {
            operation: 'mount_colab_server',
            args: { notebookRef: shared, serverAlias: 'm0123abcd', waitMs: 60_000 }
        });

        for (const calls of invocations.values()) calls.length = 0;
        await originalBroker.invokeNotebooks('save_notebooks', [
            'file:///C:/a.ipynb',
            'file:///C:/b.ipynb',
            routed.notebookRef
        ]);
        assert.deepStrictEqual(invocations.get(IDS.a), [{
            operation: 'save_notebooks',
            args: { notebookRefs: ['file:///C:/a.ipynb'] }
        }]);
        assert.deepStrictEqual(invocations.get(IDS.b), [{
            operation: 'save_notebooks',
            args: { notebookRefs: ['file:///C:/b.ipynb', shared] }
        }]);

        await assert.rejects(() => originalBroker.invokeNotebook('read_notebook', 'nb_000000000000000000000000', {}), /unknown, stale, or collides/);
        await assert.rejects(() => originalBroker.invokeNotebook('read_notebook', 'nb_bad', {}), /Malformed notebook reference/);
        await coordinators.find((coordinator) => coordinator.windowId === IDS.b)!.stop();
        await waitFor(async () => (await originalBroker.listNotebooks()).every((group) => group.windowId !== IDS.b), 'Disconnected window was not pruned.');
        await assert.rejects(() => originalBroker.invokeNotebook('read_notebook', routed.notebookRef, {}), /unknown, stale, or collides|disconnected/);

        const originalOwnerId = originalBroker.windowId;
        await originalBroker.stop();
        const survivors = coordinators.filter((coordinator) => coordinator !== originalBroker && coordinator.windowId !== IDS.b);
        const expectedSurvivingNotebookCount = survivors.reduce(
            (count, coordinator) => count + notebooks.get(coordinator.windowId)!.length,
            0
        );
        await waitFor(
            () => survivors.filter((coordinator) => coordinator.isBroker).length === 1 && survivors.every((coordinator) => coordinator.role === 'broker' || coordinator.role === 'peer'),
            'A surviving window did not take over the broker port.'
        );
        const replacement = survivors.find((coordinator) => coordinator.isBroker)!;
        assert.strictEqual(replacement.url, `http://127.0.0.1:${port}/mcp`);
        assert.notStrictEqual(replacement.windowId, originalOwnerId);
        await waitFor(
            async () => (await replacement.listNotebooks()).reduce((n, group) => n + group.notebooks.length, 0) === expectedSurvivingNotebookCount,
            'Replacement broker did not aggregate surviving windows.'
        );

        const health = await fetch(`http://127.0.0.1:${port}/broker/health`).then((response) => response.json()) as { ownerId: string };
        assert.strictEqual(health.ownerId, replacement.windowId);
        console.log('  ✓ broker aggregates windows and reports duplicate notebook conflicts');
        console.log('  ✓ notebookRef routes to the selected window and batches multi-window operations');
        console.log('  ✓ a surviving window takes over the same external port after broker shutdown');
    } finally {
        await Promise.all(coordinators.map((coordinator) => coordinator.stop()));
    }
}

main().catch((error) => { console.error(error); process.exit(1); });
