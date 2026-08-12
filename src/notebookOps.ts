import * as vscode from 'vscode';

/**
 * Notebook operations for the Jupyter MCP server.
 * Everything here acts on the open notebook documents in this extension host.
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
    /** Whether to re-run the edited cell after applying (default false). */
    run?: boolean;
}

export type OutputMode = 'summary' | 'text' | 'full';

export interface OutputOptions {
    /** summary=mime/size only; text=one preferred textual representation; full=all text representations. */
    mode?: OutputMode;
    /** Maximum returned output characters per cell. Clamped to 1,000..100,000. */
    maxChars?: number;
}

export interface RunCellsOptions extends OutputOptions {
    /** Legacy best-effort kernel label/id hint. Use select_kernel for exact selection. */
    kernel?: string;
    timeoutMs?: number;
    /** Return immediately after queueing all selected cells. */
    wait?: boolean;
    /** Include compact saved outputs in completed-cell results (default true). */
    includeOutputs?: boolean;
}

export interface NotebookKernelInfo {
    /** Stable controller id, including the contributing extension prefix. */
    id: string;
    label: string;
    description?: string;
    detail?: string;
    extension: string;
}

interface ResolvedNotebookKernel {
    id?: string;
    label: string;
    description?: string;
    detail?: string;
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
        throw new Error(`No open notebook matches '${args.filePath}' in this window. Use list_notebooks to list them.`);
    }
    await saveDirtyNotebook(args.filePath);

    const edit = new vscode.WorkspaceEdit();
    let affectedIndex: number | undefined;

    switch (args.editType) {
        case 'insert': {
            if (args.newCode === undefined) throw new Error('newCode is required for insert');
            const at = resolveInsertionIndex(nb, args.cellId);
            affectedIndex = at;
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
            const idx = resolveCellIndex(nb, args.cellId);
            affectedIndex = idx;
            const existing = nb.cellAt(idx);
            const cell = new vscode.NotebookCellData(
                existing.kind,
                args.newCode,
                args.language ?? existing.document.languageId
            );
            cell.metadata = { ...(existing.metadata ?? {}), ...(args.metadata ?? {}) };
            edit.set(nb.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(idx, idx + 1), [cell])]);
            break;
        }
        case 'delete': {
            const idx = resolveCellIndex(nb, args.cellId);
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

    // Re-run only when explicitly requested. Editing should not unexpectedly start a long kernel job.
    if (args.run === true && args.editType !== 'delete' && affectedIndex !== undefined) {
        const cell = nb.cellAt(Math.min(affectedIndex, nb.cellCount - 1));
        if (cell.kind === vscode.NotebookCellKind.Code) {
            try {
                await vscode.commands.executeCommand('notebook.execute', nb.uri, [cell.document.uri]);
            } catch {
                // Re-run is best-effort; the edit itself already succeeded.
            }
        }
    }

    return `Applied ${args.editType} on ${nb.uri.toString()}. Cells now: ${nb.cellCount}.`;
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

/** Best available cell anchor without mutating the notebook. */
export function cellIdentifier(cell: vscode.NotebookCell, index: number): string {
    const id = (cell.metadata as Record<string, unknown> | undefined)?.id;
    if (typeof id === 'string' && id.length > 0) return id;
    const fragment = cell.document.uri.fragment;
    return fragment ? `#${fragment}` : `index:${index}`;
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
        throw new Error(`Cell id '${cellId}' not found. Use a 0-based cell index, or inspect the notebook via inspect_notebooks.`);
    }
    return idx;
}

/** Resolve the insertion point: TOP=0, BOTTOM/undefined=end, any other ref=after that cell. */
export function resolveInsertionIndex(nb: vscode.NotebookDocument, cellId: string | number | undefined): number {
    if (cellId === undefined || String(cellId).toUpperCase() === 'BOTTOM') return nb.cellCount;
    if (String(cellId).toUpperCase() === 'TOP') return 0;
    return resolveCellIndex(nb, cellId) + 1;
}

