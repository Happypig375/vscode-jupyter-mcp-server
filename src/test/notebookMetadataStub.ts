export const NotebookCellKind = { Markup: 1, Code: 2 };
export class Disposable { constructor(private cleanup: () => void = () => undefined) {} dispose() { this.cleanup(); } }
export class NotebookCellData {
    metadata: Record<string, any> = {};
    outputs: any[] = [];
    constructor(public kind: number, public value: string, public languageId: string) {}
}
export class NotebookRange { constructor(public start: number, public end: number) {} }
export class NotebookData { metadata: Record<string, any> = {}; constructor(public cells: NotebookCellData[]) {} }
export const NotebookEdit = {
    insertCells: (index: number, cells: NotebookCellData[]) => ({ index, count: 0, cells }),
    replaceCells: (range: NotebookRange, cells: NotebookCellData[]) => ({ index: range.start, count: range.end - range.start, cells })
};
export class WorkspaceEdit {
    operations: Array<{ uri: any; edits: any[] }> = [];
    set(uri: any, edits: any[]) { this.operations.push({ uri, edits }); }
}
export const workspace = {
    notebookDocuments: [] as any[],
    getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }),
    applyEdit: async (edit: WorkspaceEdit) => {
        for (const operation of edit.operations) {
            const document = workspace.notebookDocuments.find((doc) => doc.uri === operation.uri);
            for (const change of operation.edits) document.cells.splice(change.index, change.count, ...change.cells);
        }
        return true;
    }
};
export const extensions = { getExtension: () => undefined };
export const commands = { executeCommand: async () => { throw new Error('Metadata tests must not execute commands.'); } };
export const Uri = { joinPath: () => { throw new Error('Metadata tests must not create notebooks.'); } };
export const window = { showNotebookDocument: async () => { throw new Error('Metadata tests must not open editors.'); } };
export const lm = { tools: [] };
export const DocumentDropOrPasteEditKind = { Empty: { append: () => ({}) } };

/**
 * Bounded ipynb serializer projection, independently following Microsoft's mapping:
 * https://github.com/microsoft/vscode/blob/main/extensions/ipynb/src/serializers.ts
 * https://github.com/microsoft/vscode/blob/main/extensions/ipynb/src/deserializers.ts
 * Checked 2026-10-12. Not a complete VS Code serializer or GUI/save integration test.
 */
export function serializeFixture(data: NotebookData): string {
    return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: data.metadata.metadata ?? {}, cells: data.cells.map((cell) => {
        const saved: Record<string, unknown> = { cell_type: cell.kind === 1 ? 'markdown' : 'code', source: [cell.value], metadata: cell.metadata.metadata ?? {} };
        if (cell.metadata.id) saved.id = cell.metadata.id;
        if (cell.kind === 1 && cell.metadata.attachments) saved.attachments = cell.metadata.attachments;
        if (cell.kind === 2) {
            saved.execution_count = cell.metadata.execution_count ?? null;
            saved.outputs = cell.outputs.map((output) => ({ output_type: 'stream', name: 'stdout', text: [Buffer.from(output.items[0].data).toString()] }));
        }
        return saved;
    }) });
}
export function deserializeFixture(json: string): NotebookData {
    const saved = JSON.parse(json);
    const data = new NotebookData(saved.cells.map((raw: any) => {
        const cell = new NotebookCellData(raw.cell_type === 'markdown' ? 1 : 2, raw.source.join(''), raw.cell_type === 'markdown' ? 'markdown' : 'python');
        cell.metadata = { metadata: raw.metadata };
        if (raw.id) cell.metadata.id = raw.id;
        if (raw.attachments) cell.metadata.attachments = raw.attachments;
        if (raw.cell_type === 'code') {
            cell.metadata.execution_count = raw.execution_count;
            cell.outputs = raw.outputs.map((output: any) => ({ metadata: { outputType: 'stream' }, items: [{ mime: 'application/vnd.code.notebook.stdout', data: Buffer.from(output.text.join('')) }] }));
        }
        return cell;
    }));
    data.metadata = { nbformat: saved.nbformat, nbformat_minor: saved.nbformat_minor, metadata: saved.metadata };
    return data;
}
