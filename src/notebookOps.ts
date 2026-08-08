import * as vscode from 'vscode';

/**
 * Notebook operations for the Jupyter MCP server.
 * Everything here acts on the OPEN notebook documents in THIS window's extension host.
 * (Multi-window aggregation + routing lives in server.ts via the registry.)
 */

export interface EditNotebookArgs {
    filePath: string;
    /** Cell to edit/delete, or anchor for insert. Accepts cell index (number/string) or cell id. */
    cellId?: string | number;
    /** For insert: TOP | BOTTOM, or a cellId/cellIndex after which to insert. */
    editType: 'insert' | 'edit' | 'delete';
    newCode?: string;
    language?: string;
    /** Optional cell metadata to set (e.g. { tags: ["parameters"] }) — applied via NotebookEdit.updateCellMetadata. */
    metadata?: Record<string, unknown>;
    /** Whether to re-run the edited cell after applying (default true). */
    run?: boolean;
}

/** Resolve a notebook by path/URI among open jupyter notebooks in this window. */
export function findNotebook(filePath: string): vscode.NotebookDocument | undefined {
    const target = filePath.replace(/\\/g, '/').toLowerCase();
    return vscode.workspace.notebookDocuments.find((d) => {
        if (d.notebookType !== 'jupyter-notebook') {
            return false;
        }
        const fsPath = d.uri.fsPath.replace(/\\/g, '/').toLowerCase();
        const uriStr = d.uri.toString().toLowerCase();
        return fsPath === target || uriStr === target;
    });
}

/** List open jupyter notebooks in THIS window as URI strings. */
export function listOpenNotebooks(): string[] {
    return vscode.workspace.notebookDocuments
        .filter((d) => d.notebookType === 'jupyter-notebook')
        .map((d) => d.uri.toString());
}

/** Save a dirty notebook (by path) if the setting is enabled. */
export async function saveDirtyNotebook(filePath: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('jupyterMcp');
    if (!cfg.get<boolean>('saveBeforeExecute', true)) {
        return;
    }
    const nb = findNotebook(filePath);
    if (nb && nb.isDirty && !nb.isUntitled) {
        await nb.save();
    }
}

/** Apply a notebook edit via WorkspaceEdit/NotebookEdit (keeps the kernel session). */
export async function editNotebook(args: EditNotebookArgs): Promise<string> {
    const nb = findNotebook(args.filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${args.filePath}' in this window. Use get_open_notebooks to list them.`);
    }
    await saveDirtyNotebook(args.filePath);

    const edit = new vscode.WorkspaceEdit();
    const cellCount = nb.cellCount;

    const resolveIndex = (ref: string | number | undefined): number => {
        if (ref === undefined) return 0;
        if (typeof ref === 'number') {
            if (ref < 0 || ref >= cellCount) throw new Error(`Cell index ${ref} out of range (${cellCount} cells).`);
            return ref;
        }
        const s = String(ref).toUpperCase();
        if (s === 'TOP') return 0;
        if (s === 'BOTTOM') return cellCount;
        if (/^\d+$/.test(s)) {
            const n = Number(s);
            if (n < 0 || n >= cellCount) throw new Error(`Cell index ${n} out of range (${cellCount} cells).`);
            return n;
        }
        const idx = nb.getCells().findIndex((c) => String(c.document.uri) === ref || c.document.uri.fragment === ref.replace(/^#/, ''));
        if (idx === -1) {
            throw new Error(`Cell id '${ref}' not found. Use a 0-based cell index (cellId) instead, or list cells via get_notebook_summary.`);
        }
        return idx;
    };

    switch (args.editType) {
        case 'insert': {
            if (args.newCode === undefined) throw new Error('newCode is required for insert');
            const at = args.cellId === undefined ? cellCount : resolveIndex(args.cellId) + 1;
            const cell = new vscode.NotebookCellData(
                (args.language ?? 'python').toLowerCase() === 'markdown'
                    ? vscode.NotebookCellKind.Markup
                    : vscode.NotebookCellKind.Code,
                args.newCode,
                args.language ?? 'python'
            );
            if (args.metadata) {
                cell.metadata = args.metadata;
            }
            edit.set(nb.uri, [vscode.NotebookEdit.insertCells(at, [cell])]);
            break;
        }
        case 'edit': {
            if (args.newCode === undefined) throw new Error('newCode is required for edit');
            const idx = resolveIndex(args.cellId);
            const existing = nb.cellAt(idx);
            const cell = new vscode.NotebookCellData(
                existing.kind,
                args.newCode,
                args.language ?? existing.document.languageId
            );
            const edits: vscode.NotebookEdit[] = [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(idx, idx + 1), [cell])];
            if (args.metadata) {
                edits.push(vscode.NotebookEdit.updateCellMetadata(idx, args.metadata));
            }
            edit.set(nb.uri, edits);
            break;
        }
        case 'delete': {
            const idx = resolveIndex(args.cellId);
            edit.set(nb.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(idx, idx + 1))]);
            break;
        }
        default:
            throw new Error(`Unknown editType '${args.editType}' (use insert|edit|delete)`);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
        throw new Error('Failed to apply notebook edit (applyEdit returned false).');
    }

    // Optional re-run of the edited/inserted cell (awaited, so the client knows it ran).
    if (args.run !== false && args.editType !== 'delete') {
        const target = args.editType === 'insert' ? resolveIndex(args.cellId) + 1 : resolveIndex(args.cellId);
        const cell = nb.cellAt(Math.min(target, nb.cellCount - 1));
        if (cell.kind === vscode.NotebookCellKind.Code) {
            try {
                await vscode.commands.executeCommand('notebook.execute', nb.uri, [cell.document.uri]);
            } catch {
                // Re-run is best-effort; the edit itself already succeeded.
            }
        }
    }

    return `Applied ${args.editType} on ${nb.uri.toString()}.`;
}