function executionState(cell: vscode.NotebookCell): string {
    if (cell.kind !== vscode.NotebookCellKind.Code) return 'n/a';
    const success = cell.executionSummary?.success;
    if (success === true) return 'success';
    if (success === false) return 'error';
    return 'not-run';
}

/** Native summary: cells, types, languages, line counts, execution state, output mime types. */
export async function getNotebookSummary(filePath: string): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
    }
    const lines: string[] = [`Notebook: ${nb.uri.toString()}`, `Cells: ${nb.cellCount}`];
    nb.getCells().forEach((c, i) => {
        const text = c.document.getText();
        const mimes = c.outputs.flatMap((o) => o.items.map((it) => it.mime)).filter(Boolean);
        lines.push(
            `${i}. id=${cellIdentifier(c, i)} | ${c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown'} | lang=${c.document.languageId} | ` +
            `lines=${text.split('\n').length} | state=${executionState(c)} | ` +
            `outputs=[${mimes.join(', ')}]`
        );
    });
    return lines.join('\n');
}

const PREFERRED_TEXT_MIMES = [
    'text/markdown',
    'text/plain',
    'application/vnd.code.notebook.stdout',
    'application/vnd.code.notebook.stderr',
    'application/json',
    'text/html'
];

function clampMaxChars(value: number | undefined): number {
    if (!Number.isFinite(value)) return 12_000;
    return Math.max(1_000, Math.min(100_000, Math.trunc(value!)));
}

function isTextMime(mime: string): boolean {
    return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/vnd.code.notebook.stdout' || mime === 'application/vnd.code.notebook.stderr';
}

function decodeError(data: Uint8Array): string {
    const raw = new TextDecoder().decode(data);
    try {
        const error = JSON.parse(raw) as { name?: string; message?: string };
        return `Error: ${error.name ?? 'Error'}: ${error.message ?? raw}`;
    } catch {
        return `Error: ${raw}`;
    }
}

/** Format outputs without decoding binary images or duplicating rich display representations. */
export function formatCellOutputs(cell: vscode.NotebookCell, options: OutputOptions = {}): string {
    const mode = options.mode ?? 'text';
    const maxChars = clampMaxChars(options.maxChars);
    const decoder = new TextDecoder();
    const parts: string[] = [];
    for (let oi = 0; oi < cell.outputs.length; oi++) {
        const items = cell.outputs[oi].items;
        if (mode === 'summary') {
            parts.push(`[output ${oi}: ${items.map((item) => `${item.mime} ${item.data.byteLength} bytes`).join(', ')}]`);
            continue;
        }
        const errors = items.filter((item) => item.mime === 'application/vnd.code.notebook.error');
        for (const item of errors) parts.push(`[output ${oi} | ${item.mime}]\n${decodeError(item.data)}`);
        const textItems = items.filter((item) => isTextMime(item.mime));
        const selected = mode === 'full'
            ? textItems
            : PREFERRED_TEXT_MIMES.map((mime) => textItems.find((item) => item.mime === mime)).filter((item): item is vscode.NotebookCellOutputItem => Boolean(item)).slice(0, 1);
        for (const item of selected) parts.push(`[output ${oi} | ${item.mime}]\n${decoder.decode(item.data)}`);
        for (const item of items.filter((item) => item.mime.startsWith('image/'))) {
            parts.push(`[output ${oi} | ${item.mime} | ${item.data.byteLength} bytes omitted]`);
        }
        if (!errors.length && !selected.length && !items.some((item) => item.mime.startsWith('image/'))) {
            parts.push(`[output ${oi}: ${items.map((item) => `${item.mime} ${item.data.byteLength} bytes`).join(', ')}]`);
        }
    }
    if (parts.length === 0) return '(no saved output)';
    const joined = parts.join('\n\n');
    return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}\n… [truncated at ${maxChars} characters]`;
}

/** Native cell output with compact, bounded formatting. */
export async function readCellOutput(filePath: string, cellId: string | number | undefined, options: OutputOptions = {}): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
    }
    const idx = resolveCellIndex(nb, cellId);
    const cell = nb.cellAt(idx);
    return cell.outputs.length ? formatCellOutputs(cell, options) : `Cell ${idx} has no saved output.`;
}

/** Native cell source: return each requested cell's source text with index/kind/language. */
export async function getCells(filePath: string, cellIds?: Array<string | number>): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
    }
    const idxs = cellIds && cellIds.length ? cellIds.map((c) => resolveCellIndex(nb, c)) : Array.from({ length: nb.cellCount }, (_, i) => i);
    const blocks: string[] = [];
    for (const idx of idxs) {
        const cell = nb.cellAt(idx);
        blocks.push(
            `[cell ${idx} | id:${cellIdentifier(cell, idx)} | ${cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown'} | ${cell.document.languageId}]\n` +
            cell.document.getText()
        );
    }
    return blocks.join('\n\n');
}

