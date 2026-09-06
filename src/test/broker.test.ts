import * as assert from 'assert';
import * as http from 'http';
import { BrokerCoordinator } from '../broker';
import { LocalOperation } from '../localOperations';
import { notebookRefFor } from '../notebookRefs';

interface Invocation {
    operation: LocalOperation;
    args: Record<string, unknown>;
}

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

async function main(): Promise<void> {
    const port = await freePort();
    const shared = 'file:///C:/shared.ipynb';
    const notebooks = new Map<string, string[]>([
        ['window-a', [shared, 'file:///C:/a.ipynb']],
        ['window-b', [shared, 'file:///C:/b.ipynb']],
        ['window-c', ['file:///C:/c.ipynb']],
        ['window-d', []]
    ]);
    const invocations = new Map<string, Invocation[]>([...notebooks.keys()].map((id) => [id, []]));

    const coordinators = [...notebooks.entries()].map(([id, uris]) => new BrokerCoordinator({
        port,
        id,
        label: id.replace('window-', 'Window ').toUpperCase(),
        heartbeatMs: 50,
        staleMs: 300,
        listLocalNotebooks: () => uris,
        invokeLocal: async (operation, args) => {
            invocations.get(id)!.push({ operation, args });
            if (id === 'window-b' && operation === 'get_execution' && args.waitMs === 3_600_000) {
                await new Promise((resolve) => setTimeout(resolve, 1_650));
            }
            return `${id}:${operation}`;
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
        await waitFor(async () => (await originalBroker.listNotebooks()).reduce((n, group) => n + group.notebooks.length, 0) === 5, 'Broker did not aggregate all windows.');

        const listed = await originalBroker.listNotebooks();
        assert.strictEqual(listed.length, 4);
        assert.ok(listed.some((group) => group.windowId === 'window-d' && group.notebooks.length === 0));
        const duplicates = listed.flatMap((group) => group.notebooks.map((notebook) => ({ ...notebook, windowId: group.windowId }))).filter((notebook) => notebook.uri === shared);
        assert.strictEqual(duplicates.length, 2);
        assert.match(duplicates[0].notebookRef, /^nb_[0-9a-f]{24}$/);
        assert.notStrictEqual(duplicates[0].notebookRef, duplicates[1].notebookRef);
        assert.strictEqual(duplicates.find((notebook) => notebook.windowId === 'window-a')!.notebookRef, notebookRefFor('window-a', shared));

        await assert.rejects(
            () => originalBroker.invokeNotebook('read_notebook', shared, {}),
            /open in 2 VS Code windows.*notebookRef/s
        );
        const routed = duplicates.find((notebook) => notebook.windowId === 'window-b')!;
        assert.strictEqual(
            await originalBroker.invokeNotebook('read_notebook', routed.notebookRef, {}),
            'window-b:read_notebook'
        );
        assert.strictEqual(invocations.get('window-b')!.at(-1)!.args.notebookRef, shared);

        const longWaitStarted = Date.now();
        assert.strictEqual(
            await originalBroker.invokeNotebook('get_execution', routed.notebookRef, { waitMs: 3_600_000 }),
            'window-b:get_execution'
        );
        assert.ok(Date.now() - longWaitStarted >= 1_500, 'operation RPC must outlive the short control-plane deadline');

        for (const calls of invocations.values()) calls.length = 0;
        await originalBroker.invokeNotebooks('save_notebooks', [
            'file:///C:/a.ipynb',
            'file:///C:/b.ipynb',
            routed.notebookRef
        ]);
        assert.deepStrictEqual(invocations.get('window-a'), [{
            operation: 'save_notebooks',
            args: { notebookRefs: ['file:///C:/a.ipynb'] }
        }]);
        assert.deepStrictEqual(invocations.get('window-b'), [{
            operation: 'save_notebooks',
            args: { notebookRefs: ['file:///C:/b.ipynb', shared] }
        }]);

        await assert.rejects(() => originalBroker.invokeNotebook('read_notebook', 'nb_000000000000000000000000', {}), /unknown, stale, or collides/);
        await assert.rejects(() => originalBroker.invokeNotebook('read_notebook', 'nb_bad', {}), /Malformed notebook reference/);
        await coordinators.find((coordinator) => coordinator.windowId === 'window-b')!.stop();
        await waitFor(async () => (await originalBroker.listNotebooks()).every((group) => group.windowId !== 'window-b'), 'Disconnected window was not pruned.');
        await assert.rejects(() => originalBroker.invokeNotebook('read_notebook', routed.notebookRef, {}), /unknown, stale, or collides|disconnected/);

        const originalOwnerId = originalBroker.windowId;
        await originalBroker.stop();
        const survivors = coordinators.filter((coordinator) => coordinator !== originalBroker && coordinator.windowId !== 'window-b');
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