/** Create a new notebook. With a workspace folder, writes a .ipynb file; without one (empty window), creates an untitled notebook. */
export async function createNotebook(query: string): Promise<string> {
    const cells = [
        { cell_type: 'markdown', metadata: {}, source: [`# ${query}`] },
        { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['# Add your code here'] }
    ];
    const metadata = {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' }
    };
    const nbJson = { cells, metadata, nbformat: 4, nbformat_minor: 5 };

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
        // Workspace open: write a real .ipynb file.
        const base = `notebook-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.ipynb`;
        const uri = vscode.Uri.joinPath(folder.uri, base);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(nbJson, null, 1), 'utf8'));
        await vscode.commands.executeCommand('vscode.openWith', uri, 'jupyter-notebook');
        return `Created ${uri.toString()} and opened it in the editor.`;
    }

    // Empty window (no workspace): create an untitled notebook document.
    const data = new vscode.NotebookData(cells.map((c) => new vscode.NotebookCellData(
        c.cell_type === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
        c.source.join(''),
        c.cell_type === 'markdown' ? 'markdown' : 'python'
    )));
    data.metadata = metadata as unknown as { [key: string]: unknown };
    const doc = await vscode.workspace.openNotebookDocument('jupyter-notebook', data);
    await vscode.window.showNotebookDocument(doc);
    return `Created untitled notebook ${doc.uri.toString()} and opened it in the editor (no workspace folder open).`;
}

/** Stable cell identifier: the cell's metadata.id if present, else "index:N". */
export function cellIdentifier(cell: vscode.NotebookCell, index: number): string {
    const id = (cell.metadata as Record<string, unknown> | undefined)?.id;
    return typeof id === 'string' && id.length > 0 ? id : `index:${index}`;
}

/** Ensure a cell has a metadata.id (stable anchor), returning it. Writes if missing. */
export async function ensureCellId(nb: vscode.NotebookDocument, index: number): Promise<string> {
    const cell = nb.cellAt(index);
    const existing = (cell.metadata as Record<string, unknown> | undefined)?.id;
    if (typeof existing === 'string' && existing.length > 0) {
        return existing;
    }
    const id = `cell-${Date.now().toString(36)}-${index}`;
    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, [vscode.NotebookEdit.updateCellMetadata(index, { ...(cell.metadata ?? {}), id })]);
    await vscode.workspace.applyEdit(edit);
    return id;
}