/** Native multi-cell output: outputs for several cells in a notebook. */
export async function getCellsOutput(filePath: string, cellIds: Array<string | number>, options: OutputOptions = {}): Promise<string> {
    if (cellIds.length === 0) {
        throw new Error('cellIds must not be empty.');
    }
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
    }
    const blocks: string[] = [];
    for (const c of cellIds) {
        const idx = resolveCellIndex(nb, c);
        blocks.push(`[cell ${idx} output]\n${await readCellOutput(filePath, idx, options)}`);
    }
    return blocks.join('\n\n');
}

/**
 * Native save: persist file-backed notebooks even when VS Code reports them clean.
 *
 * Remote-kernel execution can update cell outputs/execution summaries without reliably
 * toggling NotebookDocument.isDirty. Calling save() unconditionally is therefore
 * intentional: the serializer, not the dirty bit, is the source of truth for an explicit
 * save request.
 */
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
        } else if (nb.isUntitled) {
            skipped.push(`${nb.uri.toString()} (untitled)`);
        } else {
            await forceSaveNotebook(nb);
            saved.push(nb.uri.toString());
        }
    }
    return `Saved: ${saved.join(', ') || '(none)'}${skipped.length ? `\nSkipped: ${skipped.join(', ')}` : ''}`;
}

/** Native kernel restart via the notebook command. */
export async function restartKernel(filePath: string): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
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
            throw new Error(`No open notebook matches '${fp}'. Use list_notebooks to list them.`);
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
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
    }
    let label = 'unknown';
    try {
        type ActiveKernel = { label?: string; language?: string; status?: string };
        type JupyterApi = {
            /** Compatibility with older Jupyter extension exports. */
            getKernel?: (u: vscode.Uri) => ActiveKernel | undefined;
            kernels?: { getKernel(u: vscode.Uri): Thenable<ActiveKernel | undefined> };
        };
        const api = await vscode.extensions.getExtension<JupyterApi>('ms-toolsai.jupyter')?.activate();
        const kernel = api?.kernels
            ? await api.kernels.getKernel(nb.uri)
            : api?.getKernel?.(nb.uri);
        if (kernel?.label) {
            label = kernel.label;
        } else if (kernel?.language) {
            label = `${kernel.language}${kernel.status ? ` (${kernel.status})` : ''}`;
        }
    } catch {
        // best-effort
    }
    return `Notebook: ${nb.uri.toString()}\nKernel: ${label}`;
}

/** Enumerate registered notebook controllers, optionally configuring providers first. */
export async function listKernels(filePath: string, configure = false): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
    }
    const startup = configure ? await invokeJupyterConfigureTool(nb) : undefined;
    const kernels = await resolveNotebookKernels(nb);
    return JSON.stringify({
        notebook: nb.uri.toString(),
        ...(startup ? {
            configuration: {
                status: startup.pending ? 'pending' : 'configured',
                detail: startup.detail
            }
        } : {}),
        kernels
    }, null, 2);
}

