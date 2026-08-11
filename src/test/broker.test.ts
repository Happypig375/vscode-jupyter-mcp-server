import * as assert from 'assert';
import * as http from 'http';
import { BrokerCoordinator } from '../broker';
import { LocalOperation } from '../localOperations';

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
        ['window-c', ['file:///C:/c.ipynb']]
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
        await waitFor(async () => (await originalBroker.listNotebooks()).length === 5, 'Broker did not aggregate all windows.');

        const listed = await originalBroker.listNotebooks();
        const duplicates = listed.filter((notebook) => notebook.uri === shared);
        assert.strictEqual(duplicates.length, 2);
        assert.notStrictEqual(duplicates[0].notebookId, duplicates[1].notebookId);

        await assert.rejects(
            () => originalBroker.invokeNotebook('read_notebook', shared, {}),
            /open in 2 VS Code windows.*notebookId/s
        );
        const routed = duplicates.find((notebook) => notebook.windowId === 'window-b')!;
        assert.strictEqual(
            await originalBroker.invokeNotebook('read_notebook', routed.notebookId, {}),
            'window-b:read_notebook'
        );
        assert.strictEqual(invocations.get('window-b')!.at(-1)!.args.filePath, shared);

        for (const calls of invocations.values()) calls.length = 0;
        await originalBroker.invokeNotebooks('save_notebooks', [
            'file:///C:/a.ipynb',
            'file:///C:/b.ipynb',
            routed.notebookId
        ]);
        assert.deepStrictEqual(invocations.get('window-a'), [{
            operation: 'save_notebooks',
            args: { filePaths: ['file:///C:/a.ipynb'] }
        }]);
        assert.deepStrictEqual(invocations.get('window-b'), [{
            operation: 'save_notebooks',
            args: { filePaths: ['file:///C:/b.ipynb', shared] }
        }]);

        const originalOwnerId = originalBroker.windowId;
        await originalBroker.stop();
        const survivors = coordinators.filter((coordinator) => coordinator !== originalBroker);
        await waitFor(
            () => survivors.filter((coordinator) => coordinator.isBroker).length === 1 && survivors.every((coordinator) => coordinator.role === 'broker' || coordinator.role === 'peer'),
            'A surviving window did not take over the broker port.'
        );
        const replacement = survivors.find((coordinator) => coordinator.isBroker)!;
        assert.strictEqual(replacement.url, `http://127.0.0.1:${port}/mcp`);
        assert.notStrictEqual(replacement.windowId, originalOwnerId);
        await waitFor(async () => (await replacement.listNotebooks()).length === 3, 'Replacement broker did not aggregate surviving windows.');

        const health = await fetch(`http://127.0.0.1:${port}/broker/health`).then((response) => response.json()) as { ownerId: string };
        assert.strictEqual(health.ownerId, replacement.windowId);
        console.log('  ✓ broker aggregates windows and reports duplicate notebook conflicts');
        console.log('  ✓ notebookId routes to the selected window and batches multi-window operations');
        console.log('  ✓ a surviving window takes over the same external port after broker shutdown');
    } finally {
        await Promise.all(coordinators.map((coordinator) => coordinator.stop()));
    }
}

main().catch((error) => { console.error(error); process.exit(1); });