/** Resolve a cell index within a notebook from a cellId/index/TOP/BOTTOM ref. */
export function resolveCellIndex(nb: vscode.NotebookDocument, cellId: string | number | undefined): number {
    const cellCount = nb.cellCount;
    if (cellId === undefined || cellId === '' || String(cellId).toUpperCase() === 'TOP') {
        return 0;
    }
    if (String(cellId).toUpperCase() === 'BOTTOM') {
        return cellCount - 1;
    }
    if (/^\d+$/.test(String(cellId))) {
        const n = Number(cellId);
        if (n < 0 || n >= cellCount) {
            throw new Error(`Cell index ${n} out of range (notebook has ${cellCount} cells).`);
        }
        return n;
    }
    // Resolve by metadata.id anchor, then VS Code cell-URI fragment, then full URI.
    const frag = String(cellId).replace(/^#/, '');
    const idx = nb.getCells().findIndex((c, i) =>
        cellIdentifier(c, i) === String(cellId) ||
        c.document.uri.fragment === frag ||
        String(c.document.uri) === cellId
    );
    if (idx === -1) {
        throw new Error(`Cell id '${cellId}' not found. Use a 0-based cell index, or list cells via get_cells.`);
    }
    return idx;
}

/** Native summary: cells, types, languages, line counts, execution state, output mime types. */
export async function getNotebookSummary(filePath: string): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_open_notebooks to list them.`);
    }
    const lines: string[] = [`Notebook: ${nb.uri.toString()}`, `Cells: ${nb.cellCount}`];
    nb.getCells().forEach((c, i) => {
        const text = c.document.getText();
        const exec = c.executionSummary;
        const mimes = c.outputs.flatMap((o) => o.items.map((it) => it.mime)).filter(Boolean);
        lines.push(
            `${i}. ${c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown'} | lang=${c.document.languageId} | ` +
            `lines=${text.split('\n').length} | executed=${exec ? (exec.success ? 'yes' : 'error') : 'no'} | ` +
            `outputs=[${mimes.join(', ')}]`
        );
    });
    return lines.join('\n');
}

/** Native cell output: all output items (text decoded from UTF-8). */
export async function readCellOutput(filePath: string, cellId: string | number | undefined): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_open_notebooks to list them.`);
    }
    const idx = resolveCellIndex(nb, cellId);
    const cell = nb.cellAt(idx);
    const decoder = new TextDecoder();
    const parts: string[] = [];
    cell.outputs.forEach((o, oi) => {
        for (const item of o.items) {
            const text = decoder.decode(item.data);
            parts.push(`[output ${oi} | ${item.mime}]\n${text}`);
        }
    });
    if (parts.length === 0) {
        return `Cell ${idx} has no saved output.`;
    }
    return parts.join('\n\n');
}

/** Native cell source: return each requested cell's source text with index/kind/language. */
export async function getCells(filePath: string, cellIds?: Array<string | number>): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_open_notebooks to list them.`);
    }
    const idxs = cellIds && cellIds.length ? cellIds.map((c) => resolveCellIndex(nb, c)) : Array.from({ length: nb.cellCount }, (_, i) => i);
    const blocks: string[] = [];
    for (const idx of idxs) {
        const cell = nb.cellAt(idx);
        blocks.push(
            `[cell ${idx} | ${cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown'} | ${cell.document.languageId}]\n` +
            cell.document.getText()
        );
    }
    return blocks.join('\n\n');
}

/** Native multi-cell output: outputs for several cells in a notebook. */
export async function getCellsOutput(filePath: string, cellIds: Array<string | number>): Promise<string> {
    if (cellIds.length === 0) {
        throw new Error('cellIds must not be empty.');
    }
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_open_notebooks to list them.`);
    }
    const blocks: string[] = [];
    for (const c of cellIds) {
        const idx = resolveCellIndex(nb, c);
        blocks.push(`[cell ${idx} output]\n${await readCellOutput(filePath, idx)}`);
    }
    return blocks.join('\n\n');
}

/** Native save: persist dirty notebooks (by path). */
export async function saveNotebooks(filePaths: string[]): Promise<string> {
    if (filePaths.length === 0) {
        throw new Error('filePaths must not be empty.');
    }
    const saved: string[] = [];
    const skipped: string[] = [];
    for (const fp of filePaths) {
        const nb = findNotebook(fp);
        if (!nb) {
            skipped.push(`${fp} (not open)`);
        } else if (nb.isDirty && !nb.isUntitled) {
            await nb.save();
            saved.push(nb.uri.toString());
        } else {
            skipped.push(`${nb.uri.toString()} (clean or untitled)`);
        }
    }
    return `Saved: ${saved.join(', ') || '(none)'}${skipped.length ? `\nSkipped: ${skipped.join(', ')}` : ''}`;
}

/** Native kernel restart via the notebook command. */
export async function restartKernel(filePath: string): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_open_notebooks to list them.`);
    }
    await vscode.commands.executeCommand('notebook.restartKernel', nb.uri);
    return `Restarted kernel for ${nb.uri.toString()}.`;
}

