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
const executionCalls = [];
let saveCalls = 0;
let executionMode = 'complete';
let exactSelectionAccepted = true;
let rejectLegacyKernelHint = false;
let configureAvailable = true;
let startupDetail = 'Kernel is idle and ready.';
let showNotebookMismatch = false;
const availableKernels = [
    { id: 'ms-toolsai.jupyter/python-312', label: 'Python 3.12.2', description: 'Local Python' }
];
const providerKernel = { id: 'ms-toolsai.jupyter/colab-runtime', label: 'Colab Runtime', detail: 'Google Colab' };

function makeDoc(uri, fsPath = 'C:/nb.ipynb') {
    const cells = [
        { kind: 2, value: 'print("hello")', languageId: 'python', metadata: { id: 'cell-abc' } },
        { kind: 1, value: '# Title', languageId: 'markdown', metadata: {} },
        { kind: 2, value: 'print("tail")', languageId: 'python', metadata: { id: 'cell-tail' } },
        { kind: 2, value: 'print("sentinel")', languageId: 'python', metadata: { id: 'cell-sentinel' } }
    ];
    const doc = {
        notebookType: 'jupyter-notebook',
        uri: { fsPath, toString: () => uri },
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
makeDoc('file:///C:/inactive.ipynb', 'C:/inactive.ipynb');
const editFixture = makeDoc('file:///C:/edit-fixture.ipynb', 'C:/edit-fixture.ipynb');
editFixture._cells[0].value = 'payload-BEGIN-unique-token-END';
editFixture._cells[0].metadata = { id: 'cell-abc', tags: ['keep'] };
editFixture._cells[0].outputs = [{ items: [{ mime: 'text/plain', data: Buffer.from('preserve-me') }] }];
const longSourceFixture = makeDoc('file:///C:/long-source.ipynb', 'C:/long-source.ipynb');
longSourceFixture._cells[0].value = 'x'.repeat(70000);

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
        applyEdit: async (edit) => {
            for (const [uri, operations] of edit?._ops || []) {
                const nb = openNotebooks.find((candidate) => candidate.uri.toString() === uri);
                for (const operation of operations || []) {
                    if (operation.__kind !== 'replace') continue;
                    const index = operation.range[0];
                    const replacement = operation.cells[0];
                    nb._cells[index] = { kind: replacement.kind, value: replacement.value, languageId: replacement.languageId, metadata: replacement.metadata || {}, outputs: replacement.outputs || [] };
                }
            }
            return true;
        },
        onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: {
        createOutputChannel: () => ({ appendLine: (l) => { lines.push(l); console.log('[OUT]', l); }, dispose() {} }),
        createStatusBarItem: () => statusBar,
        showNotebookDocument: async (doc) => ({ notebook: showNotebookMismatch ? openNotebooks[0] : doc })
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
            if (cmd === 'notebook.execute') {
                throw new Error('run-all command must not be used for targeted cell execution');
            }
            if (cmd === 'notebook.cell.execute') {
                assert.ok(uri && uri.document && Array.isArray(uri.ranges), 'expected cell execution options');
                executionCalls.push(uri);
                if (executionMode === 'hang') return;
                const nb = openNotebooks.find((candidate) => candidate.uri.toString() === uri.document.toString());
                assert.ok(nb, 'target notebook must be selected by document URI');
                // Simulate execution completing only for the requested ranges.
                for (const range of uri.ranges) {
                    const idx = range.start;
                    const cell = nb._cells[idx];
                    assert.strictEqual(range.end, idx + 1, 'each range must target exactly one cell');
                    if (!cell || cell.kind !== 2) continue;
                    if (executionMode === 'observed-hang') {
                        cell.executionSummary = { timing: { startTime: Date.now() } };
                        continue;
                    }
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
        const expected = ['create_notebook', 'list_notebooks', 'inspect_notebooks', 'read_cells', 'read_cell_outputs', 'search_cells', 'clear_cell_outputs', 'get_kernel_info', 'list_kernels', 'select_kernel', 'configure_kernel', 'read_notebook', 'export_notebook', 'edit_cells', 'run_cells', 'restart_kernels', 'interrupt_kernels', 'move_cells', 'open_notebooks', 'save_notebooks', 'upload_file', 'download_file'];
        assert.deepStrictEqual([...names].sort(), expected.sort());
    });

    // 2. run_cells waits and returns outputs.
    await check('run_cells returns captured outputs', async () => {
        const savesBefore = saveCalls;
        const res = await client.callTool({ name: 'run_cells', arguments: { notebookRef: 'file:///C:/nb.ipynb', cellIds: [0], timeoutMs: 5000 } });
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
        const res = await client.callTool({ name: 'read_notebook', arguments: { notebookRef: 'file:///C:/nb.ipynb', includeOutputs: true } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /id:cell-abc/, 'expected cell id anchor');
        assert.match(res.content[0].text, /print\("hello"\)/, 'expected source');
        assert.match(res.content[0].text, /hello/, 'expected outputs');
        assert.match(res.content[0].text, /state:n\/a/, 'markdown cells must not be reported as execution errors');
    });

    await check('read_cell_outputs supports bounded summary mode', async () => {
        const res = await client.callTool({ name: 'read_cell_outputs', arguments: {
            notebookRef: 'file:///C:/nb.ipynb', cellIds: [0], outputMode: 'summary', maxOutputChars: 1000
        } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /text\/html \d+ bytes/);
        assert.match(res.content[0].text, /image\/png 6 bytes/);
        assert.ok(res.content[0].text.length < 1000);
    });

    await check('run_cells can queue without waiting', async () => {
        const callsBefore = executionCalls.length;
        const res = await client.callTool({ name: 'run_cells', arguments: {
            notebookRef: 'file:///C:/nb.ipynb', cellIds: [0], wait: false
        } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /Queued 1 cell/);
        assert.strictEqual(executionCalls.length, callsBefore + 1);
        assert.deepStrictEqual(executionCalls.at(-1).ranges, [{ start: 0, end: 1 }]);
        assert.strictEqual(executionCalls.at(-1).document.toString(), 'file:///C:/nb.ipynb');
    });

    await check('run_cells targets the requested notebook and preserves requested order', async () => {
        const active = makeDoc('file:///C:/target-active.ipynb', 'C:/target-active.ipynb');
        const inactive = makeDoc('file:///C:/target-inactive.ipynb', 'C:/target-inactive.ipynb');
        const snapshot = (notebook) => notebook._cells.map((cell) => ({
            kind: cell.kind,
            summary: cell.executionSummary,
            outputs: cell.outputs
        }));
        const activeSnapshot = snapshot(active);
        const inactiveSentinelSnapshot = {
            summary: inactive._cells[3].executionSummary,
            outputs: inactive._cells[3].outputs
        };
        assert.strictEqual(active._cells[3].kind, 2, 'active sentinel must be a code cell');
        assert.strictEqual(inactive._cells[3].kind, 2, 'inactive sentinel must be a code cell');
        assert.strictEqual(inactive._cells[1].executionSummary, undefined);
        assert.strictEqual(inactive._cells[3].executionSummary, undefined);
        const before = executionCalls.length;
        const queued = await client.callTool({ name: 'run_cells', arguments: {
            notebookRef: 'file:///C:/target-inactive.ipynb', cellIds: [0, 2], wait: false
        } });
        assert.ok(!queued.isError, JSON.stringify(queued));
        assert.strictEqual(executionCalls.length, before + 1);
        assert.deepStrictEqual(executionCalls.at(-1).ranges, [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
        assert.strictEqual(executionCalls.at(-1).document.toString(), 'file:///C:/target-inactive.ipynb');
        assert.strictEqual(inactive._cells[1].executionSummary, undefined, 'unselected markdown cell must remain untouched');
        assert.deepStrictEqual({ summary: inactive._cells[3].executionSummary, outputs: inactive._cells[3].outputs }, inactiveSentinelSnapshot, 'unselected code cell must remain untouched');
        assert.deepStrictEqual(snapshot(active), activeSnapshot, 'targeting another notebook must not alter active notebook cells');

        const waitedBefore = executionCalls.length;
        const waited = await client.callTool({ name: 'run_cells', arguments: {
            notebookRef: 'file:///C:/target-active.ipynb', cellIds: ['cell-tail', 0], timeoutMs: 5000
        } });
        assert.ok(!waited.isError, JSON.stringify(waited));
        assert.deepStrictEqual(executionCalls.slice(waitedBefore).map((call) => call.ranges), [
            [{ start: 2, end: 3 }], [{ start: 0, end: 1 }]
        ]);
        assert.deepStrictEqual({ summary: active._cells[3].executionSummary, outputs: active._cells[3].outputs }, activeSnapshot[3] && { summary: activeSnapshot[3].summary, outputs: activeSnapshot[3].outputs }, 'waited subset must leave code sentinel untouched');

        const failedRevealCalls = executionCalls.length;
        showNotebookMismatch = true;
        const failedReveal = await client.callTool({ name: 'run_cells', arguments: {
            notebookRef: 'file:///C:/target-inactive.ipynb', cellIds: [0], wait: false
        } });
        showNotebookMismatch = false;
        assert.ok(failedReveal.isError, 'mismatched editor reveal must fail closed');
        assert.strictEqual(executionCalls.length, failedRevealCalls, 'failed reveal must not dispatch execution');
    });

    await check('run_cells timeout reports a live execution without failing', async () => {
        executionMode = 'hang';
        const res = await client.callTool({ name: 'run_cells', arguments: {
            notebookRef: 'file:///C:/nb.ipynb', cellIds: [0], timeoutMs: 5
        } });
        executionMode = 'complete';
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /not observed to start/);
        assert.match(res.content[0].text, /request was not cancelled and may still start/i);
        assert.match(res.content[0].text, /request was not cancelled and may still start/i);
        executionMode = 'observed-hang';
        const observed = await client.callTool({ name: 'run_cells', arguments: {
            notebookRef: 'file:///C:/nb.ipynb', cellIds: [0], timeoutMs: 5
        } });
        executionMode = 'complete';
        assert.ok(!observed.isError, JSON.stringify(observed));
        assert.match(observed.content[0].text, /execution observed but did not complete/);
    });

    // 4. Cell-id anchors resolve in read_cells.
    await check('read_cells resolves by cell id anchor', async () => {
        const res = await client.callTool({ name: 'read_cells', arguments: { notebookRef: 'file:///C:/nb.ipynb', cellIds: ['cell-abc'] } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /print\("hello"\)/);
    });

    await check('read_cells applies bounded 1-based source ranges and truncates long single lines', async () => {
        const ranged = await client.callTool({ name: 'read_cells', arguments: {
            notebookRef: 'file:///C:/long-source.ipynb', cellIds: [0], startLine: 1, endLine: 1, maxSourceChars: 32
        } });
        assert.ok(!ranged.isError, JSON.stringify(ranged));
        assert.match(ranged.content[0].text, /truncated at 32 characters/);
        assert.ok(ranged.content[0].text.includes('x'.repeat(32)));
        const invalid = await client.callTool({ name: 'read_cells', arguments: {
            notebookRef: 'file:///C:/long-source.ipynb', cellIds: [0], startLine: 2, endLine: 1
        } });
        assert.ok(invalid.isError);
    });

    await check('edit_cells replaces one unique snippet and preserves payload, metadata, and outputs', async () => {
        const before = JSON.stringify(editFixture._cells[0].outputs);
        const res = await client.callTool({ name: 'edit_cells', arguments: {
            notebookRef: 'file:///C:/edit-fixture.ipynb', edits: [{ cellId: 0, editType: 'replace', oldText: 'unique-token', newCode: 'replaced-token' }]
        } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.strictEqual(editFixture._cells[0].value, 'payload-BEGIN-replaced-token-END');
        assert.deepStrictEqual(editFixture._cells[0].metadata, { id: 'cell-abc', tags: ['keep'] });
        assert.strictEqual(JSON.stringify(editFixture._cells[0].outputs), before);
    });

    await check('edit_cells rejects absent and ambiguous snippets without mutation, while allowing empty replacement', async () => {
        const original = editFixture._cells[0].value;
        const omitted = await client.callTool({ name: 'edit_cells', arguments: {
            notebookRef: 'file:///C:/edit-fixture.ipynb', edits: [{ cellId: 0, editType: 'replace', oldText: 'replaced-token' }]
        } });
        assert.ok(omitted.isError);
        assert.strictEqual(editFixture._cells[0].value, original);
        for (const oldText of ['missing-token', 'payload']) {
            editFixture._cells[0].value = oldText === 'payload' ? 'payload payload' : original;
            const res = await client.callTool({ name: 'edit_cells', arguments: {
                notebookRef: 'file:///C:/edit-fixture.ipynb', edits: [{ cellId: 0, editType: 'replace', oldText, newCode: 'x' }]
            } });
            assert.ok(res.isError);
            assert.strictEqual(editFixture._cells[0].value, oldText === 'payload' ? 'payload payload' : original);
        }
        editFixture._cells[0].value = original;
        const empty = await client.callTool({ name: 'edit_cells', arguments: {
            notebookRef: 'file:///C:/edit-fixture.ipynb', edits: [{ cellId: 0, editType: 'replace', oldText: 'replaced-token', newCode: '' }]
        } });
        assert.ok(!empty.isError, JSON.stringify(empty));
        assert.strictEqual(editFixture._cells[0].value, 'payload-BEGIN--END');
    });

    // 5. export_notebook markdown.
    await check('export_notebook markdown', async () => {
        const res = await client.callTool({ name: 'export_notebook', arguments: { notebookRef: 'file:///C:/nb.ipynb', format: 'markdown' } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /```python/, 'expected python fence');
        assert.match(res.content[0].text, /# Title/, 'expected markdown cell');
    });

    // 6. export_notebook python.
    await check('export_notebook python', async () => {
        const res = await client.callTool({ name: 'export_notebook', arguments: { notebookRef: 'file:///C:/nb.ipynb', format: 'python' } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /# %%/, 'expected cell marker');
    });

    // 7. export_notebook rejects bad format.
    await check('export_notebook rejects bad format', async () => {
        const res = await client.callTool({ name: 'export_notebook', arguments: { notebookRef: 'file:///C:/nb.ipynb', format: 'bogus' } });
        assert.ok(res.isError);
    });

    // 8. get_kernel_info returns the active kernel label via the Jupyter API.
    await check('get_kernel_info returns active kernel', async () => {
        const res = await client.callTool({ name: 'get_kernel_info', arguments: { notebookRef: 'file:///C:/nb.ipynb' } });
        assert.ok(!res.isError, JSON.stringify(res));
        const info = JSON.parse(res.content[0].text);
        assert.strictEqual(info.kernel.label, 'Python 3.12.2');
        assert.strictEqual(info.capabilities.kernelFileTransfer.available, 'unknown');
    });

    await check('list_kernels initially returns only registered controllers', async () => {
        const configureCallsBefore = startedKernels.length;
        const res = await client.callTool({ name: 'list_kernels', arguments: { notebookRef: 'file:///C:/nb.ipynb' } });
        assert.ok(!res.isError, JSON.stringify(res));
        const listed = JSON.parse(res.content[0].text);
        assert.deepStrictEqual(listed.kernels.map((kernel) => kernel.id), ['ms-toolsai.jupyter/python-312']);
        assert.strictEqual(listed.configuration, undefined);
        assert.strictEqual(startedKernels.length, configureCallsBefore, 'default enumeration must not configure providers');
        assert.doesNotMatch(res.content[0].text, /Colab Runtime/);
    });

    await check('configure_kernel is explicit and reports a configuration request', async () => {
        const res = await client.callTool({ name: 'configure_kernel', arguments: { notebookRef: 'file:///C:/nb.ipynb' } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /configuration requested/i);
        assert.strictEqual(startedKernels.at(-1).name, 'configure_notebook');
    });

    await check('save_notebooks force-saves a clean file notebook', async () => {
        const savesBefore = saveCalls;
        const res = await client.callTool({ name: 'save_notebooks', arguments: { notebookRefs: ['file:///C:/nb.ipynb'] } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.strictEqual(saveCalls, savesBefore + 1);
        assert.match(res.content[0].text, /Saved: file:\/\/\/C:\/nb\.ipynb/);
    });

    await check('list_kernels legacy configure flag rejects without side effects', async () => {
        const before = startedKernels.length;
        const res = await client.callTool({ name: 'list_kernels', arguments: {
            notebookRef: 'file:///C:/nb.ipynb', configure: true
        } });
        assert.ok(res.isError);
        assert.strictEqual(startedKernels.length, before);
    });

    await check('configure_kernel reports provider failure without claiming startup', async () => {
        startupDetail = 'Failed to configure the selected provider.';
        const res = await client.callTool({ name: 'configure_kernel', arguments: { notebookRef: 'file:///C:/nb.ipynb' } });
        startupDetail = 'Kernel is idle and ready.';
        assert.ok(res.isError);
        assert.match(res.content[0].text, /could not configure/i);
    });

    await check('select_kernel rejects generic start mode', async () => {
        const before = selectedKernels.length;
        const res = await client.callTool({ name: 'select_kernel', arguments: {
            notebookRef: 'file:///C:/nb.ipynb', kernelId: 'ms-toolsai.jupyter/colab-runtime', start: true
        } });
        assert.ok(res.isError);
        assert.strictEqual(selectedKernels.length, before);
    });

    await check('select_kernel rejects an invalid/unavailable id without fallback', async () => {
        const before = selectedKernels.length;
        const res = await client.callTool({ name: 'select_kernel', arguments: {
            notebookRef: 'file:///C:/nb.ipynb', kernelId: 'google.colab/missing'
        } });
        assert.ok(res.isError);
        assert.strictEqual(selectedKernels.length, before);
    });

    await check('select_kernel reports a rejected exact selection', async () => {
        exactSelectionAccepted = false;
        const res = await client.callTool({ name: 'select_kernel', arguments: {
            notebookRef: 'file:///C:/nb.ipynb', kernelId: 'ms-toolsai.jupyter/python-312'
        } });
        exactSelectionAccepted = true;
        assert.ok(res.isError);
        assert.match(res.content[0].text, /did not select kernel/i);
    });

    await check('select_kernel rejects start before provider side effects', async () => {
        const selectedBefore = selectedKernels.length;
        const startedBefore = startedKernels.length;
        const res = await client.callTool({ name: 'select_kernel', arguments: {
            notebookRef: 'file:///C:/nb.ipynb', kernelId: 'ms-toolsai.jupyter/python-312', start: true
        } });
        assert.ok(res.isError);
        assert.strictEqual(selectedKernels.length, selectedBefore);
        assert.strictEqual(startedKernels.length, startedBefore);
    });

    await check('run_cells rejects legacy kernel hints before save or execution', async () => {
        const selectedBefore = selectedKernels.length;
        const callsBefore = executionCalls.length;
        const savesBefore = saveCalls;
        const legacy = await client.callTool({ name: 'run_cells', arguments: {
            notebookRef: 'file:///C:/nb.ipynb', cellIds: [0], kernel: 'Python 3.12.2', wait: false
        } });
        assert.ok(legacy.isError);
        assert.strictEqual(selectedKernels.length, selectedBefore);
        assert.strictEqual(executionCalls.length, callsBefore);
        assert.strictEqual(saveCalls, savesBefore);
    });

    // 9. clear_cell_outputs after a run removes outputs + execution state.
    await check('clear_cell_outputs clears after run', async () => {
        const before = [openNotebooks[0]._cells[0], openNotebooks[0]._cells[2]];
        const middleBefore = openNotebooks[0]._cells[1];
        const inactiveBefore = openNotebooks[1]._cells[0];
        const res = await client.callTool({ name: 'clear_cell_outputs', arguments: { notebookRef: 'file:///C:/nb.ipynb', cellIds: [0, 2] } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.strictEqual(openNotebooks[0]._cells[0].value, before[0].value);
        assert.strictEqual(openNotebooks[0]._cells[2].value, before[1].value);
        assert.deepStrictEqual(openNotebooks[0]._cells[0].metadata, before[0].metadata);
        assert.deepStrictEqual(openNotebooks[0]._cells[2].metadata, before[1].metadata);
        assert.strictEqual(openNotebooks[0]._cells[1].value, middleBefore.value);
        assert.strictEqual(openNotebooks[1]._cells[0].value, inactiveBefore.value);
        const out = await client.callTool({ name: 'read_cell_outputs', arguments: { notebookRef: 'file:///C:/nb.ipynb', cellIds: [0, 2] } });
        assert.match(out.content[0].text, /no saved output/);
    });

    // 10. interrupt_kernels stops running execution.
    await check('interrupt_kernels works', async () => {
        const res = await client.callTool({ name: 'interrupt_kernels', arguments: { notebookRefs: ['file:///C:/nb.ipynb'] } });
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
