export const extensionRegistry = new Map<string, any>();
export const extensions = { getExtension: (id: string): any => extensionRegistry.get(id) };
class TestUri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '', readonly fragment = '') {}
    with(change: Partial<TestUri>) { return new TestUri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment); }
    toString() { return `${this.scheme}://${this.authority}${encodeURI(this.path)}${this.query ? '?' + this.query : ''}${this.fragment ? '#' + this.fragment : ''}`; }
}
export const Uri = { parse: (value: string) => {
    if (!value.includes(':')) return new TestUri('', '', value);
    const uri = new URL(value);
    return new TestUri(uri.protocol.slice(0, -1), uri.host, decodeURIComponent(uri.pathname), uri.search.slice(1), uri.hash.slice(1));
} };
export const workspace: any = { workspaceFolders: [], textDocuments: [], notebookDocuments: [], fs: {} };
export interface CancellationToken { isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void }; }
export class CancellationTokenSource {
    private listeners = new Set<() => void>();
    readonly token: CancellationToken = {
        get isCancellationRequested() { return cancelledSources.has(this as unknown as object); },
        onCancellationRequested: (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
    };
    cancel(): void { if (this.token.isCancellationRequested) return; cancelledSources.add(this.token as unknown as object); for (const listener of this.listeners) listener(); }
    dispose(): void { this.listeners.clear(); }
}
const cancelledSources = new WeakSet<object>();
