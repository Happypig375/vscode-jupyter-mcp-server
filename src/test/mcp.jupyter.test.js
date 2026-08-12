// Tests for the Jupyter-present path: run_cells (output-capturing), read_notebook,
// export_notebook, and cell-id anchors. Loads the bundle with a shim that HAS the
// Jupyter extension and simulates cell execution completion.
'use strict';
const path = require('path');
const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ROOT = path.resolve(__dirname, '..', '..');
let PORT = Number(process.env.MCP_TEST_PORT || 0);

// ---- vscode shim: Jupyter present, one open file notebook ----
const lines = [];
const statusBar = { text: '', tooltip: '', command: '', show() {}, dispose() {} };
const disposables = [];
const interrupted = [];
const selectedKernels = [];
const startedKernels = [];
const legacyKernelHints = [];
const openNotebooks = [];
let saveCalls = 0;
let executionMode = 'complete';
let exactSelectionAccepted = true;
let rejectLegacyKernelHint = false;
let configureAvailable = true;
let startupDetail = 'Kernel is idle and ready.';
const availableKernels = [
    { id: 'ms-toolsai.jupyter/python-312', label: 'Python 3.12.2', description: 'Local Python' }
];
const providerKernel = { id: 'ms-toolsai.jupyter/colab-runtime', label: 'Colab Runtime', detail: 'Google Colab' };

