// Deterministic MCP integration test: loads the compiled extension bundle with a
// minimal vscode shim (empty window, no workspace, no Jupyter extension) and exercises
// every tool over a real MCP HTTP connection. No GUI, no VS Code download — CI-safe.
'use strict';
const path = require('path');
const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ROOT = path.resolve(__dirname, '..', '..');
let PORT = Number(process.env.MCP_TEST_PORT || 0);

// ---- Minimal vscode shim: EMPTY WINDOW (no workspace folders, no Jupyter) ----
const lines = [];
const statusBar = { text: '', tooltip: '', command: '', show() {}, dispose() {} };
const disposables = [];
const executed = [];
const interrupted = [];
let untitledCounter = 0;
const openNotebooks = []; // simulates open notebook documents
let openCalls = 0;
let shownDocuments = 0;

// Each entry: { uri, cells: [{ kind, value, languageId }] }
function makeDoc(type, data) {
    const uri = `untitled:Untitled-${++untitledCounter}.ipynb`;
    const cells = data.cells.map((c) => ({
        kind: c.kind, value: c.value, languageId: c.languageId, metadata: c.metadata || {}, outputs: [], executionSummary: undefined
    }));
    const doc = {
        notebookType: type,
        uri: { fsPath: '', toString: () => uri },
        metadata: {},
        isDirty: false, isUntitled: true,
        get cellCount() { return cells.length; },
        cellAt: (i) => ({
            kind: cells[i].kind,
            document: { uri: { fragment: `c${i}` }, languageId: cells[i].languageId, getText: () => cells[i].value },
            outputs: cells[i].outputs, executionSummary: cells[i].executionSummary, metadata: cells[i].metadata
        }),
        getCells: () => cells.map((c, i) => ({
            kind: c.kind,
            document: { uri: { fragment: `c${i}` }, languageId: c.languageId, getText: () => c.value },
            outputs: c.outputs, executionSummary: c.executionSummary, metadata: c.metadata
        })),
        save: async () => true,
        _cells: cells
    };
    openNotebooks.push(doc);
    return doc;
}

