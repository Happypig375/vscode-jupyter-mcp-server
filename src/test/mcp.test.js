// Deterministic MCP integration test: loads the compiled extension bundle with a
// minimal vscode shim (empty window, no workspace, no Jupyter extension) and exercises
// every tool over a real MCP HTTP connection. No GUI, no VS Code download — CI-safe.
'use strict';
const path = require('path');
const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ROOT = path.resolve(__dirname, '..', '..');

// ---- Minimal vscode shim: EMPTY WINDOW (no workspace folders, no Jupyter) ----
const lines = [];
const statusBar = { text: '', tooltip: '', command: '', show() {}, dispose() {} };
const disposables = [];
const executed = [];
let untitledCounter = 0;
const openNotebooks = []; // simulates open notebook documents

// Each entry: { uri, cells: [{ kind, value, languageId }] }
function makeDoc(type, data) {
    const uri = `untitled:Untitled-${++untitledCounter}.ipynb`;
    const cells = data.cells.map((c, i) => ({
        kind: c.kind, value: c.value, languageId: c.languageId
    }));
    const doc = {
        notebookType: type,
        uri: { fsPath: '', toString: () => uri },
        isDirty: false, isUntitled: true,
        get cellCount() { return cells.length; },
        cellAt: (i) => ({
            kind: cells[i].kind,
            document: { uri: { fragment: `c${i}` }, languageId: cells[i].languageId, getText: () => cells[i].value },
            outputs: [], executionSummary: undefined, metadata: {}
        }),
        getCells: () => cells.map((c, i) => ({
            kind: c.kind,
            document: { uri: { fragment: `c${i}` }, languageId: c.languageId, getText: () => c.value },
            outputs: [], executionSummary: undefined, metadata: {}
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
            if (k === 'port') return 51303;
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
                        const newCells = op.cells.map((c) => ({ kind: c.kind, value: c.value, languageId: c.languageId }));
                        doc._cells.splice(op.range[0], op.range[1] - op.range[0], ...newCells);
                    } else if (op.__kind === 'insert') {
                        const newCells = op.cells.map((c) => ({ kind: c.kind, value: c.value, languageId: c.languageId }));
                        doc._cells.splice(op.index, 0, ...newCells);
                    } else if (op.__kind === 'delete') {
                        doc._cells.splice(op.range[0], op.range[1] - op.range[0]);
                    } else if (op.__kind === 'updateMeta') {
                        // metadata no-op in shim
                    }
                }
            }
            return true;
        },
        openNotebookDocument: async (type, data) => makeDoc(type, data),
        onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: {
        createOutputChannel: () => ({ appendLine: (l) => { lines.push(l); console.log('[OUT]', l); }, dispose() {} }),
        createStatusBarItem: () => statusBar,
        showNotebookDocument: async () => {}
    },
    extensions: { getExtension: () => undefined, onDidChange: () => ({ dispose() {} }) },
    commands: {
        registerCommand: () => ({ dispose() {} }),
        executeCommand: async (cmd, ...args) => { if (cmd === 'notebook.execute') executed.push(args); }
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
    NotebookData: class { constructor(cells) { this.cells = cells; } },
    NotebookCellData: class { constructor(kind, value, lang) { this.kind = kind; this.value = value; this.languageId = lang; } },
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookRange: class { constructor(a, b) { this.a = a; this.b = b; } },
    Uri: { joinPath: (base, name) => ({ toString: () => `file:///C:/repo/${name}`, fsPath: `C:/repo/${name}` }) }
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
            const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:51303/mcp'));
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

    // 1. No Jupyter -> kernel tools absent, document tools present.
    await check('tool set (no Jupyter)', async () => {
        for (const required of ['create_notebook', 'get_notebooks', 'get_cells', 'get_cells_source', 'get_cells_output', 'edit_cells', 'move_cells', 'open_notebooks', 'save_notebooks']) {
            assert.ok(names.includes(required), `missing ${required}`);
        }
        assert.ok(!names.includes('run_cells'), 'run_cells should be absent without Jupyter');
        assert.ok(!names.includes('restart_notebooks'), 'restart_notebooks should be absent without Jupyter');
    });

    // 2. create_notebook in an empty window -> untitled.
    const created = await client.callTool({ name: 'create_notebook', arguments: { query: 'Test notebook' } });
    const createdText = created.content[0].text;
    console.log(`  create_notebook -> ${createdText}`);
    assert.ok(!created.isError, JSON.stringify(created));
    assert.match(createdText, /untitled/);
    const createdUri = createdText.match(/untitled:[^\s]+/)[0];
    passed++;

    // 3. get_notebooks lists it.
    await check('get_notebooks lists the created notebook', async () => {
        const res = await client.callTool({ name: 'get_notebooks', arguments: {} });
        const parsed = JSON.parse(res.content[0].text);
        assert.ok(parsed.some((n) => n.uri === createdUri), `not listed: ${res.content[0].text}`);
    });

    // 4. get_cells_source.
    await check('get_cells_source reads cells', async () => {
        const res = await client.callTool({ name: 'get_cells_source', arguments: { filePath: createdUri, cellIds: [0, 1] } });
        assert.match(res.content[0].text, /Test notebook/);
        assert.match(res.content[0].text, /Add your code here/);
    });

    // 5. get_cells metadata.
    await check('get_cells returns metadata', async () => {
        const res = await client.callTool({ name: 'get_cells', arguments: { filePaths: [createdUri] } });
        assert.match(res.content[0].text, /Cells: 2/);
        assert.match(res.content[0].text, /markdown/);
    });

    // 6. edit_cells (no re-run without Jupyter).
    await check('edit_cells edits a cell', async () => {
        const res = await client.callTool({ name: 'edit_cells', arguments: { filePath: createdUri, edits: [{ cellId: 1, editType: 'edit', newCode: 'print("edited")' }] } });
        assert.ok(!res.isError, JSON.stringify(res));
        const src = await client.callTool({ name: 'get_cells_source', arguments: { filePath: createdUri, cellIds: [1] } });
        assert.match(src.content[0].text, /edited/);
    });

    // 7. move_cells.
    await check('move_cells reorders cells', async () => {
        const res = await client.callTool({ name: 'move_cells', arguments: { filePath: createdUri, cellIds: [0], toIndex: 1 } });
        assert.ok(!res.isError, JSON.stringify(res));
    });

    // 8. get_cells_output graceful.
    await check('get_cells_output handles empty output', async () => {
        const res = await client.callTool({ name: 'get_cells_output', arguments: { filePath: createdUri, cellIds: [0] } });
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

    // --- Validation / error branches ---
    const expectError = (name, tool, args, re) => check(name, async () => {
        const res = await client.callTool({ name: tool, arguments: args });
        assert.ok(res.isError, `${tool} should error on ${JSON.stringify(args)}`);
        if (re) assert.match(res.content[0].text, re);
    });
    await expectError('edit_cells rejects missing edits', 'edit_cells', { filePath: 'x' });
    await expectError('edit_cells rejects bad editType', 'edit_cells', { filePath: 'x', edits: [{ cellId: 0, editType: 'bogus' }] });
    await expectError('get_cells_output rejects empty cellIds', 'get_cells_output', { filePath: 'x', cellIds: [] });
    await expectError('get_cells rejects missing filePath', 'get_cells', {});
    await expectError('get_cells rejects empty filePaths', 'get_cells', { filePaths: [] });
    await expectError('move_cells rejects empty cellIds', 'move_cells', { filePath: 'x', cellIds: [], toIndex: 0 });
    await expectError('move_cells rejects bad toIndex', 'move_cells', { filePath: 'x', cellIds: [0], toIndex: 'a' });
    await expectError('save_notebooks rejects empty filePaths', 'save_notebooks', { filePaths: [] });

    // --- edit_cells insert / delete / metadata on the created notebook ---
    await check('edit_cells inserts a cell', async () => {
        const res = await client.callTool({ name: 'edit_cells', arguments: { filePath: createdUri, edits: [{ cellId: 0, editType: 'insert', newCode: 'print("inserted")' }] } });
        assert.ok(!res.isError, JSON.stringify(res));
        const meta = await client.callTool({ name: 'get_cells', arguments: { filePaths: [createdUri] } });
        assert.match(meta.content[0].text, /Cells: 3/);
    });
    await check('edit_cells deletes a cell', async () => {
        const res = await client.callTool({ name: 'edit_cells', arguments: { filePath: createdUri, edits: [{ cellId: 0, editType: 'delete' }] } });
        assert.ok(!res.isError, JSON.stringify(res));
        const meta = await client.callTool({ name: 'get_cells', arguments: { filePaths: [createdUri] } });
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
    await check('get_cells_source defaults to all cells', async () => {
        const res = await client.callTool({ name: 'get_cells_source', arguments: { filePath: createdUri } });
        assert.ok(!res.isError, JSON.stringify(res));
    });
    await check('get_cells_source with explicit indices', async () => {
        const res = await client.callTool({ name: 'get_cells_source', arguments: { filePath: createdUri, cellIds: [0, 1] } });
        assert.ok(!res.isError, JSON.stringify(res));
        assert.match(res.content[0].text, /cell 0/);
    });

    await client.close();
    await bundle.deactivate();
    console.log(`\n${passed} checks passed`);
    // Delay exit so pending transport I/O settles (avoids a Windows native crash),
    // then force-exit so lingering server handles don't keep c8 alive.
    setTimeout(() => process.exit(process.exitCode || 0), 200);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
