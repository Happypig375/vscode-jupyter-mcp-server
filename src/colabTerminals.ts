import * as crypto from 'crypto';
import * as vscode from 'vscode';

const INVENTORY_TTL_MS = 60_000;
const PID_WAIT_MS = 250;
const CLOSE_WAIT_MS = 5_000;
const MAX_CLOSE_REFS = 32;
const MAX_SAFE_TEXT = 120;

type ExitStatus = { code: number | null; reason: number } | null;

export interface ColabTerminalLikeForTest {
    readonly name: string;
    readonly processId: Thenable<number | undefined>;
    readonly exitStatus: { code: number | undefined; reason: number } | undefined;
    readonly state: { isInteractedWith: boolean; shell: string | undefined };
    dispose(): void;
}

interface DisposableLike { dispose(): unknown }

export interface ColabTerminalDependenciesForTest {
    now(): number;
    uuid(): string;
    terminals(): readonly ColabTerminalLikeForTest[];
    onDidOpen(listener: (terminal: ColabTerminalLikeForTest) => void): DisposableLike;
    onDidClose(listener: (terminal: ColabTerminalLikeForTest) => void): DisposableLike;
    onDidChangeState(listener: (terminal: ColabTerminalLikeForTest) => void): DisposableLike;
    onDidStartExecution(listener: (terminal: ColabTerminalLikeForTest) => void): DisposableLike;
    onDidEndExecution(listener: (terminal: ColabTerminalLikeForTest) => void): DisposableLike;
    schedule(callback: () => void, milliseconds: number): DisposableLike;
    delay(milliseconds: number): Promise<void>;
}

interface Fingerprint {
    name: string;
    processId: number | null;
    shell: string | null;
    isInteractedWith: boolean;
    exitStatus: ExitStatus;
}

interface InventoryEntry {
    ref: string;
    terminal: ColabTerminalLikeForTest;
    fingerprint: Fingerprint;
}

interface Inventory {
    id: string;
    createdAt: number;
    expiresAt: number;
    entries: InventoryEntry[];
    dirty: boolean;
    tracking: DisposableLike[];
}

export class ColabTerminalError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

const WARNING = 'Terminal metadata cannot prove that a terminal is idle or who owns it. Closing a terminal may terminate a running command or discard shell state.';

class ColabTerminalManager {
    private latest: Inventory | undefined;
    private expiredInventoryId: string | undefined;
    private operationTail: Promise<void> = Promise.resolve();

    constructor(private readonly deps: ColabTerminalDependenciesForTest) { }

    list(): Promise<string> { return this.exclusive(() => this.doList()); }

    private async doList(): Promise<string> {
        this.clearLatest();
        this.expiredInventoryId = undefined;
        const terminals = [...this.deps.terminals()];
        const fingerprints = await Promise.all(terminals.map(terminal => this.capture(terminal)));
        const createdAt = this.deps.now();
        const inventory: Inventory = {
            id: this.deps.uuid(),
            createdAt,
            expiresAt: createdAt + INVENTORY_TTL_MS,
            entries: terminals.map((terminal, index) => ({ ref: this.deps.uuid(), terminal, fingerprint: fingerprints[index] })),
            dirty: false,
            tracking: []
        };
        const markIfRelevant = (terminal: ColabTerminalLikeForTest) => {
            if (inventory.entries.some(entry => entry.terminal === terminal)) inventory.dirty = true;
        };
        inventory.tracking.push(
            this.deps.onDidOpen(() => { inventory.dirty = true; }),
            this.deps.onDidClose(markIfRelevant),
            this.deps.onDidChangeState(markIfRelevant),
            this.deps.onDidStartExecution(markIfRelevant),
            this.deps.onDidEndExecution(markIfRelevant)
        );
        let confirmed: Fingerprint[];
        try { confirmed = await Promise.all(terminals.map(terminal => this.capture(terminal))); }
        catch (error) { disposeAll(inventory.tracking); throw error; }
        if (inventory.dirty || !sameTerminalSet(this.deps.terminals(), terminals) ||
            confirmed.some((fingerprint, index) => !sameFingerprint(fingerprint, fingerprints[index]))) {
            disposeAll(inventory.tracking);
            throw new ColabTerminalError('terminal_inventory_changed', 'A terminal changed while the inventory was being created. List terminals again.');
        }
        inventory.entries.forEach((entry, index) => { entry.fingerprint = confirmed[index]; });
        inventory.tracking.push(this.deps.schedule(() => {
            if (this.latest === inventory && this.deps.now() >= inventory.expiresAt) {
                this.expiredInventoryId = inventory.id;
                this.clearLatest();
            }
        }, INVENTORY_TTL_MS));
        this.latest = inventory;
        return JSON.stringify({
            status: 'terminal_inventory',
            inventoryId: inventory.id,
            createdAt: inventory.createdAt,
            expiresAt: inventory.expiresAt,
            terminals: inventory.entries.map(entry => ({
                terminalRef: entry.ref,
                name: safeText(entry.fingerprint.name),
                processId: entry.fingerprint.processId,
                shell: entry.fingerprint.shell === null ? null : safeText(entry.fingerprint.shell),
                isInteractedWith: entry.fingerprint.isInteractedWith,
                exitStatus: entry.fingerprint.exitStatus
            })),
            warning: WARNING
        });
    }