const vscodeShim = {
    workspace: {
        getConfiguration: () => ({ get: (k, d) => {
            if (k === 'transport') return 'http';
            if (k === 'port') return PORT;
            if (k === 'enabled') return true;
            if (k === 'saveBeforeExecute') return true;
            return d;
        }}),
        workspaceFolders: undefined, // empty window
        notebookDocuments: openNotebooks,
        fs: { writeFile: async () => {} },
        applyEdit: async (edit) => {
            // Mutate the target notebook's cells based on NotebookEdit ops recorded by the shim's WorkspaceEdit.set.
            for (const [uri, edits] of (edit._ops || [])) {
                const doc = openNotebooks.find((d) => d.uri.toString() === uri);
                if (!doc) continue;
                for (const op of edits) {
                    if (op.__kind === 'replace') {
                        // op: { __kind, range: [start,end), cells: [NotebookCellData] }
                        const newCells = op.cells.map((c) => ({ kind: c.kind, value: c.value, languageId: c.languageId, metadata: c.metadata || {}, outputs: [], executionSummary: undefined }));
                        doc._cells.splice(op.range[0], op.range[1] - op.range[0], ...newCells);
                    } else if (op.__kind === 'insert') {
                        const newCells = op.cells.map((c) => ({ kind: c.kind, value: c.value, languageId: c.languageId, metadata: c.metadata || {}, outputs: [], executionSummary: undefined }));
                        doc._cells.splice(op.index, 0, ...newCells);
                    } else if (op.__kind === 'delete') {
                        doc._cells.splice(op.range[0], op.range[1] - op.range[0]);
                    } else if (op.__kind === 'updateMeta') {
                        doc._cells[op.idx].metadata = op.meta;
                    }
                }
            }
            return true;
        },
        openNotebookDocument: async (type, data) => { openCalls++; return makeDoc(type, data); },
        onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: {
        createOutputChannel: () => ({ appendLine: (l) => { lines.push(l); console.log('[OUT]', l); }, dispose() {} }),
        createStatusBarItem: () => statusBar,
        showNotebookDocument: async () => { shownDocuments++; }
    },
    extensions: { getExtension: () => undefined, onDidChange: () => ({ dispose() {} }) },
    commands: {
        registerCommand: () => ({ dispose() {} }),
        executeCommand: async (cmd, ...args) => {
            if (cmd === 'notebook.execute') executed.push(args);
            if (cmd === 'notebook.clearOutputs') {
                const [uri, cellUris] = args;
                const doc = openNotebooks.find((d) => d.uri.toString() === uri);
                if (doc) {
                    for (const cu of cellUris) {
                        const frag = cu.fragment || '';
                        const idx = Number(frag.replace('c', ''));
                        const cell = doc._cells[idx];
                        cell.outputs = [];
                        cell.executionSummary = undefined;
                    }
                }
            }
            if (cmd === 'notebook.interruptKernel') interrupted.push(args[0]);
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
    NotebookData: class { constructor(cells) { this.cells = cells; } },
    NotebookCellData: class { constructor(kind, value, lang) { this.kind = kind; this.value = value; this.languageId = lang; } },
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookRange: class { constructor(a, b) { this.a = a; this.b = b; } },
    Uri: {
        parse: (value) => ({ toString: () => value, fsPath: value.replace(/^file:\/\/\//, '') }),
        joinPath: (base, name) => ({ toString: () => `file:///C:/repo/${name}`, fsPath: `C:/repo/${name}` })
    }
};

// Install the shim as the 'vscode' module.
const Module = require('module');
const stubFile = path.join(ROOT, '.vscode-test', 'vscode-shim.cjs');
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
            const client = new Client({ name: 'test', version: '1.0' });
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

    // 1. No Jupyter -> kernel tools absent, document tools present.
    await check('tool set (no Jupyter)', async () => {
        const expected = ['create_notebook', 'list_notebooks', 'inspect_notebooks', 'read_cells', 'read_cell_outputs', 'search_cells', 'clear_cell_outputs', 'get_kernel_info', 'read_notebook', 'export_notebook', 'edit_cells', 'move_cells', 'open_notebooks', 'save_notebooks'];
        assert.deepStrictEqual([...names].sort(), expected.sort());
    });

    // 2. create_notebook in an empty window -> untitled.
    const created = await client.callTool({ name: 'create_notebook', arguments: { query: 'Test notebook' } });
    const createdText = created.content[0].text;
    console.log(`  create_notebook -> ${createdText}`);
    assert.ok(!created.isError, JSON.stringify(created));
    assert.match(createdText, /untitled/);
    const createdUri = createdText.match(/untitled:[^\s]+/)[0];
    passed++;

    // 3. list_notebooks lists it.
    await check('list_notebooks lists the created notebook', async () => {
        const res = await client.callTool({ name: 'list_notebooks', arguments: {} });
        const parsed = JSON.parse(res.content[0].text);
        assert.ok(parsed.some((n) => n.uri === createdUri), `not listed: ${res.content[0].text}`);
        const listed = parsed.find((n) => n.uri === createdUri);
        assert.match(listed.notebookId, new RegExp(`^${listed.windowId}::untitled:`));
        assert.strictEqual(listed.windowLabel, 'Empty window');
    });

    // 4. read_cells.
    await check('read_cells reads cells', async () => {
        const res = await client.callTool({ name: 'read_cells', arguments: { filePath: createdUri, cellIds: [0, 1] } });
        assert.match(res.content[0].text, /Test notebook/);
        assert.match(res.content[0].text, /Add your code here/);
    });

    // 5. inspect_notebooks metadata.
    await check('inspect_notebooks returns metadata', async () => {
        const res = await client.callTool({ name: 'inspect_notebooks', arguments: { filePaths: [createdUri] } });
        assert.match(res.content[0].text, /Cells: 2/);
        assert.match(res.content[0].text, /markdown/);
    });

    // 6. edit_cells (no re-run without Jupyter).
    await check('edit_cells edits a cell', async () => {
        const res = await client.callTool({ name: 'edit_cells', arguments: { filePath: createdUri, edits: [{ cellId: 1, editType: 'edit', newCode: 'print("edited")' }] } });
        assert.ok(!res.isError, JSON.stringify(res));
        const src = await client.callTool({ name: 'read_cells', arguments: { filePath: createdUri, cellIds: [1] } });
        assert.match(src.content[0].text, /edited/);
    });

    // 7. move_cells.
    await check('move_cells reorders cells', async () => {
        const res = await client.callTool({ name: 'move_cells', arguments: { filePath: createdUri, cellIds: [0], toIndex: 1 } });
        assert.ok(!res.isError, JSON.stringify(res));
    });

    // 8. read_cell_outputs graceful.
    await check('read_cell_outputs handles empty output', async () => {
        const res = await client.callTool({ name: 'read_cell_outputs', arguments: { filePath: createdUri, cellIds: [0] } });
        assert.ok(!res.isError, JSON.stringify(res));
    });

    // 9. save_notebooks graceful on untitled.
    await check('save_notebooks handles untitled', async () => {
        const res = await client.callTool({ name: 'save_notebooks', arguments: { filePaths: [createdUri] } });
        assert.ok(!res.isError, JSON.stringify(res));
    });

    // 10. open_notebooks rejects non-file URI.
    await check('open_notebooks rejects non-file URI', async () => {
        const res = await client.callTool({ name: 'open_notebooks', arguments: { filePaths: ['C:/x.ipynb'] } });
        assert.ok(res.isError, 'should have errored on non-file URI');
    });

    await check('open_notebooks preserves an already-open live document', async () => {
        const existing = {
            notebookType: 'jupyter-notebook',
            uri: { fsPath: 'C:/existing.ipynb', toString: () => 'file:///C:/existing.ipynb' },
            isDirty: false, isUntitled: false,
            cellCount: 0, cellAt: () => { throw new Error('no cells'); }, getCells: () => [], save: async () => true
        };
        openNotebooks.push(existing);
        const opensBefore = openCalls;
        const showsBefore = shownDocuments;
        const res = await client.callTool({ name: 'open_notebooks', arguments: { filePaths: ['file:///C:/existing.ipynb'] } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.strictEqual(openCalls, opensBefore, 'must not reload an already-open URI from disk');
        assert.strictEqual(shownDocuments, showsBefore + 1);
        assert.match(res.content[0].text, /preserved live document/);
    });

    // --- Validation / error branches ---
    const expectError = (name, tool, args, re) => check(name, async () => {
        const res = await client.callTool({ name: tool, arguments: args });
        assert.ok(res.isError, `${tool} should error on ${JSON.stringify(args)}`);
        if (re) assert.match(res.content[0].text, re);
    });
    await expectError('edit_cells rejects missing edits', 'edit_cells', { filePath: 'x' });
    await expectError('edit_cells rejects bad editType', 'edit_cells', { filePath: 'x', edits: [{ cellId: 0, editType: 'bogus' }] });
    await expectError('read_cell_outputs rejects empty cellIds', 'read_cell_outputs', { filePath: 'x', cellIds: [] });
    await expectError('inspect_notebooks rejects missing filePath', 'inspect_notebooks', {});
    await expectError('inspect_notebooks rejects empty filePaths', 'inspect_notebooks', { filePaths: [] });
    await expectError('move_cells rejects empty cellIds', 'move_cells', { filePath: 'x', cellIds: [], toIndex: 0 });
    await expectError('move_cells rejects bad toIndex', 'move_cells', { filePath: 'x', cellIds: [0], toIndex: 'a' });
    await expectError('save_notebooks rejects empty filePaths', 'save_notebooks', { filePaths: [] });

    // --- edit_cells insert / delete / metadata on the created notebook ---
    await check('edit_cells inserts a cell', async () => {
        const res = await client.callTool({ name: 'edit_cells', arguments: { filePath: createdUri, edits: [{ cellId: 0, editType: 'insert', newCode: 'print("inserted")' }] } });
        assert.ok(!res.isError, JSON.stringify(res));
        const meta = await client.callTool({ name: 'inspect_notebooks', arguments: { filePaths: [createdUri] } });
        assert.match(meta.content[0].text, /Cells: 3/);
    });
    await check('edit_cells TOP and BOTTOM insertion positions are exact', async () => {
        let res = await client.callTool({ name: 'edit_cells', arguments: { filePath: createdUri, edits: [{ cellId: 'TOP', editType: 'insert', newCode: 'top_marker' }] } });
        assert.ok(!res.isError, JSON.stringify(res));
        res = await client.callTool({ name: 'edit_cells', arguments: { filePath: createdUri, edits: [{ cellId: 'BOTTOM', editType: 'insert', newCode: 'bottom_marker' }] } });
        assert.ok(!res.isError, JSON.stringify(res));
        const first = await client.callTool({ name: 'read_cells', arguments: { filePath: createdUri, cellIds: [0] } });
        const last = await client.callTool({ name: 'read_cells', arguments: { filePath: createdUri, cellIds: [4] } });
        assert.match(first.content[0].text, /top_marker/);
        assert.match(last.content[0].text, /bottom_marker/);
        res = await client.callTool({ name: 'edit_cells', arguments: { filePath: createdUri, edits: [
            { cellId: 'BOTTOM', editType: 'delete' },
            { cellId: 'TOP', editType: 'delete' }
        ] } });
        assert.ok(!res.isError, JSON.stringify(res));
    });
    await check('edit_cells deletes a cell', async () => {
        const res = await client.callTool({ name: 'edit_cells', arguments: { filePath: createdUri, edits: [{ cellId: 0, editType: 'delete' }] } });
        assert.ok(!res.isError, JSON.stringify(res));
        const meta = await client.callTool({ name: 'inspect_notebooks', arguments: { filePaths: [createdUri] } });
        assert.match(meta.content[0].text, /Cells: 2/);
    });
    await check('edit_cells with metadata (updateCellMetadata path)', async () => {
        const res = await client.callTool({ name: 'edit_cells', arguments: { filePath: createdUri, edits: [{ cellId: 0, editType: 'edit', newCode: 'x=1', metadata: { tags: ['parameters'] } }] } });
        assert.ok(!res.isError, JSON.stringify(res));
    });
    await check('move_cells rejects duplicate cellIds', async () => {
        const res = await client.callTool({ name: 'move_cells', arguments: { filePath: createdUri, cellIds: [0, 0], toIndex: 1 } });
        assert.ok(res.isError);
    });
    await check('move_cells rejects out-of-range toIndex', async () => {
        const res = await client.callTool({ name: 'move_cells', arguments: { filePath: createdUri, cellIds: [0], toIndex: 99 } });
        assert.ok(res.isError);
    });
    await check('read_cells defaults to all cells', async () => {
        const res = await client.callTool({ name: 'read_cells', arguments: { filePath: createdUri } });
        assert.ok(!res.isError, JSON.stringify(res));
    });
    await check('read_cells with explicit indices', async () => {
        const res = await client.callTool({ name: 'read_cells', arguments: { filePath: createdUri, cellIds: [0, 1] } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /cell 0/);
    });

    // --- search_cells ---
    await check('search_cells finds source matches', async () => {
        const res = await client.callTool({ name: 'search_cells', arguments: { filePath: createdUri, query: 'x=1' } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /cell 0/);
    });
    await check('search_cells is case-insensitive by default', async () => {
        const res = await client.callTool({ name: 'search_cells', arguments: { filePath: createdUri, query: 'X=1' } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /cell 0/);
    });
    await check('search_cells honors caseSensitive', async () => {
        const res = await client.callTool({ name: 'search_cells', arguments: { filePath: createdUri, query: 'X=1', caseSensitive: true } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /No matches/);
    });
    await check('search_cells no-match message', async () => {
        const res = await client.callTool({ name: 'search_cells', arguments: { filePath: createdUri, query: 'zzz_nonexistent' } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /No matches/);
    });
    await check('search_cells rejects missing query', async () => {
        const res = await client.callTool({ name: 'search_cells', arguments: { filePath: createdUri } });
        assert.ok(res.isError);
    });

    // --- clear_cell_outputs ---
    await check('clear_cell_outputs runs without error', async () => {
        const res = await client.callTool({ name: 'clear_cell_outputs', arguments: { filePath: createdUri, cellIds: [0, 1] } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /Cleared outputs of 2 cell/);
    });
    await check('clear_cell_outputs rejects empty cellIds', async () => {
        const res = await client.callTool({ name: 'clear_cell_outputs', arguments: { filePath: createdUri, cellIds: [] } });
        assert.ok(res.isError);
    });

    // --- get_kernel_info (no Jupyter) ---
    await check('get_kernel_info reports unknown without Jupyter', async () => {
        const res = await client.callTool({ name: 'get_kernel_info', arguments: { filePath: createdUri } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /Kernel: unknown/);
    });

    await client.close();
    await bundle.deactivate();
    console.log(`\n${passed} checks passed`);
    // Delay exit so pending transport I/O settles (avoids a Windows native crash),
    // then force-exit so lingering server handles don't keep c8 alive.
    setTimeout(() => process.exit(process.exitCode || 0), 200);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