/** Force serialization when remote output changes did not set isDirty. */
async function forceSaveNotebook(nb: vscode.NotebookDocument): Promise<void> {
    if (nb.isUntitled) {
        throw new Error(`Cannot force-save untitled notebook ${nb.uri.toString()}.`);
    }
    if (!nb.isDirty) {
        const originalMetadata = { ...nb.metadata };
        const touch = new vscode.WorkspaceEdit();
        touch.set(nb.uri, [vscode.NotebookEdit.updateNotebookMetadata({
            ...originalMetadata,
            __jupyterMcpForceSave: `jupyter-mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`
        })]);
        if (!await vscode.workspace.applyEdit(touch)) {
            throw new Error(`Failed to mark ${nb.uri.toString()} for force-save.`);
        }
        const restore = new vscode.WorkspaceEdit();
        restore.set(nb.uri, [vscode.NotebookEdit.updateNotebookMetadata(originalMetadata)]);
        if (!await vscode.workspace.applyEdit(restore)) {
            throw new Error(`Failed to restore notebook metadata before saving ${nb.uri.toString()}.`);
        }
    }
    const didSave = await nb.save();
    if (!didSave) {
        throw new Error(`VS Code failed to save ${nb.uri.toString()}.`);
    }
}

/**
 * Select an exact controller id returned by list_kernels and optionally ask the Jupyter
 * extension to start it. Controller discovery is owned by VS Code, so providers added by
 * other extensions (including Colab) participate without provider-specific integration.
 */
export async function selectKernel(filePath: string, kernelId: string, start = false): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
    }
    if (!kernelId) throw new Error('kernelId is required');

    const kernels = await resolveNotebookKernels(nb);
    const kernel = kernels.find((candidate) => candidate.id === kernelId);
    if (!kernel) {
        const available = kernels.map((candidate) => candidate.id).join(', ') || '(none)';
        throw new Error(`Kernel '${kernelId}' is not available for ${nb.uri.toString()}. Available kernel ids: ${available}`);
    }

    // Kernel selection is scoped to the active notebook editor. Bring the requested
    // document forward, then use the exact extension/controller pair resolved by VS Code.
    await vscode.window.showNotebookDocument(nb, { preview: false, preserveFocus: false });
    const slash = kernel.id.indexOf('/');
    const selected = await vscode.commands.executeCommand<boolean>('_notebook.selectKernel', {
        id: kernel.id.slice(slash + 1),
        extension: kernel.extension
    });
    if (selected !== true) {
        throw new Error(`VS Code did not select kernel '${kernel.id}' for ${nb.uri.toString()}.`);
    }

    if (!start) {
        return `Selected kernel '${kernel.label}' (${kernel.id}) for ${nb.uri.toString()}.`;
    }

    const startup = await invokeJupyterConfigureTool(nb);
    if (startup.pending) {
        return `Selected kernel '${kernel.label}' (${kernel.id}) for ${nb.uri.toString()}. Startup was requested and is still pending.${startup.detail ? `\n${startup.detail}` : ''}`;
    }
    return `Selected and started kernel '${kernel.label}' (${kernel.id}) for ${nb.uri.toString()}.${startup.detail ? `\n${startup.detail}` : ''}`;
}

async function invokeJupyterConfigureTool(nb: vscode.NotebookDocument): Promise<{ detail: string; pending: boolean }> {
    const extension = vscode.extensions.getExtension('ms-toolsai.jupyter');
    if (extension && !extension.isActive) await extension.activate();

    const configureTool = vscode.lm.tools.find((tool) => tool.name === 'configure_notebook');
    if (!configureTool) {
        throw new Error(
            'The Jupyter `configure_notebook` tool is unavailable. Update or enable the Jupyter extension, ' +
            'or run a cell to start the currently selected kernel.'
        );
    }
    const result = await vscode.lm.invokeTool(
        configureTool.name,
        { input: { filePath: nb.uri.fsPath }, toolInvocationToken: undefined }
    );
    const detail = result.content
        .map((part) => typeof (part as { value?: unknown }).value === 'string' ? (part as { value: string }).value : '')
        .filter(Boolean)
        .join('\n');
    if (/did not select|failed|error/i.test(detail)) {
        throw new Error(`Jupyter could not configure a kernel for ${nb.uri.toString()}: ${detail}`);
    }
    return {
        detail,
        pending: /taking longer|still starting|in the background|timed out|timeout/i.test(detail)
    };
}