    close(inventoryId: string, terminalRefs: string[]): Promise<string> {
        return this.exclusive(() => this.doClose(inventoryId, terminalRefs));
    }

    private async doClose(inventoryId: string, terminalRefs: string[]): Promise<string> {
        if (typeof inventoryId !== 'string' || inventoryId.length > 128) throw new ColabTerminalError('terminal_inventory_invalid', 'inventoryId is malformed.');
        if (!Array.isArray(terminalRefs) || terminalRefs.length === 0 || terminalRefs.length > MAX_CLOSE_REFS ||
            terminalRefs.some(ref => typeof ref !== 'string' || ref.length > 128) || new Set(terminalRefs).size !== terminalRefs.length) {
            throw new ColabTerminalError('terminal_refs_invalid', `Provide between 1 and ${MAX_CLOSE_REFS} unique terminal references.`);
        }
        const inventory = this.latest;
        if (!inventory || inventory.id !== inventoryId) {
            if (this.expiredInventoryId === inventoryId) throw new ColabTerminalError('terminal_inventory_expired', 'The terminal inventory expired. List terminals again.');
            throw new ColabTerminalError('terminal_inventory_stale', 'The terminal inventory is no longer current. List terminals again.');
        }
        if (this.deps.now() > inventory.expiresAt) {
            this.expiredInventoryId = inventory.id;
            this.clearLatest();
            throw new ColabTerminalError('terminal_inventory_expired', 'The terminal inventory expired. List terminals again.');
        }
        const byRef = new Map(inventory.entries.map(entry => [entry.ref, entry]));
        const selected = terminalRefs.map(ref => byRef.get(ref));
        if (selected.some(entry => !entry)) {
            this.clearLatest();
            throw new ColabTerminalError('terminal_ref_foreign', 'A terminal reference does not belong to the latest inventory.');
        }
        const entries = selected as InventoryEntry[];
        await this.preflight(inventory, entries);
        if (this.latest !== inventory) throw new ColabTerminalError('terminal_inventory_stale', 'The terminal inventory changed during validation. List terminals again.');
        this.latest = undefined;
        disposeAll(inventory.tracking);

        const selectedTerminals = new Set(entries.map(entry => entry.terminal));
        const closed = new Set<ColabTerminalLikeForTest>();
        let resolveAllClosed: (() => void) | undefined;
        const allClosed = new Promise<void>(resolve => { resolveAllClosed = resolve; });
        const noteClosed = (terminal: ColabTerminalLikeForTest) => {
            if (!selectedTerminals.has(terminal)) return;
            closed.add(terminal);
            if (entries.every(entry => closed.has(entry.terminal))) resolveAllClosed?.();
        };
        const closeListener = this.deps.onDidClose(noteClosed);
        const disposeFailed = new Set<ColabTerminalLikeForTest>();
        try {
            for (const entry of entries) {
                try { entry.terminal.dispose(); } catch { disposeFailed.add(entry.terminal); }
            }
            for (const entry of entries) {
                if (!this.deps.terminals().includes(entry.terminal)) noteClosed(entry.terminal);
            }
            if (closed.size !== entries.length) await Promise.race([allClosed, this.deps.delay(CLOSE_WAIT_MS)]);
        } finally {
            closeListener.dispose();
        }
        const current = this.deps.terminals();
        const results = entries.map(entry => ({
            terminalRef: entry.ref,
            status: closed.has(entry.terminal) || !current.includes(entry.terminal)
                ? 'closed'
                : disposeFailed.has(entry.terminal) ? 'unknown' : 'requested'
        }));
        return JSON.stringify({
            status: 'terminal_close_result',
            inventoryId,
            results,
            remainingCount: current.length,
            warning: WARNING
        });
    }

