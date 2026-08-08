// Tests for the Jupyter-present path: run_cells (output-capturing), read_notebook,
// export_notebook, and cell-id anchors. Loads the bundle with a shim that HAS the
// Jupyter extension and simulates cell execution completion.
'use strict';
const path = require('path');
const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 51305;

// ---- vscode shim: Jupyter present, one open file notebook ----
const lines = [];
const statusBar = { text: '', tooltip: '', command: '', show() {}, dispose() {} };
const disposables = [];
const interrupted = [];
const openNotebooks = [];

function makeDoc(uri) {
    const cells = [
        { kind: 2, value: 'print("hello")', languageId: 'python', metadata: { id: 'cell-abc' } },
        { kind: 1, value: '# Title', languageId: 'markdown', metadata: {} }
    ];
    const doc = {
        notebookType: 'jupyter-notebook',
        uri: { fsPath: 'C:/nb.ipynb', toString: () => uri },
        isDirty: false, isUntitled: false,
        get cellCount() { return cells.length; },
        cellAt: (i) => {
            const c = cells[i];
            return {
                kind: c.kind,
                document: { uri: { fragment: `c${i}` }, languageId: c.languageId, getText: () => c.value },
                outputs: c.outputs || [],
                executionSummary: c.executionSummary,
                metadata: c.metadata || {}
            };
        },
        getCells: () => cells.map((c, i) => ({
            kind: c.kind,
            document: { uri: { fragment: `c${i}` }, languageId: c.languageId, getText: () => c.value },
            outputs: c.outputs || [],
            executionSummary: c.executionSummary,
            metadata: c.metadata || {}
        })),
        save: async () => true,
        _cells: cells
    };
    openNotebooks.push(doc);
    return doc;
}
makeDoc('file:///C:/nb.ipynb');

const vscodeShim = {
    workspace: {
        getConfiguration: () => ({ get: (k, d) => {
            if (k === 'transport') return 'http';
            if (k === 'port') return PORT;
            if (k === 'enabled') return true;
            if (k === 'saveBeforeExecute') return true;
            return d;
        }}),
        workspaceFolders: undefined,
        notebookDocuments: openNotebooks,
        fs: { writeFile: async () => {} },
        applyEdit: async () => true,
        onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: {
        createOutputChannel: () => ({ appendLine: (l) => { lines.push(l); console.log('[OUT]', l); }, dispose() {} }),
        createStatusBarItem: () => statusBar
    },
    extensions: { getExtension: () => ({ id: 'ms-toolsai.jupyter', isActive: true, activate: async () => ({ getKernel: () => ({ label: 'Python 3.12.2' }) }) }), onDidChange: () => ({ dispose() {} }) },
    commands: {
        registerCommand: () => ({ dispose() {} }),
        executeCommand: async (cmd, uri, cellUris) => {
            if (cmd === 'notebook.execute' && cellUris) {
                // Simulate execution completing: find the cell by URI fragment, mark success + add output.
                for (const cu of cellUris) {
                    const frag = cu.fragment || '';
                    const idx = Number(frag.replace('c', ''));
                    const nb = openNotebooks[0];
                    const cell = nb._cells[idx];
                    cell.executionSummary = { success: true, executionOrder: 1, timing: { startTime: Date.now() - 50, endTime: Date.now() } };
                    cell.outputs = [{ items: [{ mime: 'text/plain', data: Buffer.from('hello\n') }] }];
                }
            }
            if (cmd === 'notebook.clearOutputs' && cellUris) {
                for (const cu of cellUris) {
                    const frag = cu.fragment || '';
                    const idx = Number(frag.replace('c', ''));
                    const nb = openNotebooks[0];
                    const cell = nb._cells[idx];
                    cell.outputs = [];
                    cell.executionSummary = undefined;
                }
            }
            if (cmd === 'notebook.interruptKernel') interrupted.push(uri);
        }
    },
    env: { clipboard: { writeText: async () => {} } },
    StatusBarAlignment: { Right: 1 },
    WorkspaceEdit: class { constructor() { this._ops = []; } set(uri, edits) { this._ops.push([String(uri), edits]); } },
    NotebookEdit: {
        replaceCells(range, cells) { return { __kind: 'replace', range: [range.a, range.b], cells }; },
        insertCells(index, cells) { return { __kind: 'insert', index, cells }; },
        deleteCells(range) { return { __kind: 'delete', range: [range.a, range.b] }; },
        updateCellMetadata(idx, meta) { return { __kind: 'updateMeta', idx, meta }; }
    },
    NotebookCellData: class { constructor(kind, value, lang) { this.kind = kind; this.value = value; this.languageId = lang; } },
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookRange: class { constructor(a, b) { this.a = a; this.b = b; } },
    Uri: { joinPath: (base, name) => ({ toString: () => `file:///C:/repo/${name}`, fsPath: `C:/repo/${name}` }) }
};

const Module = require('module');
const stubFile = path.join(ROOT, '.vscode-test', 'vscode-shim-jupyter.cjs');
require('fs').mkdirSync(path.dirname(stubFile), { recursive: true });
require.cache[stubFile] = { id: stubFile, filename: stubFile, loaded: true, exports: vscodeShim };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
    if (request === 'vscode') return stubFile;
    return origResolve.call(this, request, parent, ...args);
};