async function resolveNotebookKernels(nb: vscode.NotebookDocument): Promise<NotebookKernelInfo[]> {
    const extension = vscode.extensions.getExtension('ms-toolsai.jupyter');
    if (extension && !extension.isActive) await extension.activate();

    let resolved: ResolvedNotebookKernel[];
    try {
        resolved = await vscode.commands.executeCommand<ResolvedNotebookKernel[]>('_resolveNotebookKernels', {
            viewType: nb.notebookType,
            uri: nb.uri
        }) ?? [];
    } catch (error) {
        throw new Error(`VS Code could not enumerate kernels for ${nb.uri.toString()}: ${String(error)}`);
    }

    return resolved.flatMap((kernel) => {
        if (!kernel.id || !kernel.id.includes('/')) return [];
        return [{
            id: kernel.id,
            label: kernel.label,
            description: kernel.description,
            detail: kernel.detail,
            extension: kernel.id.slice(0, kernel.id.indexOf('/'))
        }];
    });
}

/** Clear saved outputs (and execution state) from one or more cells of a notebook. */
export async function clearOutputs(filePath: string, cellIds: Array<string | number>): Promise<string> {
    if (cellIds.length === 0) {
        throw new Error('cellIds must not be empty.');
    }
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
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
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
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
                if (item.mime === 'application/vnd.code.notebook.error' || isTextMime(item.mime)) {
                    const text = new TextDecoder().decode(item.data);
                    if (hay(text).includes(q)) outputHits.push(`output ${oi} (${item.mime})`);
                }
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
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
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
    const revealed: string[] = [];
    for (const fp of filePaths) {
        if (!fp.startsWith('file:')) {
            throw new Error(`'${fp}' is not a file: URI. open_notebooks accepts file: URIs of notebooks on disk.`);
        }
        const uri = vscode.Uri.parse(fp);
        const existing = findNotebook(uri.toString());
        if (existing) {
            await vscode.window.showNotebookDocument(existing, { preview: false });
            revealed.push(existing.uri.toString());
            continue;
        }
        const notebook = await vscode.workspace.openNotebookDocument(uri);
        await vscode.window.showNotebookDocument(notebook, { preview: false });
        opened.push(notebook.uri.toString());
    }
    const lines: string[] = [];
    if (opened.length) lines.push(`Opened from disk: ${opened.join(', ')}.`);
    if (revealed.length) lines.push(`Already open; preserved live document: ${revealed.join(', ')}.`);
    return lines.join('\n');
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

/** Wait until a cell completes. A timeout is a non-error because the kernel may still be running. */
async function waitForCellExecution(notebook: vscode.NotebookDocument, index: number, baseline: { order?: number; signature: string; hadSummary: boolean }, requestedAt: number, timeoutMs: number): Promise<vscode.NotebookCell | undefined> {
    const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : 24 * 60 * 60 * 1000);
    while (Date.now() < deadline) {
        const cell = notebook.cellAt(index);
        if (isFreshExecution(cell, baseline, requestedAt)) {
            return cell;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
}

/**
 * Run several cells in a notebook, in order, waiting for each to complete and returning
 * its outputs (success/error + parsed output items). Adopted from the pattern used by
 * vscode-runtime-notebook-mcp: poll executionSummary until the run produces a fresh result.
 * @param kernel legacy optional label/id hint, selected best-effort for compatibility.
 * Use select_kernel before run_cells for exact, fail-closed selection.
 */
export async function runNotebookCells(filePath: string, cellIds: Array<string | number>, options: RunCellsOptions = {}): Promise<string> {
    if (cellIds.length === 0) {
        throw new Error('cellIds must not be empty.');
    }
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
    }
    await saveDirtyNotebook(filePath);

    // Preserve the pre-v0.2.2 best-effort kernel hint. Exact fail-closed selection is
    // available through select_kernel and must be performed as a separate call.
    if (options.kernel) {
        try {
            await vscode.commands.executeCommand('notebook.selectKernel', {
                notebookEditor: nb.uri,
                kernelInfo: { label: options.kernel }
            });
        } catch {
            // Compatibility behavior: execution proceeds with the current kernel.
        }
    }

    const indices = cellIds.map((c) => resolveCellIndex(nb, c));
    for (const idx of indices) {
        if (nb.cellAt(idx).kind !== vscode.NotebookCellKind.Code) {
            throw new Error(`Cell ${idx} is not a code cell; only code cells can be executed.`);
        }
    }

    if (options.wait === false) {
        await vscode.commands.executeCommand('notebook.execute', nb.uri, indices.map((idx) => nb.cellAt(idx).document.uri));
        return `Queued ${indices.length} cell(s) in ${nb.uri.toString()}: ${indices.join(', ')}. Use inspect_notebooks or read_cell_outputs to inspect progress.`;
    }

    const results: string[] = [];
    for (const idx of indices) {
        const baseline = executionBaseline(nb.cellAt(idx));
        const requestedAt = Date.now();
        await vscode.commands.executeCommand('notebook.execute', nb.uri, [nb.cellAt(idx).document.uri]);
        const cell = await waitForCellExecution(nb, idx, baseline, requestedAt, options.timeoutMs ?? 60_000);
        if (!cell) {
            results.push(`[cell ${idx}] still running after ${options.timeoutMs ?? 60_000} ms. Execution was not interrupted.`);
            break;
        }
        const status = cell.executionSummary?.success === true ? 'success' : 'error';
        const output = options.includeOutputs === false ? '' : `\n${formatCellOutputs(cell, options)}`;
        results.push(
            `[cell ${idx}] ${status}${cell.executionSummary?.executionOrder !== undefined ? ` (execution #${cell.executionSummary.executionOrder})` : ''}\n` +
            output.trimStart()
        );
    }
    // Do not trust isDirty here. Some remote providers update outputs and execution
    // summaries in the live notebook model without marking the document dirty.
    if (!nb.isUntitled) {
        await forceSaveNotebook(nb);
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
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
    }
    const lines: string[] = [];
    for (const e of edits) {
        lines.push(await editNotebook({ ...e, filePath }));
    }
    return `Applied ${edits.length} edit(s):\n${lines.join('\n')}`;
}

/**
 * Read a whole notebook in one call: per cell, index, stable cell_id anchor, kind,
 * language, source, line count, execution state, and compact outputs.
 * Adapted from the whole-notebook read in vscode-inmemory-notebook-mcp.
 */
export async function readNotebook(filePath: string, opts: { includeOutputs?: boolean; cellIds?: Array<string | number>; outputMode?: OutputMode; maxOutputChars?: number } = {}): Promise<string> {
    const nb = findNotebook(filePath);
    if (!nb) {
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
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
            `state:${executionState(cell)}${exec?.executionOrder !== undefined ? ` (#${exec.executionOrder})` : ''}]`
        );
        blocks.push(cell.document.getText());
        if (opts.includeOutputs) {
            if (cell.outputs.length) {
                blocks.push('[output]');
                blocks.push(formatCellOutputs(cell, { mode: opts.outputMode, maxChars: opts.maxOutputChars }));
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
        throw new Error(`No open notebook matches '${filePath}'. Use list_notebooks to list them.`);
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