/**
 * Interrupt the kernel(s) of one or more open notebooks (stops running execution).
 * Uses the notebook's interrupt command; requires the Jupyter extension.
 */
export async function interruptKernels(filePaths: string[]): Promise<string> {
    const lines: string[] = [];
    for (const fp of filePaths) {
        const nb = findNotebook(fp);
        if (!nb) {
            throw new Error(`No open notebook matches '${fp}'. Use get_notebooks to list them.`);
        }
        await vscode.commands.executeCommand('notebook.interruptKernel', nb.uri);
        lines.push(`Interrupted kernel for ${nb.uri.toString()}.`);
    }
    return lines.join('\n');
}

/**
 * Best-effort kernel info for a notebook: resolves the active kernel label via the
 * Jupyter extension's kernel API if available; falls back to 'unknown' so the tool
 * stays deterministic when the Jupyter extension is absent.
 */
export async function getKernelInfo(filePath: string): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_notebooks to list them.`);
    }
    let label = 'unknown';
    try {
        const api = await vscode.extensions.getExtension<{ getKernel?: (u: unknown) => { label?: string } }>('ms-toolsai.jupyter')?.activate();
        const kernel = api?.getKernel?.(nb.uri);
        if (kernel?.label) label = kernel.label;
    } catch {
        // best-effort
    }
    return `Notebook: ${nb.uri.toString()}\nKernel: ${label}`;
}

/** Clear saved outputs (and execution state) from one or more cells of a notebook. */
export async function clearOutputs(filePath: string, cellIds: Array<string | number>): Promise<string> {
    if (cellIds.length === 0) {
        throw new Error('cellIds must not be empty.');
    }
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_notebooks to list them.`);
    }
    const idxs = cellIds.map((c) => resolveCellIndex(nb, c));
    // Clear in reverse order so index-based edits stay valid.
    const sorted = [...idxs].sort((a, b) => b - a);
    for (const idx of sorted) {
        await vscode.commands.executeCommand('notebook.clearOutputs', nb.uri, [nb.cellAt(idx).document.uri]);
    }
    return `Cleared outputs of ${idxs.length} cell(s) in ${nb.uri.toString()}.`;
}

