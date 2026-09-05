export const extensions = { getExtension: () => undefined };
export const Uri = { parse: (value: string) => ({ toString: () => value }) };
export interface CancellationToken { isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void }; }
export class CancellationTokenSource {
    private listeners = new Set<() => void>();
    readonly token: CancellationToken = {
        get isCancellationRequested() { return cancelledSources.has(this as unknown as object); },
        onCancellationRequested: (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
    };
    cancel(): void { cancelledSources.add(this.token as unknown as object); for (const listener of this.listeners) listener(); }
    dispose(): void { this.listeners.clear(); cancelledSources.delete(this.token as unknown as object); }
}
const cancelledSources = new WeakSet<object>();
