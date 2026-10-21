import * as path from 'path';

export const state: any = {};

class TestUri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    readonly fsPath: string;
    private readonly value: string;
    constructor(value: string) {
        this.value = value;
        const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(value);
        this.scheme = match?.[1] ?? 'file';
        let rest = match?.[2] ?? value;
        const hash = rest.indexOf('#'); this.fragment = hash >= 0 ? rest.slice(hash + 1) : ''; if (hash >= 0) rest = rest.slice(0, hash);
        const question = rest.indexOf('?'); this.query = question >= 0 ? rest.slice(question + 1) : ''; if (question >= 0) rest = rest.slice(0, question);
        if (rest.startsWith('//')) {
            const slash = rest.indexOf('/', 2);
            this.authority = slash < 0 ? rest.slice(2) : rest.slice(2, slash);
            this.path = decodeURIComponent(slash < 0 ? '/' : rest.slice(slash));
        } else {
            this.authority = '';
            this.path = decodeURIComponent(rest || '/');
        }
        const rawPath = this.path.replace(/^\/([A-Za-z]:)/, '$1');
        this.fsPath = /^[A-Za-z]:/.test(rawPath) ? rawPath.replace(/\//g, '\\') : rawPath.replace(/\//g, path.sep);
    }
    toString(): string { return this.value; }
}

export function fileUri(value: string): any {
    const normalized = path.resolve(value).replace(/\\/g, '/');
    return new TestUri(`file:///${normalized.replace(/^([A-Za-z]):/, '$1:')}`);
}

export function userDataUri(value: string, authority = ''): any {
    const normalized = path.win32.resolve(value).replace(/\\/g, '/');
    return new TestUri(authority ? `vscode-userdata://${authority}/${normalized}` : `vscode-userdata:/${normalized}`);
}

export function rawUri(value: string): any { return new TestUri(value); }

export function reset(): void {
    Object.assign(state, {
        trusted: true, remoteName: undefined, folders: undefined, workspaceFile: undefined,
        notebooks: [], documents: [], visibleNotebooks: [], activeNotebook: undefined,
        terminals: [], visibleEditors: [], activeEditor: undefined, tabs: [], calls: [],
        tabGroups: undefined,
        configuredPort: 0, confirmBeforeClose: 'never', restoreWindows: 'all', activeDebugSession: undefined,
        workspaceUpdates: [], workspaceUpdateResult: true, onWorkspaceUpdate: undefined
    });
}
reset();

export const version = '1.142.0';
export const StatusBarAlignment = { Right: 2 };
export const Uri = { parse: (value: string) => new TestUri(value), file: fileUri };
export class TabInputText { constructor(readonly uri: any) {} }
export class TabInputTextDiff { constructor(readonly original: any, readonly modified: any) {} }
export class TabInputCustom { constructor(readonly uri: any, readonly viewType: string) {} }
export class TabInputNotebook { constructor(readonly uri: any, readonly notebookType: string) {} }
export class TabInputNotebookDiff { constructor(readonly original: any, readonly modified: any, readonly notebookType: string) {} }
export class TabInputWebview { constructor(readonly viewType: string) {} }
export class TabInputTerminal {}
export const NotebookCellKind = { Markup: 1, Code: 2 };
export class NotebookCellData { constructor(public kind: number, public value: string, public languageId: string) {} }
export class NotebookRange { constructor(public start: number, public end: number) {} }
export class NotebookData { constructor(public cells: NotebookCellData[]) {} }
export const NotebookEdit = {
    insertCells: (index: number, cells: NotebookCellData[]) => ({ index, cells }),
    replaceCells: (range: NotebookRange, cells: NotebookCellData[]) => ({ range, cells }),
    deleteCells: (range: NotebookRange) => ({ range })
};
export class WorkspaceEdit { set(_uri: any, _edits: any[]) {} }
export class CancellationTokenSource {
    private listeners: Array<() => void> = [];
    token = { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { this.listeners.push(listener); return { dispose() {} }; } };
    cancel() { this.token.isCancellationRequested = true; for (const listener of this.listeners) listener(); }
    dispose() { this.listeners = []; }
}
export const extensions = { getExtension: () => undefined };
export const lm = { tools: [] as any[] };
export const env = { get appHost() { return 'desktop'; }, get remoteName() { return state.remoteName; } };
export const workspace = {
    get isTrusted() { return state.trusted; },
    get workspaceFolders() { return state.folders; },
    get workspaceFile() { return state.workspaceFile; },
    get notebookDocuments() { return state.notebooks; },
    get textDocuments() { return state.documents; },
    updateWorkspaceFolders: (start: number, deleteCount: number, ...folders: unknown[]) => {
        state.workspaceUpdates.push([start, deleteCount, ...folders]);
        state.onWorkspaceUpdate?.();
        return state.workspaceUpdateResult;
    },
    getConfiguration: (section: string) => ({
        get: (key: string, fallback: unknown) => section === 'window'
            ? key === 'confirmBeforeClose' ? state.confirmBeforeClose : key === 'restoreWindows' ? state.restoreWindows : fallback
            : state.configuredPort || fallback
    })
};
export const debug = { get activeDebugSession() { return state.activeDebugSession; } };
export const window = {
    get visibleNotebookEditors() { return state.visibleNotebooks; },
    get activeNotebookEditor() { return state.activeNotebook; },
    get terminals() { return state.terminals; },
    get visibleTextEditors() { return state.visibleEditors; },
    get activeTextEditor() { return state.activeEditor; },
    tabGroups: {
        get all() { return state.tabGroups ?? [{ tabs: state.tabs }]; },
        close: async (tab: any) => { const index = state.tabs.indexOf(tab); if (index < 0) return false; state.tabs.splice(index, 1); return true; }
    },
    createStatusBarItem: () => ({ text: '', show() {}, dispose() {} })
};
export const commands = {
    executeCommand: async (command: string, ...args: unknown[]) => { state.calls.push([command, ...args]); return undefined; }
};