/** Search a notebook's cells (source + output text) for a query, returning per-cell matches. */
export function searchCells(filePath: string, query: string, caseSensitive = false, cellIds?: Array<string | number>): string {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_notebooks to list them.`);
    }
    if (!query) {
        throw new Error('query must be a non-empty string.');
    }
    const hay = (s: string) => (caseSensitive ? s : s.toLowerCase());
    const q = hay(query);
    const idxs = cellIds && cellIds.length ? cellIds.map((c) => resolveCellIndex(nb, c)) : nb.getCells().map((_, i) => i);
    const matches: string[] = [];
    for (const idx of idxs) {
        const cell = nb.cellAt(idx);
        const source = cell.document.getText();
        const srcLines = source.split('\n');
        const srcHits = srcLines.map((l, i) => (hay(l).includes(q) ? i : -1)).filter((i) => i >= 0);
        const outputHits: string[] = [];
        cell.outputs.forEach((o, oi) => {
            for (const item of o.items) {
                const text = new TextDecoder().decode(item.data);
                if (hay(text).includes(q)) outputHits.push(`output ${oi} (${item.mime})`);
            }
        });
        if (srcHits.length || outputHits.length) {
            matches.push(
                `[cell ${idx}]${srcHits.length ? ` source lines: ${srcHits.join(', ')}` : ''}` +
                (outputHits.length ? ` | ${outputHits.join(', ')}` : '')
            );
        }
    }
    return matches.length ? matches.join('\n') : `No matches for '${query}' in ${nb.uri.toString()}.`;
}

/**
 * Move one or more cells to a new position in a notebook, preserving their content,
 * outputs, and metadata. Uses a WorkspaceEdit that rebuilds the cell array in the
 * new order via NotebookEdit.replaceCells.
 *
 * @param filePath notebook URI
 * @param cellIds indices of the cells to move (in their current order)
 * @param toIndex the index the FIRST moved cell should land at
 */
export async function moveCells(filePath: string, cellIds: Array<string | number>, toIndex: number): Promise<string> {
    if (cellIds.length === 0) {
        throw new Error('cellIds must not be empty.');
    }
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_notebooks to list them.`);
    }
    await saveDirtyNotebook(filePath);

    const cellCount = nb.cellCount;
    const moving = cellIds.map((c) => resolveCellIndex(nb, c));
    // Validate + dedupe.
    const set = new Set(moving);
    if (set.size !== moving.length) {
        throw new Error('cellIds must not contain duplicates.');
    }
    const to = Number(toIndex);
    if (!Number.isInteger(to) || to < 0 || to > cellCount - moving.length) {
        throw new Error(`toIndex ${to} out of range (notebook has ${cellCount} cells, moving ${moving.length}).`);
    }

    const movingSet = new Set(moving);
    const rest = nb.getCells()
        .map((_, i) => i)
        .filter((i) => !movingSet.has(i));

    // Build the new order: insert the moving block (in its current relative order) at `to`.
    const newOrder: number[] = [];
    let inserted = false;
    for (let pos = 0; pos <= rest.length; pos++) {
        if (pos === to) {
            newOrder.push(...moving);
            inserted = true;
        }
        if (pos < rest.length) {
            newOrder.push(rest[pos]);
        }
    }
    if (!inserted) {
        newOrder.push(...moving);
    }

    // Rebuild cells in the new order, preserving kind/value/language/outputs/metadata.
    const data = newOrder.map((i) => {
        const c = nb.cellAt(i);
        const cell = new vscode.NotebookCellData(
            c.kind,
            c.document.getText(),
            c.document.languageId
        );
        cell.outputs = Array.from(c.outputs);
        cell.metadata = c.metadata;
        return cell;
    });

    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, cellCount), data)]);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
        throw new Error('Failed to apply cell move (applyEdit returned false).');
    }
    return `Moved ${moving.length} cell(s) to index ${to} in ${nb.uri.toString()}.`;
}

/** Open one or more notebooks from disk (file URIs) in VS Code. */
export async function openNotebooks(filePaths: string[]): Promise<string> {
    if (filePaths.length === 0) {
        throw new Error('filePaths must not be empty.');
    }
    const opened: string[] = [];
    for (const fp of filePaths) {
        if (!fp.startsWith('file:')) {
            throw new Error(`'${fp}' is not a file: URI. open_notebooks accepts file: URIs of notebooks on disk.`);
        }
        const uri = vscode.Uri.parse(fp);
        await vscode.workspace.openNotebookDocument(uri);
        opened.push(uri.toString());
    }
    return `Opened: ${opened.join(', ')}.`;
}

// ---- Multi-* (batch) operations ----

/** Summaries for several notebooks at once. Returns one text block per notebook. */
export async function getNotebooksSummary(filePaths: string[]): Promise<string> {
    if (filePaths.length === 0) {
        throw new Error('filePaths must not be empty.');
    }
    const blocks: string[] = [];
    for (const fp of filePaths) {
        blocks.push(await getNotebookSummary(fp));
    }
    return blocks.join('\n\n');
}