const bundle = require(path.join(ROOT, 'dist', 'extension.js'));

async function waitForServer(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const client = new Client({ name: 'test-jupyter', version: '1.0' });
            const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
            await client.connect(transport);
            await client.listTools();
            return client;
        } catch {
            await new Promise((r) => setTimeout(r, 200));
        }
    }
    throw new Error('MCP server did not become reachable');
}

async function main() {
    const context = { subscriptions: { push: (d) => disposables.push(d) } };
    await bundle.activate(context);
    const client = await waitForServer();

    let passed = 0;
    const check = (name, fn) => fn().then(() => { passed++; console.log(`  ✓ ${name}`); }).catch((e) => { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; });

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    console.log(`Tools exposed (${names.length}): ${names.join(', ')}`);

    // 1. With Jupyter present, kernel tools ARE exposed.
    await check('kernel tools exposed when Jupyter present', async () => {
        assert.ok(names.includes('run_cells'), 'run_cells missing');
        assert.ok(names.includes('restart_notebooks'), 'restart_notebooks missing');
        assert.ok(names.includes('interrupt_kernels'), 'interrupt_kernels missing');
        for (const required of ['read_notebook', 'export_notebook', 'get_notebooks', 'get_cells', 'get_cells_source', 'get_cells_output', 'search_cells', 'clear_outputs', 'get_kernel_info', 'edit_cells', 'move_cells', 'create_notebook', 'open_notebooks', 'save_notebooks']) {
            assert.ok(names.includes(required), `missing ${required}`);
        }
    });

    // 2. run_cells waits and returns outputs.
    await check('run_cells returns captured outputs', async () => {
        const res = await client.callTool({ name: 'run_cells', arguments: { filePath: 'file:///C:/nb.ipynb', cellIds: [0], timeoutMs: 5000 } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /success/, 'expected success status');
        assert.match(res.content[0].text, /hello/, 'expected captured output text');
    });

    // 3. read_notebook returns whole notebook with anchors + source.
    await check('read_notebook reads whole notebook', async () => {
        const res = await client.callTool({ name: 'read_notebook', arguments: { filePath: 'file:///C:/nb.ipynb', includeOutputs: true } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /id:cell-abc/, 'expected cell id anchor');
        assert.match(res.content[0].text, /print\("hello"\)/, 'expected source');
        assert.match(res.content[0].text, /hello/, 'expected outputs');
    });

    // 4. Cell-id anchors resolve in get_cells_source.
    await check('get_cells_source resolves by cell id anchor', async () => {
        const res = await client.callTool({ name: 'get_cells_source', arguments: { filePath: 'file:///C:/nb.ipynb', cellIds: ['cell-abc'] } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /print\("hello"\)/);
    });

    // 5. export_notebook markdown.
    await check('export_notebook markdown', async () => {
        const res = await client.callTool({ name: 'export_notebook', arguments: { filePath: 'file:///C:/nb.ipynb', format: 'markdown' } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /```python/, 'expected python fence');
        assert.match(res.content[0].text, /# Title/, 'expected markdown cell');
    });

    // 6. export_notebook python.
    await check('export_notebook python', async () => {
        const res = await client.callTool({ name: 'export_notebook', arguments: { filePath: 'file:///C:/nb.ipynb', format: 'python' } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /# %%/, 'expected cell marker');
    });

    // 7. export_notebook rejects bad format.
    await check('export_notebook rejects bad format', async () => {
        const res = await client.callTool({ name: 'export_notebook', arguments: { filePath: 'file:///C:/nb.ipynb', format: 'bogus' } });
        assert.ok(res.isError);
    });

    // 8. get_kernel_info returns the active kernel label via the Jupyter API.
    await check('get_kernel_info returns active kernel', async () => {
        const res = await client.callTool({ name: 'get_kernel_info', arguments: { filePath: 'file:///C:/nb.ipynb' } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /Kernel: Python 3\.12\.2/);
    });

    // 9. clear_outputs after a run removes outputs + execution state.
    await check('clear_outputs clears after run', async () => {
        const res = await client.callTool({ name: 'clear_outputs', arguments: { filePath: 'file:///C:/nb.ipynb', cellIds: [0] } });
        assert.ok(!res.isError, JSON.stringify(res));
        const out = await client.callTool({ name: 'get_cells_output', arguments: { filePath: 'file:///C:/nb.ipynb', cellIds: [0] } });
        assert.match(out.content[0].text, /no saved output/);
    });

    // 10. interrupt_kernels stops running execution.
    await check('interrupt_kernels works', async () => {
        const res = await client.callTool({ name: 'interrupt_kernels', arguments: { filePaths: ['file:///C:/nb.ipynb'] } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /Interrupted kernel/);
        assert.strictEqual(interrupted.length, 1);
    });

    await client.close();
    await bundle.deactivate();
    console.log(`\n${passed} jupyter-present checks passed`);
    setTimeout(() => process.exit(process.exitCode || 0), 200);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
