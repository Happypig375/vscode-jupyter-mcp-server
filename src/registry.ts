import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Shared window registry: lets every VS Code extension host window that runs this
 * extension announce itself (id, port it owns, heartbeat), so that multiple windows
 * opened on the same port merge into ONE MCP server. The window that owns the port
 * aggregates open notebooks from ALL registered windows.
 *
 * State lives in a file under the OS temp dir keyed by the configured port, so
 * windows in the same user session share it.
 */

export interface WindowEntry {
    /** Unique instance id (per extension host process). */
    id: string;
    /** The port this window serves (or is trying to claim). */
    port: number;
    /** Human label, e.g. 'Window: /path' or 'Window (no folder)'. */
    label: string;
    /** Last heartbeat time (ms since epoch). Stale entries are pruned. */
    heartbeat: number;
}

const HEARTBEAT_MS = 10_000;
const STALE_MS = 30_000;

function stateFile(port: number): string {
    return path.join(os.tmpdir(), `jupyter-mcp-${port}.json`);
}

function readEntries(port: number): WindowEntry[] {
    try {
        const raw = fs.readFileSync(stateFile(port), 'utf8');
        const arr = JSON.parse(raw) as WindowEntry[];
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function writeEntries(port: number, entries: WindowEntry[]): void {
    try {
        fs.writeFileSync(stateFile(port), JSON.stringify(entries, null, 1), 'utf8');
    } catch {
        // best-effort
    }
}

function windowLabel(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return folder ? `Window: ${folder}` : 'Window (no folder)';
}

/** Generate a stable-ish per-process id (process id + random). */
export function makeInstanceId(): string {
    return `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Register this window with the registry and start its heartbeat.
 * Returns a disposer that removes the entry.
 */
export function registerWindow(entry: Omit<WindowEntry, 'heartbeat'>): vscode.Disposable {
    const full: WindowEntry = { ...entry, heartbeat: Date.now() };
    const update = () => {
        const entries = readEntries(entry.port).filter((e) => e.id !== full.id);
        entries.push({ ...full, heartbeat: Date.now() });
        writeEntries(entry.port, entries);
    };
    update();
    const timer = setInterval(update, HEARTBEAT_MS);
    return {
        dispose: () => {
            clearInterval(timer);
            const entries = readEntries(entry.port).filter((e) => e.id !== full.id);
            writeEntries(entry.port, entries);
        }
    };
}

/** All live windows registered for this port (self included). */
export function listWindows(port: number): WindowEntry[] {
    const now = Date.now();
    return readEntries(port)
        .filter((e) => now - e.heartbeat < STALE_MS)
        .sort((a, b) => a.heartbeat - b.heartbeat);
}

export { windowLabel };
