type Listener<T> = (event: T) => unknown;

class EventSource<T> {
    private readonly listeners = new Set<Listener<T>>();
    readonly event = (listener: Listener<T>) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
}

export const terminalEvents = {
    open: new EventSource<any>(), close: new EventSource<any>(), state: new EventSource<any>(),
    start: new EventSource<any>(), end: new EventSource<any>()
};

export const window = {
    terminals: [] as any[],
    onDidOpenTerminal: terminalEvents.open.event,
    onDidCloseTerminal: terminalEvents.close.event,
    onDidChangeTerminalState: terminalEvents.state.event,
    onDidStartTerminalShellExecution: (listener: Listener<any>) => terminalEvents.start.event((terminal: any) => listener({ terminal })),
    onDidEndTerminalShellExecution: (listener: Listener<any>) => terminalEvents.end.event((terminal: any) => listener({ terminal }))
};
