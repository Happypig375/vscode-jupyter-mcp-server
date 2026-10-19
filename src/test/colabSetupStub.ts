export const state: any = {};
export function uri(value: string): any {
    const match = /^([^:]+):\/\/([^/]*)(.*)$/.exec(value);
    return { scheme: match?.[1] ?? 'file', authority: match?.[2] ?? '', path: match?.[3] ?? '/', query: '', fragment: '', fsPath: value,
        toString: () => value, with: (change: any) => uri(`${match?.[1]}://${match?.[2]}${change.path ?? match?.[3]}`) };
}
function cell(value: string, index: number, identity: string): any {
    return { kind: 2, index, metadata: {}, outputs: [], document: { uri: uri(identity), languageId: 'python', getText: () => value } };
}
export function reset(): void {
    Object.assign(state, { remoteName: undefined, trusted: true, version: '0.9.7', installed: true, activationFailure: false, editorMismatch: false,
        active: undefined, calls: [], markers: [], startupMode: 'success', mountMode: 'single', selection: true, editFailure: false, cleanupFailure: false, cleanupHang: false });
    const cells = [cell('never_execute_user_code()', 0, 'vscode-notebook-cell:///one'), cell('second_user_cell()', 1, 'vscode-notebook-cell:///two')];
    state.notebook = { notebookType: 'jupyter-notebook', uri: uri('file:///test.ipynb'), isClosed: false, metadata: {},
        get cellCount() { return cells.length; }, getCells: () => cells, cellAt: (i: number) => cells[i] };
    state.folders = [{ name: 'workspace', uri: uri('file:///workspace') }];
}
reset();
export const env = { get remoteName() { return state.remoteName; } };
export const Uri = { parse: uri, joinPath: (base: any, value: string) => uri(base.toString() + '/' + value) };
export class NotebookData { constructor(public cells: any[]) {} }
export const lm = { tools: [] };
export const StatusBarAlignment = { Right: 2 };
export const NotebookCellKind = { Code: 2 };
export class NotebookCellData { constructor(public kind: number, public value: string, public languageId: string) {} }
export class NotebookRange { constructor(public start: number, public end: number) {} }
export class WorkspaceEdit { ops: any[] = []; set(_uri: any, edits: any[]) { this.ops.push(...edits); } }
export const NotebookEdit = { insertCells: (index: number, cells: any[]) => ({ index, cells }), deleteCells: (range: any) => ({ range }) };
export class CancellationTokenSource {
    private listeners: (() => void)[] = [];
    token = { isCancellationRequested: false, onCancellationRequested: (cb: () => void) => { this.listeners.push(cb); return { dispose() {} }; } };
    cancel() { this.token.isCancellationRequested = true; this.listeners.forEach((cb) => cb()); }
    dispose() { this.listeners = []; }
}
export const workspace = {
    get isTrusted() { return state.trusted; }, get workspaceFolders() { return state.folders; },
    get notebookDocuments() { return [state.notebook]; }, textDocuments: [],
    getConfiguration: () => ({ get: (_key: string, fallback: any) => fallback }),
    applyEdit: async (edit: WorkspaceEdit) => {
        if (state.editFailure) return false;
        const cells = state.notebook.getCells();
        for (const operation of edit.ops) {
            if (operation.cells) {
                cells.splice(operation.index, 0, ...operation.cells.map((data: any, i: number) => cell(data.value, operation.index + i, 'vscode-notebook-cell:///startup-' + Math.random())));
            } else {
                if (state.cleanupFailure) return false;
                if (state.cleanupHang) await new Promise<void>((resolve) => { state.finishCleanup = resolve; });
                cells.splice(operation.range.start, operation.range.end - operation.range.start);
            }
        }
        cells.forEach((c: any, i: number) => { c.index = i; }); return true;
    }
};
export const window = {
    showNotebookDocument: async (doc: any) => ({ notebook: state.editorMismatch ? {} : doc }),
    createStatusBarItem: () => { const marker = { text: '', show() {}, dispose() {} }; state.markers.push(marker); return marker; }
};
export const extensions = { getExtension: (id: string): any => id === 'google.colab' ? state.installed ? {
    isActive: false, packageJSON: { version: state.version }, activate: async () => { if (state.activationFailure) throw new Error('secret activation'); }
} : undefined : { activate: async () => ({ kernels: { getKernel: async () => state.active } }) } };
export const commands = { executeCommand: async (id: string, ...args: any[]) => {
    state.calls.push([id, ...args]);
    if (id === 'notebook.selectKernel') return state.selection;
    if (id === 'notebook.cell.execute') {
        const range = args[0].ranges[0];
        const target = state.notebook.cellAt(range.start);
        if (!target.document.getText().startsWith('# jupyter-mcp-colab-startup ') || range.end !== range.start + 1) throw new Error('User cell executed');
        if (state.startupMode === 'hang') return;
        if (state.startupMode === 'unsettled') return new Promise<void>((resolve) => { state.finishCommand = resolve; });
        if (state.startupMode === 'edit') { target.document.getText = () => 'human edit'; return; }
        target.executionSummary = { success: state.startupMode === 'success', timing: { endTime: Date.now() } };
        state.active = { language: 'python', status: 'idle' }; return;
    }
    if (id === 'colab.mountServer') {
        if (state.mountMode === 'failure') throw new Error('secret mount token');
        state.folders.push({ name: 'Colab', uri: uri('colab://test-server/content') });
        if (state.mountMode === 'ambiguous') state.folders.push({ name: 'Other', uri: uri('colab://other-server/content') });
    }
} };