    private async preflight(inventory: Inventory, selected: InventoryEntry[]): Promise<void> {
        if (inventory.dirty || !sameTerminalSet(this.deps.terminals(), inventory.entries.map(entry => entry.terminal))) {
            this.clearLatest();
            throw new ColabTerminalError('terminal_inventory_changed', 'The terminal set or activity changed. List terminals again before closing any terminal.');
        }
        const fresh = await Promise.all(selected.map(entry => this.capture(entry.terminal)));
        if (this.latest !== inventory || this.deps.now() > inventory.expiresAt || inventory.dirty ||
            !sameTerminalSet(this.deps.terminals(), inventory.entries.map(entry => entry.terminal)) ||
            fresh.some((fingerprint, index) => !sameFingerprint(fingerprint, selected[index].fingerprint))) {
            this.clearLatest();
            throw new ColabTerminalError('terminal_inventory_changed', 'A terminal changed during validation. No terminal was closed; list terminals again.');
        }
    }

    private async capture(terminal: ColabTerminalLikeForTest): Promise<Fingerprint> {
        let pidPromise: Thenable<number | undefined>;
        try { pidPromise = terminal.processId; } catch { pidPromise = Promise.resolve(undefined); }
        const processId = await boundedPid(pidPromise, this.deps.delay(PID_WAIT_MS));
        const exit = terminal.exitStatus;
        return {
            name: terminal.name,
            processId,
            shell: terminal.state.shell ?? null,
            isInteractedWith: terminal.state.isInteractedWith,
            exitStatus: exit ? { code: exit.code ?? null, reason: exit.reason } : null
        };
    }

    private clearLatest(): void {
        if (!this.latest) return;
        disposeAll(this.latest.tracking);
        this.latest = undefined;
    }

    private exclusive<T>(work: () => Promise<T>): Promise<T> {
        const result = this.operationTail.then(work, work);
        this.operationTail = result.then(() => undefined, () => undefined);
        return result;
    }
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
    return left.name === right.name && left.processId === right.processId && left.shell === right.shell &&
        left.isInteractedWith === right.isInteractedWith && JSON.stringify(left.exitStatus) === JSON.stringify(right.exitStatus);
}

function sameTerminalSet(current: readonly ColabTerminalLikeForTest[], expected: readonly ColabTerminalLikeForTest[]): boolean {
    return current.length === expected.length && current.every(terminal => expected.includes(terminal));
}

async function boundedPid(value: Thenable<number | undefined>, timeout: Promise<void>): Promise<number | null> {
    const observed = Promise.resolve(value).then(pid => Number.isSafeInteger(pid) && (pid as number) > 0 ? pid as number : null, () => null);
    return Promise.race([observed, timeout.then(() => null)]);
}

function safeText(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, MAX_SAFE_TEXT);
}

function disposeAll(disposables: DisposableLike[]): void {
    for (const disposable of disposables.splice(0)) {
        try { disposable.dispose(); } catch { /* best effort listener cleanup */ }
    }
}

function productionDependencies(): ColabTerminalDependenciesForTest {
    return {
        now: Date.now,
        uuid: crypto.randomUUID,
        terminals: () => vscode.window.terminals,
        onDidOpen: listener => vscode.window.onDidOpenTerminal(listener),
        onDidClose: listener => vscode.window.onDidCloseTerminal(listener),
        onDidChangeState: listener => vscode.window.onDidChangeTerminalState(listener),
        onDidStartExecution: listener => vscode.window.onDidStartTerminalShellExecution(event => listener(event.terminal)),
        onDidEndExecution: listener => vscode.window.onDidEndTerminalShellExecution(event => listener(event.terminal)),
        schedule: (callback, milliseconds) => {
            const handle = setTimeout(callback, milliseconds);
            return { dispose: () => clearTimeout(handle) };
        },
        delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    };
}

const manager = new ColabTerminalManager(productionDependencies());

export async function listColabTerminals(): Promise<string> { return manager.list(); }
export async function closeColabTerminals(inventoryId: string, terminalRefs: string[]): Promise<string> { return manager.close(inventoryId, terminalRefs); }

export function createColabTerminalsForTest(dependencies: ColabTerminalDependenciesForTest): {
    list(): Promise<string>;
    close(inventoryId: string, terminalRefs: string[]): Promise<string>;
} {
    const testManager = new ColabTerminalManager(dependencies);
    return { list: () => testManager.list(), close: (inventoryId, terminalRefs) => testManager.close(inventoryId, terminalRefs) };
}