/** Parse a cell's outputs into a compact JSON-friendly structure (text/error/image). */
export function parseCellOutputs(cell: vscode.NotebookCell): Array<{ type: string; mime?: string; text?: string; name?: string; message?: string; data?: string }> {
    const decoder = new TextDecoder();
    const out: Array<{ type: string; mime?: string; text?: string; name?: string; message?: string; data?: string }> = [];
    for (const output of cell.outputs) {
        for (const item of output.items) {
            const mime = item.mime;
            if (mime === 'application/vnd.code.notebook.error') {
                try {
                    const e = JSON.parse(decoder.decode(item.data));
                    out.push({ type: 'error', name: e.name ?? 'Error', message: e.message ?? String(e) });
                } catch {
                    out.push({ type: 'error', name: 'Error', message: decoder.decode(item.data) });
                }
            } else if (mime.startsWith('image/')) {
                out.push({ type: 'image', mime, data: Buffer.from(item.data).toString('base64') });
            } else {
                out.push({ type: 'text', mime, text: decoder.decode(item.data) });
            }
        }
    }
    return out;
}

/** Signature of a cell's outputs (used to detect a fresh execution result). */
function outputSignature(cell: vscode.NotebookCell): string {
    return cell.outputs.map((o) => o.items.map((i) => `${i.mime}:${i.data.byteLength}`).join(',')).join('|');
}

/** Baseline before executing a cell, to detect when the execution actually completes. */
function executionBaseline(cell: vscode.NotebookCell): { order?: number; signature: string; hadSummary: boolean } {
    return {
        order: cell.executionSummary?.executionOrder,
        signature: outputSignature(cell),
        hadSummary: typeof cell.executionSummary?.success === 'boolean'
    };
}

/** Whether a cell shows a fresh execution result relative to a baseline taken before the run. */
function isFreshExecution(cell: vscode.NotebookCell, baseline: { order?: number; signature: string; hadSummary: boolean }, requestedAt: number): boolean {
    const s = cell.executionSummary;
    if (typeof s?.success !== 'boolean') {
        return false;
    }
    if (!baseline.hadSummary) {
        return true;
    }
    if (s.timing?.endTime !== undefined && s.timing.endTime >= requestedAt) {
        return true;
    }
    if (s.executionOrder !== undefined && s.executionOrder !== baseline.order) {
        return true;
    }
    return outputSignature(cell) !== baseline.signature;
}

/** Wait until a cell's execution completes (or timeout). Returns the updated cell. */
async function waitForCellExecution(notebook: vscode.NotebookDocument, index: number, baseline: { order?: number; signature: string; hadSummary: boolean }, requestedAt: number, timeoutMs: number): Promise<vscode.NotebookCell> {
    const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : 24 * 60 * 60 * 1000);
    while (Date.now() < deadline) {
        const cell = notebook.cellAt(index);
        if (isFreshExecution(cell, baseline, requestedAt)) {
            return cell;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Cell ${index} execution timed out.`);
}

/**
 * Run several cells in a notebook, in order, waiting for each to complete and returning
 * its outputs (success/error + parsed output items). Adopted from the pattern used by
 * vscode-runtime-notebook-mcp: poll executionSummary until the run produces a fresh result.
 * @param kernel optional kernel name/id to select before running (best-effort via notebook.selectKernel).
 */
export async function runNotebookCells(filePath: string, cellIds: Array<string | number>, kernel?: string, timeoutMs = 60000): Promise<string> {
    if (cellIds.length === 0) {
        throw new Error('cellIds must not be empty.');
    }
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_notebooks to list them.`);
    }
    await saveDirtyNotebook(filePath);

    // Optional kernel selection (best-effort; non-fatal if it fails or isn't found).
    if (kernel) {
        try {
            await vscode.commands.executeCommand('notebook.selectKernel', { notebookEditor: nb.uri, kernelInfo: { label: kernel } });
        } catch {
            // Non-fatal: execution proceeds with the current kernel.
        }
    }

    const indices = cellIds.map((c) => resolveCellIndex(nb, c));
    for (const idx of indices) {
        if (nb.cellAt(idx).kind !== vscode.NotebookCellKind.Code) {
            throw new Error(`Cell ${idx} is not a code cell; only code cells can be executed.`);
        }
    }

    const results: string[] = [];
    for (const idx of indices) {
        // Ensure the cell has a stable id anchor so references survive reordering.
        await ensureCellId(nb, idx);
        const baseline = executionBaseline(nb.cellAt(idx));
        const requestedAt = Date.now();
        await vscode.commands.executeCommand('notebook.execute', nb.uri, [nb.cellAt(idx).document.uri]);
        const cell = await waitForCellExecution(nb, idx, baseline, requestedAt, timeoutMs);
        const outputs = parseCellOutputs(cell);
        const status = cell.executionSummary?.success ? 'success' : 'error';
        results.push(
            `[cell ${idx}] ${status}${cell.executionSummary?.executionOrder !== undefined ? ` (execution #${cell.executionSummary.executionOrder})` : ''}\n` +
            (outputs.length ? outputs.map((o) => o.type === 'text' ? o.text : o.type === 'error' ? `Error: ${o.name}: ${o.message}` : `[image ${o.mime} ${(o.data ?? '').length} bytes]`).join('') : '(no output)')
        );
    }
    return results.join('\n');
}