function makeDoc(uri) {
    const cells = [
        { kind: 2, value: 'print("hello")', languageId: 'python', metadata: { id: 'cell-abc' } },
        { kind: 1, value: '# Title', languageId: 'markdown', metadata: {} }
    ];
    const doc = {
        notebookType: 'jupyter-notebook',
        uri: { fsPath: 'C:/nb.ipynb', toString: () => uri },
        metadata: { kernelspec: { name: 'python3' } },
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
        save: async () => { saveCalls++; return true; },
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
        createStatusBarItem: () => statusBar,
        showNotebookDocument: async () => ({})
    },
    extensions: { getExtension: () => ({ id: 'ms-toolsai.jupyter', isActive: true, activate: async () => ({ getKernel: () => ({ label: 'Python 3.12.2' }) }) }), onDidChange: () => ({ dispose() {} }) },
    commands: {
        registerCommand: () => ({ dispose() {} }),
        executeCommand: async (cmd, uri, cellUris) => {
            if (cmd === '_resolveNotebookKernels') return availableKernels;
            if (cmd === '_notebook.selectKernel') {
                if (!exactSelectionAccepted) return false;
                selectedKernels.push(`${uri.extension}/${uri.id}`);
                return true;
            }
            if (cmd === 'notebook.selectKernel') {
                legacyKernelHints.push(uri.kernelInfo.label);
                if (rejectLegacyKernelHint) throw new Error('legacy selection failed');
                return;
            }
            if (cmd === 'notebook.execute' && cellUris) {
                if (executionMode === 'hang') return;
                // Simulate execution completing: find the cell by URI fragment, mark success + add output.
                for (const cu of cellUris) {
                    const frag = cu.fragment || '';
                    const idx = Number(frag.replace('c', ''));
                    const nb = openNotebooks[0];
                    const cell = nb._cells[idx];
                    cell.executionSummary = { success: true, executionOrder: 1, timing: { startTime: Date.now() - 50, endTime: Date.now() } };
                    cell.outputs = [{ items: [
                        { mime: 'text/html', data: Buffer.from(`<div>${'duplicated-rich-output '.repeat(2000)}</div>`) },
                        { mime: 'text/plain', data: Buffer.from('hello\n') },
                        { mime: 'image/png', data: Buffer.from([0, 255, 1, 254, 2, 253]) }
                    ] }, { items: [
                        { mime: 'application/vnd.code.notebook.stdout', data: Buffer.from('stream-line\n') }
                    ] }];
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
    lm: {
        get tools() { return configureAvailable ? [{ name: 'configure_notebook' }] : []; },
        invokeTool: async (name, options) => {
            startedKernels.push({ name, filePath: options.input.filePath });
            if (!/failed|error/i.test(startupDetail) && !availableKernels.some((kernel) => kernel.id === providerKernel.id)) {
                availableKernels.push(providerKernel);
            }
            return { content: [{ value: startupDetail }] };
        }
    },
    env: { clipboard: { writeText: async () => {} } },
    StatusBarAlignment: { Right: 1 },
    WorkspaceEdit: class { constructor() { this._ops = []; } set(uri, edits) { this._ops.push([String(uri), edits]); } },
    NotebookEdit: {
        replaceCells(range, cells) { return { __kind: 'replace', range: [range.a, range.b], cells }; },
        insertCells(index, cells) { return { __kind: 'insert', index, cells }; },
        deleteCells(range) { return { __kind: 'delete', range: [range.a, range.b] }; },
        updateCellMetadata(idx, meta) { return { __kind: 'updateMeta', idx, meta }; },
        updateNotebookMetadata(meta) { return { __kind: 'updateNotebookMeta', meta }; }
    },
    NotebookCellData: class { constructor(kind, value, lang) { this.kind = kind; this.value = value; this.languageId = lang; } },
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookRange: class { constructor(a, b) { this.a = a; this.b = b; } },
    Uri: {
        parse: (value) => ({ toString: () => value, fsPath: value.replace(/^file:\/\/\//, '') }),
        joinPath: (base, name) => ({ toString: () => `file:///C:/repo/${name}`, fsPath: `C:/repo/${name}` })
    }
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
    if (PORT === 0) PORT = Number(String(statusBar.tooltip).match(/127\.0\.0\.1:(\d+)/)[1]);
    const client = await waitForServer();

    assert.strictEqual(statusBar.text, '$(notebook) MCP');
    assert.match(String(statusBar.tooltip), new RegExp(`http://127\\.0\\.0\\.1:${PORT}/mcp`));

    let passed = 0;
    const check = (name, fn) => fn().then(() => { passed++; console.log(`  ✓ ${name}`); }).catch((e) => { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; });

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    console.log(`Tools exposed (${names.length}): ${names.join(', ')}`);

    // 1. With Jupyter present, kernel tools ARE exposed.
    await check('kernel tools exposed when Jupyter present', async () => {
        const expected = ['create_notebook', 'list_notebooks', 'inspect_notebooks', 'read_cells', 'read_cell_outputs', 'search_cells', 'clear_cell_outputs', 'get_kernel_info', 'list_kernels', 'select_kernel', 'read_notebook', 'export_notebook', 'edit_cells', 'run_cells', 'restart_kernels', 'interrupt_kernels', 'move_cells', 'open_notebooks', 'save_notebooks'];
        assert.deepStrictEqual([...names].sort(), expected.sort());
    });

    // 2. run_cells waits and returns outputs.
    await check('run_cells returns captured outputs', async () => {
        const savesBefore = saveCalls;
        const res = await client.callTool({ name: 'run_cells', arguments: { filePath: 'file:///C:/nb.ipynb', cellIds: [0], timeoutMs: 5000 } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.strictEqual(saveCalls, savesBefore + 1, 'completed execution must persist even when isDirty is false');
        assert.match(res.content[0].text, /success/, 'expected success status');
        assert.match(res.content[0].text, /hello/, 'expected captured output text');
        assert.match(res.content[0].text, /stream-line/, 'expected stdout stream output');
        assert.doesNotMatch(res.content[0].text, /duplicated-rich-output/, 'should not duplicate rich HTML when plain text exists');
        assert.match(res.content[0].text, /image\/png \| 6 bytes omitted/, 'expected binary image summary');
    });

    // 3. read_notebook returns whole notebook with anchors + source.
    await check('read_notebook reads whole notebook', async () => {
        const res = await client.callTool({ name: 'read_notebook', arguments: { filePath: 'file:///C:/nb.ipynb', includeOutputs: true } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /id:cell-abc/, 'expected cell id anchor');
        assert.match(res.content[0].text, /print\("hello"\)/, 'expected source');
        assert.match(res.content[0].text, /hello/, 'expected outputs');
        assert.match(res.content[0].text, /state:n\/a/, 'markdown cells must not be reported as execution errors');
    });

    await check('read_cell_outputs supports bounded summary mode', async () => {
        const res = await client.callTool({ name: 'read_cell_outputs', arguments: {
            filePath: 'file:///C:/nb.ipynb', cellIds: [0], outputMode: 'summary', maxOutputChars: 1000
        } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /text\/html \d+ bytes/);
        assert.match(res.content[0].text, /image\/png 6 bytes/);
        assert.ok(res.content[0].text.length < 1000);
    });

    await check('run_cells can queue without waiting', async () => {
        const res = await client.callTool({ name: 'run_cells', arguments: {
            filePath: 'file:///C:/nb.ipynb', cellIds: [0], wait: false
        } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /Queued 1 cell/);
    });

    await check('run_cells timeout reports a live execution without failing', async () => {
        executionMode = 'hang';
        const res = await client.callTool({ name: 'run_cells', arguments: {
            filePath: 'file:///C:/nb.ipynb', cellIds: [0], timeoutMs: 5
        } });
        executionMode = 'complete';
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /still running/);
        assert.match(res.content[0].text, /not interrupted/);
    });

    // 4. Cell-id anchors resolve in read_cells.
    await check('read_cells resolves by cell id anchor', async () => {
        const res = await client.callTool({ name: 'read_cells', arguments: { filePath: 'file:///C:/nb.ipynb', cellIds: ['cell-abc'] } });
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

    await check('list_kernels initially returns only registered controllers', async () => {
        const configureCallsBefore = startedKernels.length;
        const res = await client.callTool({ name: 'list_kernels', arguments: { filePath: 'file:///C:/nb.ipynb' } });
        assert.ok(!res.isError, JSON.stringify(res));
        const listed = JSON.parse(res.content[0].text);
        assert.deepStrictEqual(listed.kernels.map((kernel) => kernel.id), ['ms-toolsai.jupyter/python-312']);
        assert.strictEqual(listed.configuration, undefined);
        assert.strictEqual(startedKernels.length, configureCallsBefore, 'default enumeration must not configure providers');
        assert.doesNotMatch(res.content[0].text, /Colab Runtime/);
    });

    await check('save_notebooks force-saves a clean file notebook', async () => {
        const savesBefore = saveCalls;
        const res = await client.callTool({ name: 'save_notebooks', arguments: { filePaths: ['file:///C:/nb.ipynb'] } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.strictEqual(saveCalls, savesBefore + 1);
        assert.match(res.content[0].text, /Saved: file:\/\/\/C:\/nb\.ipynb/);
    });

    await check('list_kernels configure=true reports a missing Jupyter configure tool', async () => {
        configureAvailable = false;
        const res = await client.callTool({ name: 'list_kernels', arguments: {
            filePath: 'file:///C:/nb.ipynb', configure: true
        } });
        configureAvailable = true;
        assert.ok(res.isError);
        assert.match(res.content[0].text, /configure_notebook.*unavailable/i);
    });

    await check('list_kernels configure=true propagates configuration failure', async () => {
        startupDetail = 'Failed to configure the selected provider.';
        const res = await client.callTool({ name: 'list_kernels', arguments: {
            filePath: 'file:///C:/nb.ipynb', configure: true
        } });
        startupDetail = 'Kernel is idle and ready.';
        assert.ok(res.isError);
        assert.match(res.content[0].text, /could not configure a kernel/i);
    });

    await check('list_kernels configure=true bootstraps and returns refreshed provider controllers', async () => {
        const configured = await client.callTool({ name: 'list_kernels', arguments: {
            filePath: 'file:///C:/nb.ipynb', configure: true
        } });
        assert.ok(!configured.isError, JSON.stringify(configured));
        assert.strictEqual(startedKernels.at(-1).name, 'configure_notebook');
        const listed = JSON.parse(configured.content[0].text);
        assert.strictEqual(listed.configuration.status, 'configured');
        assert.ok(listed.kernels.some((kernel) => kernel.id === providerKernel.id));
    });

    await check('list_kernels configure=true returns pending status with refreshed controllers', async () => {
        startupDetail = 'The kernel is taking longer than expected to start and is still starting in the background.';
        const res = await client.callTool({ name: 'list_kernels', arguments: {
            filePath: 'file:///C:/nb.ipynb', configure: true
        } });
        startupDetail = 'Kernel is idle and ready.';
        assert.ok(!res.isError, JSON.stringify(res));
        const listed = JSON.parse(res.content[0].text);
        assert.strictEqual(listed.configuration.status, 'pending');
        assert.match(listed.configuration.detail, /still starting in the background/);
        assert.ok(listed.kernels.some((kernel) => kernel.id === providerKernel.id));
    });

    await check('select_kernel selects exact id and can start it', async () => {
        const res = await client.callTool({ name: 'select_kernel', arguments: {
            filePath: 'file:///C:/nb.ipynb', kernelId: 'ms-toolsai.jupyter/colab-runtime', start: true
        } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.strictEqual(selectedKernels.at(-1), 'ms-toolsai.jupyter/colab-runtime');
        assert.strictEqual(startedKernels.at(-1).name, 'configure_notebook');
        assert.match(res.content[0].text, /Selected and started kernel 'Colab Runtime'/);
    });

    await check('select_kernel rejects an invalid/unavailable id without fallback', async () => {
        const before = selectedKernels.length;
        const res = await client.callTool({ name: 'select_kernel', arguments: {
            filePath: 'file:///C:/nb.ipynb', kernelId: 'google.colab/missing'
        } });
        assert.ok(res.isError);
        assert.strictEqual(selectedKernels.length, before);
    });

    await check('select_kernel reports a rejected exact selection', async () => {
        exactSelectionAccepted = false;
        const res = await client.callTool({ name: 'select_kernel', arguments: {
            filePath: 'file:///C:/nb.ipynb', kernelId: 'ms-toolsai.jupyter/python-312'
        } });
        exactSelectionAccepted = true;
        assert.ok(res.isError);
        assert.match(res.content[0].text, /did not select kernel/i);
    });

    await check('select_kernel reports a missing configure tool when start is requested', async () => {
        configureAvailable = false;
        const res = await client.callTool({ name: 'select_kernel', arguments: {
            filePath: 'file:///C:/nb.ipynb', kernelId: 'ms-toolsai.jupyter/python-312', start: true
        } });
        configureAvailable = true;
        assert.ok(res.isError);
        assert.match(res.content[0].text, /configure_notebook.*unavailable/i);
    });

    await check('select_kernel reports pending startup without claiming it started', async () => {
        startupDetail = 'The kernel is taking longer than expected to start and is still starting in the background.';
        const res = await client.callTool({ name: 'select_kernel', arguments: {
            filePath: 'file:///C:/nb.ipynb', kernelId: 'ms-toolsai.jupyter/colab-runtime', start: true
        } });
        startupDetail = 'Kernel is idle and ready.';
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /startup was requested and is still pending/i);
        assert.doesNotMatch(res.content[0].text, /selected and started/i);
    });

    await check('run_cells preserves legacy best-effort kernel hint behavior', async () => {
        const exactSelectionsBefore = selectedKernels.length;
        rejectLegacyKernelHint = true;
        const res = await client.callTool({ name: 'run_cells', arguments: {
            filePath: 'file:///C:/nb.ipynb', cellIds: [0], kernel: 'Python 3.12.2', wait: false
        } });
        rejectLegacyKernelHint = false;
        assert.ok(!res.isError, JSON.stringify(res));
        assert.strictEqual(legacyKernelHints.at(-1), 'Python 3.12.2');
        assert.strictEqual(selectedKernels.length, exactSelectionsBefore);
        assert.match(res.content[0].text, /Queued 1 cell/);
    });

    // 9. clear_cell_outputs after a run removes outputs + execution state.
    await check('clear_cell_outputs clears after run', async () => {
        const res = await client.callTool({ name: 'clear_cell_outputs', arguments: { filePath: 'file:///C:/nb.ipynb', cellIds: [0] } });
        assert.ok(!res.isError, JSON.stringify(res));
        const out = await client.callTool({ name: 'read_cell_outputs', arguments: { filePath: 'file:///C:/nb.ipynb', cellIds: [0] } });
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