/** Apply several edits to a notebook, in order. Each edit omits filePath (added internally). */
export async function editNotebookCells(filePath: string, edits: Array<Omit<EditNotebookArgs, 'filePath'>>): Promise<string> {
    if (edits.length === 0) {
        throw new Error('edits must not be empty.');
    }
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_open_notebooks to list them.`);
    }
    await saveDirtyNotebook(filePath);
    const lines: string[] = [];
    for (const e of edits) {
        lines.push(await editNotebook({ ...e, filePath }));
    }
    return `Applied ${edits.length} edit(s):\n${lines.join('\n')}`;
}

/**
 * Read a whole notebook in one call: per cell, index, stable cell_id anchor, kind,
 * language, source, line count, execution state, and outputs (text/error/image).
 * Adapted from the whole-notebook read in vscode-inmemory-notebook-mcp.
 */
export async function readNotebook(filePath: string, opts: { includeOutputs?: boolean; cellIds?: Array<string | number> } = {}): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_notebooks to list them.`);
    }
    const selected = opts.cellIds && opts.cellIds.length
        ? opts.cellIds.map((c) => resolveCellIndex(nb, c))
        : nb.getCells().map((_, i) => i);

    const blocks: string[] = [`Notebook: ${nb.uri.toString()}`, `Cells: ${nb.cellCount}`];
    for (const idx of selected) {
        const cell = nb.cellAt(idx);
        const exec = cell.executionSummary;
        const id = cellIdentifier(cell, idx);
        blocks.push(
            `[cell ${idx} | id:${id} | ${cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown'} | ${cell.document.languageId} | ` +
            `executed:${exec ? (exec.success ? 'yes' : 'error') : 'no'}${exec?.executionOrder !== undefined ? ` (#${exec.executionOrder})` : ''}]`
        );
        blocks.push(cell.document.getText());
        if (opts.includeOutputs) {
            const outputs = parseCellOutputs(cell);
            if (outputs.length) {
                blocks.push('[output]');
                blocks.push(outputs.map((o) => o.type === 'text' ? o.text : o.type === 'error' ? `Error: ${o.name}: ${o.message}` : `[image ${o.mime} ${(o.data ?? '').length} bytes]`).join(''));
            }
        }
        blocks.push('');
    }
    return blocks.join('\n');
}

/**
 * Export a notebook to markdown, python, or html. Adapted from vscode-inmemory-notebook-mcp.
 * Returns the rendered content.
 */
export async function exportNotebook(filePath: string, format: 'markdown' | 'python' | 'html'): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use get_notebooks to list them.`);
    }
    if (format === 'python') {
        return nb.getCells().map((cell) => {
            const text = cell.document.getText();
            if (cell.kind === vscode.NotebookCellKind.Markup) {
                return `# %% [markdown]\n${text.split('\n').map((l) => `# ${l}`).join('\n')}`;
            }
            return `# %%\n${text}`;
        }).join('\n\n');
    }
    if (format === 'html') {
        const body = nb.getCells().map((cell) => {
            const tag = cell.kind === vscode.NotebookCellKind.Markup ? 'section' : 'pre';
            const text = cell.document.getText()
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<${tag} data-cell-index="${cell.index}">${text}</${tag}>`;
        }).join('\n');
        return `<!doctype html>\n<html><body>\n${body}\n</body></html>\n`;
    }
    // markdown
    return nb.getCells().map((cell) => {
        const text = cell.document.getText();
        return cell.kind === vscode.NotebookCellKind.Code
            ? `\`\`\`${cell.document.languageId}\n${text}\n\`\`\``
            : text;
    }).join('\n\n');
}
