import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const PICKER_TIMEOUT_MS = 90_000;
const POLL_MS = 350;

export type DesktopSetupErrorCode =
    | 'orca_missing'
    | 'version_unsupported'
    | 'capability_unsupported'
    | 'window_binding_failed'
    | 'picker_timeout'
    | 'ambiguous_picker'
    | 'cpu_selection_unconfirmed'
    | 'action_failed'
    | 'cancelled';

const ERROR_MESSAGES: Record<DesktopSetupErrorCode, string> = {
    orca_missing: 'Colab desktop automation is unavailable because Orca is not configured.',
    version_unsupported: 'The installed Orca desktop protocol is not supported.',
    capability_unsupported: 'The installed Orca desktop provider lacks a required semantic capability.',
    window_binding_failed: 'The owning Visual Studio Code window could not be bound safely.',
    picker_timeout: 'The expected Visual Studio Code picker did not appear before the deadline.',
    ambiguous_picker: 'The Visual Studio Code picker contained ambiguous matching controls.',
    cpu_selection_unconfirmed: 'The Colab server-name prompt did not confirm a CPU runtime; no name was submitted.',
    action_failed: 'A semantic Visual Studio Code desktop action could not be verified.',
    cancelled: 'Colab desktop setup was cancelled.'
};

export class DesktopSetupError extends Error {
    operation?: 'input_write' | 'input_readback' | 'input_submit' | 'following_picker';
    providerCode?: string;
    constructor(public readonly code: DesktopSetupErrorCode) {
        super(ERROR_MESSAGES[code]);
        this.name = 'DesktopSetupError';
    }
}

export interface DesktopSetupDriver {
    bind(marker: string, signal: AbortSignal): Promise<void>;
    waitForInput(inputLabels: readonly string[], signal: AbortSignal): Promise<string>;
    choose(inputLabels: readonly string[], optionLabels: readonly string[], signal: AbortSignal): Promise<string>;
    enter(inputLabels: readonly string[], value: string, signal: AbortSignal): Promise<void>;
    dispose(): void;
}

/** A raw-output boundary used by deterministic tests. Production always uses spawn without a shell. */
export interface OrcaCommandRunner {
    run(executable: string, args: readonly string[], signal: AbortSignal): Promise<string>;
}

interface DriverTiming {
    commandTimeoutMs: number;
    pickerTimeoutMs: number;
    pollMs: number;
}

interface Binding {
    app: string;
    pid: number;
    windowId: string;
    marker: string;
}

interface TreeNode {
    index: number;
    depth: number;
    role: string;
    label: string;
    value?: string;
    actions: ReadonlySet<string>;
}

interface ParsedSnapshot {
    nodes: TreeNode[];
}

interface HeaderMatch {
    node: TreeNode;
    canonical: string;
}

const DEFAULT_TIMING: DriverTiming = {
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    pickerTimeoutMs: PICKER_TIMEOUT_MS,
    pollMs: POLL_MS
};

const ICON_PREFIXES = new Set([
    'symbol-event',
    'add',
    'link-external',
    'accounts-view-bar-icon',
    'server-process',
    'remote',
    'vm',
    'cloud',
    'star-full'
]);

// These are the only semantic choices needed by the bounded CPU setup workflow.
// Browser, upgrade, accelerator and authentication actions are intentionally absent.
const SAFE_OPTION_LABELS = new Set([
    'Select Another Kernel...',
    'Colab',
    'New Colab Server',
    'CPU',
    'Standard',
    'Latest',
    'Python 3',
    'Python 3 (ipykernel)',
    'python3'
]);

const productionRunner: OrcaCommandRunner = {
    run(executable, args, signal) {
        return new Promise<string>((resolve, reject) => {
            let failure: Error | undefined;
            let bytes = 0;
            let chunks: Buffer[] = [];
            let child;
            try {
                child = spawn(executable, [...args], {
                    shell: false,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    signal
                });
            } catch {
                reject(new Error('spawn'));
                return;
            }
            const failAndKill = (reason: string) => {
                if (!failure) failure = new Error(reason);
                chunks = [];
                child.kill();
            };
            child.stdout.on('data', (chunk: Buffer) => {
                if (failure) return;
                bytes += chunk.length;
                if (bytes > MAX_OUTPUT_BYTES) {
                    failAndKill('oversize');
                    return;
                }
                chunks.push(chunk);
            });
            let stderrBytes = 0;
            child.stderr.on('data', (chunk: Buffer) => {
                stderrBytes += chunk.length;
                if (stderrBytes > MAX_OUTPUT_BYTES) failAndKill('oversize');
            });
            child.once('error', () => {
                if (!failure) failure = new Error('spawn');
                chunks = [];
            });
            child.once('close', (code) => {
                if (failure || code !== 0) reject(failure ?? new Error('exit'));
                else resolve(Buffer.concat(chunks).toString('utf8'));
            });
        });
    }
};

/** Test seam for the real spawn lifecycle; it performs no UI-specific operation by itself. */
export function runOrcaCommandForTest(executable: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    return productionRunner.run(executable, args, signal);
}

export function createColabDesktopDriver(executable?: string): DesktopSetupDriver {
    return new OrcaDesktopDriver(resolveExecutable(executable), productionRunner, DEFAULT_TIMING);
}

/** Test seam: it cannot select a remote provider and is intentionally absent from the public setup path. */
export function createColabDesktopDriverForTest(
    runner: OrcaCommandRunner,
    timing: Partial<DriverTiming> = {}
): DesktopSetupDriver {
    return new OrcaDesktopDriver('C:\\test\\orca.exe', runner, { ...DEFAULT_TIMING, ...timing });
}

export interface DesktopResolverHost {
    platform: NodeJS.Platform;
    environmentCommand?: string;
    localAppData?: string;
    isFile(candidate: string): boolean;
}

/** Deterministic resolver seam. Explicit or environment configuration is authoritative. */
export function resolveColabDesktopExecutableForTest(explicit: string | undefined, host: DesktopResolverHost): string {
    return resolveExecutableWithHost(explicit, host);
}

function resolveExecutable(explicit?: string): string {
    return resolveExecutableWithHost(explicit, {
        platform: process.platform,
        environmentCommand: process.env.ORCA_CLI_COMMAND,
        localAppData: process.env.LOCALAPPDATA,
        isFile(candidate) {
            try {
                return fs.statSync(candidate).isFile();
            } catch {
                return false;
            }
        }
    });
}

function resolveExecutableWithHost(explicit: string | undefined, host: DesktopResolverHost): string {
    if (explicit !== undefined) return requireExecutable(explicit, host);
    if (host.environmentCommand !== undefined) return requireExecutable(host.environmentCommand, host);
    const candidates: string[] = [];
    if (host.platform === 'win32' && host.localAppData) {
        candidates.push(path.win32.join(host.localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'));
    } else if (host.platform === 'linux') {
        candidates.push('/usr/local/bin/orca-ide', '/usr/bin/orca-ide');
    }
    for (const candidate of candidates) {
        if (!isAbsoluteForPlatform(candidate, host.platform)) continue;
        if (host.isFile(candidate)) return candidate;
    }
    throw new DesktopSetupError('orca_missing');
}

function requireExecutable(candidate: string, host: DesktopResolverHost): string {
    if (!isAbsoluteForPlatform(candidate, host.platform) || !host.isFile(candidate)) throw new DesktopSetupError('orca_missing');
    return candidate;
}

function isAbsoluteForPlatform(candidate: string, platform: NodeJS.Platform): boolean {
    return platform === 'win32' ? path.win32.isAbsolute(candidate) : path.posix.isAbsolute(candidate);
}

class OrcaDesktopDriver implements DesktopSetupDriver {
    private readonly disposed = new AbortController();
    private binding?: Binding;

    constructor(
        private readonly executable: string,
        private readonly runner: OrcaCommandRunner,
        private readonly timing: DriverTiming
    ) {}

    async bind(marker: string, signal: AbortSignal): Promise<void> {
        validateInternalText(marker, 'window_binding_failed');
        this.binding = undefined;
        const capabilities = await this.command(['computer', 'capabilities', '--json'], signal, 'version_unsupported');
        const result = objectAt(capabilities, 'result');
        if (
            !result || result.protocolVersion !== 1 || result.providerVersion !== '1.0.0' ||
            typeof result.platform !== 'string' || typeof result.provider !== 'string' ||
            !providerMatchesPlatform(result.platform, result.provider)
        ) {
            throw new DesktopSetupError('version_unsupported');
        }
        const caps = objectAt(result, 'supports');
        if (
            !caps || boolAt(caps, 'apps', 'list') !== true || boolAt(caps, 'apps', 'pids') !== true ||
            boolAt(caps, 'windows', 'list') !== true || boolAt(caps, 'windows', 'targetById') !== true
        ) {
            throw new DesktopSetupError('capability_unsupported');
        }
        if (
            boolAt(caps, 'actions', 'click') !== true ||
            boolAt(caps, 'actions', 'setValue') !== true ||
            boolAt(caps, 'actions', 'pressKey') !== true
        ) {
            throw new DesktopSetupError('capability_unsupported');
        }

        const appsEnvelope = await this.command(['computer', 'list-apps', '--json'], signal, 'window_binding_failed');
        const apps = arrayAt(appsEnvelope, 'result', 'apps');
        if (!apps) throw new DesktopSetupError('version_unsupported');
        const codeApps = apps.flatMap((entry) => {
            if (!isObject(entry) || entry.name !== 'Code' || !positiveInteger(entry.pid)) return [];
            return [{ pid: entry.pid as number, selector: `pid:${entry.pid as number}` }];
        });
        if (codeApps.length === 0) throw new DesktopSetupError('window_binding_failed');

        const matches: Binding[] = [];
        const seen = new Set<string>();
        for (const app of codeApps) {
            const windowsEnvelope = await this.command(
                ['computer', 'list-windows', '--app', app.selector, '--json'],
                signal,
                'window_binding_failed'
            );
            const windows = arrayAt(windowsEnvelope, 'result', 'windows');
            if (!windows) throw new DesktopSetupError('version_unsupported');
            for (const window of windows) {
                if (!isObject(window)) continue;
                const id = scalarId(window.id ?? window.windowId);
                if (!id) continue;
                const key = `${app.pid}:${id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const candidate: Binding = { app: app.selector, pid: app.pid, windowId: id, marker };
                const snapshot = await this.snapshot(candidate, signal, false, 'window_binding_failed');
                if (this.markerCount(snapshot, candidate) === 1) matches.push(candidate);
            }
        }
        if (matches.length !== 1) throw new DesktopSetupError('window_binding_failed');
        this.binding = matches[0];
    }

    async waitForInput(inputLabels: readonly string[], signal: AbortSignal): Promise<string> {
        const labels = validateAllowlist(inputLabels);
        const match = await this.pollFor(signal, (snapshot) => {
            const headers = matchingHeaders(snapshot.nodes, labels);
            if (headers.length > 1) throw new DesktopSetupError('ambiguous_picker');
            return headers.length === 1 ? headers[0] : undefined;
        });
        return match.canonical;
    }

    async choose(inputLabels: readonly string[], optionLabels: readonly string[], signal: AbortSignal): Promise<string> {
        const inputs = validateAllowlist(inputLabels);
        const options = validateAllowlist(optionLabels);
        const isOwnedMountChoice = inputs.length === 1 && inputs[0] === 'Mount Server to Workspace';
        if (options.some((label) => !SAFE_OPTION_LABELS.has(label) && !(isOwnedMountChoice && isSafeEnteredValue(label)))) {
            throw new DesktopSetupError('ambiguous_picker');
        }
        const found = await this.pollFor(signal, (snapshot) => locateChoice(snapshot, inputs, options));
        await this.performWithFocusRetry(
            signal,
            ['computer', 'click'],
            () => ({ index: found.node.index, expected: found.canonical }),
            (snapshot) => {
                const refreshed = locateChoice(snapshot, inputs, options);
                return { index: refreshed?.node.index, expected: refreshed?.canonical };
            }
        );
        return found.canonical;
    }

    async enter(inputLabels: readonly string[], value: string, signal: AbortSignal): Promise<void> {
        const inputs = validateAllowlist(inputLabels);
        validateInternalText(value, 'action_failed');
        if (!isSafeEnteredValue(value)) throw new DesktopSetupError('action_failed');
        const initial = await this.pollFor(signal, (snapshot) => locateSingleHeader(snapshot, inputs, 'SetValue'));
        if (isGeneratedAliasEntry(inputs, value) && initial.node.label !== 'Colab CPU - Alias your server') {
            throw new DesktopSetupError('cpu_selection_unconfirmed');
        }
        let operation: DesktopSetupError['operation'] = 'input_write';
        try {
            await this.performWithFocusRetry(
                signal,
                ['computer', 'set-value', '--value', value],
                () => ({ index: initial.node.index, expected: initial.canonical }),
                (snapshot) => {
                    const header = locateSingleHeader(snapshot, inputs, 'SetValue');
                    return { index: header?.node.index, expected: header?.canonical };
                }
            );
            operation = 'input_readback';
            const binding = this.requireBinding();
            const proof = await this.snapshot(binding, signal, false, 'action_failed');
            this.requireMarker(proof, binding);
            const header = locateEnteredHeader(proof, inputs, value);
            if (!entryMatches(header, initial.canonical, inputs, value)) {
                throw new DesktopSetupError('action_failed');
            }
            operation = 'input_submit';
            await this.pressReturnWithFocusRetry(signal, inputs, initial.canonical, value);
            if (isGeneratedAliasEntry(inputs, value)) {
                // Windows does not always expose the input value. The next picker must
                // name our exact generated alias before entry is considered successful.
                operation = 'following_picker';
                await this.waitForInput(['Select a Kernel from ' + value], signal);
            }
        } catch (error) {
            if (error instanceof DesktopSetupError) error.operation = operation;
            throw error;
        }
    }

    dispose(): void {
        if (!this.disposed.signal.aborted) this.disposed.abort();
        this.binding = undefined;
    }

    private async pollFor<T>(signal: AbortSignal, locate: (snapshot: ParsedSnapshot) => T | undefined): Promise<T> {
        const binding = this.requireBinding();
        const deadline = Date.now() + this.timing.pickerTimeoutMs;
        const pickerDeadline = new AbortController();
        const timer = setTimeout(() => pickerDeadline.abort(), this.timing.pickerTimeoutMs);
        try {
            while (true) {
                this.throwIfCancelled(signal);
                const pickerSignal = AbortSignal.any([this.combinedSignal(signal), pickerDeadline.signal]);
                let snapshot: ParsedSnapshot;
                try {
                    snapshot = await this.snapshot(binding, pickerSignal, false, 'action_failed');
                } catch (error) {
                    if (pickerDeadline.signal.aborted && !signal.aborted && !this.disposed.signal.aborted) {
                        throw new DesktopSetupError('picker_timeout');
                    }
                    throw error;
                }
                this.requireMarker(snapshot, binding);
                const found = locate(snapshot);
                if (found !== undefined) return found;
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw new DesktopSetupError('picker_timeout');
                try {
                    await wait(Math.min(this.timing.pollMs, remaining), pickerSignal);
                } catch (error) {
                    if (pickerDeadline.signal.aborted && !signal.aborted && !this.disposed.signal.aborted) {
                        throw new DesktopSetupError('picker_timeout');
                    }
                    throw error;
                }
            }
        } finally {
            clearTimeout(timer);
        }
    }

    private async performWithFocusRetry(
        signal: AbortSignal,
        base: readonly string[],
        initial: () => { index?: number; expected?: string },
        refresh: (snapshot: ParsedSnapshot) => { index?: number; expected?: string }
    ): Promise<void> {
        const binding = this.requireBinding();
        let target = initial();
        if (target.index === undefined || !target.expected) throw new DesktopSetupError('action_failed');
        let response = await this.action([...base, ...this.targetArgs(binding, target.index)], signal);
        if (response === 'ok') return;
        if (response !== 'window_not_focused') throw new DesktopSetupError('action_failed');
        const restored = await this.snapshot(binding, signal, true, 'action_failed');
        this.requireMarker(restored, binding);
        const next = refresh(restored);
        if (next.index === undefined || next.expected !== target.expected) throw new DesktopSetupError('action_failed');
        response = await this.action([...base, ...this.targetArgs(binding, next.index), '--restore-window'], signal);
        if (response !== 'ok') throw new DesktopSetupError('action_failed');
    }

    private async pressReturnWithFocusRetry(
        signal: AbortSignal,
        inputs: readonly string[],
        canonical: string,
        value: string
    ): Promise<void> {
        const binding = this.requireBinding();
        const args = ['computer', 'press-key', '--key', 'Return', ...this.windowArgs(binding)];
        let response = await this.action(args, signal);
        if (response === 'ok') return;
        if (response !== 'window_not_focused') throw new DesktopSetupError('action_failed');
        const restored = await this.snapshot(binding, signal, true, 'action_failed');
        this.requireMarker(restored, binding);
        const header = locateEnteredHeader(restored, inputs, value);
        if (!entryMatches(header, canonical, inputs, value)) throw new DesktopSetupError('action_failed');
        response = await this.action(
            ['computer', 'press-key', '--key', 'Return', '--app', binding.app, '--window-id', binding.windowId,
                '--restore-window', '--no-screenshot', '--json'],
            signal
        );
        if (response !== 'ok') throw new DesktopSetupError('action_failed');
    }

    private targetArgs(binding: Binding, index: number): string[] {
        return ['--app', binding.app, '--window-id', binding.windowId, '--element-index', String(index), '--no-screenshot', '--json'];
    }

    private windowArgs(binding: Binding): string[] {
        return ['--app', binding.app, '--window-id', binding.windowId, '--no-screenshot', '--json'];
    }

    private async action(args: readonly string[], signal: AbortSignal): Promise<'ok' | 'window_not_focused' | 'failed'> {
        const envelope = await this.command(args, signal, 'action_failed', true);
        if (envelope.ok === true) return 'ok';
        const code = providerErrorCode(envelope);
        if (code === 'window_not_focused') return code;
        const error = new DesktopSetupError('action_failed');
        error.providerCode = ['element_not_found', 'stale_snapshot', 'window_not_found', 'action_not_supported',
            'set_value_failed', 'invalid_arguments', 'timeout', 'invalid_element_index', 'element_not_settable',
            'target_not_found', 'action_failed'].includes(code ?? '') ? code : 'unrecognized_error';
        throw error;
    }

    private async snapshot(
        binding: Binding,
        signal: AbortSignal,
        restore: boolean,
        failure: DesktopSetupErrorCode
    ): Promise<ParsedSnapshot> {
        const args = ['computer', 'get-app-state', ...this.windowArgs(binding)];
        if (restore) args.splice(args.length - 2, 0, '--restore-window');
        const envelope = await this.command(args, signal, failure);
        if (envelope.ok !== true) throw new DesktopSetupError(failure);
        const snapshot = objectAt(envelope, 'result', 'snapshot');
        if (!snapshot || typeof snapshot.treeText !== 'string') throw new DesktopSetupError('version_unsupported');
        const truncation = isObject(snapshot.truncation) ? snapshot.truncation : undefined;
        if (truncation?.truncated === true) throw new DesktopSetupError('action_failed');
        const app = isObject(snapshot.app) ? snapshot.app : undefined;
        const window = isObject(snapshot.window) ? snapshot.window : undefined;
        if (app?.name !== 'Code' || app.pid !== binding.pid || scalarId(window?.id) !== binding.windowId) {
            throw new DesktopSetupError(failure);
        }
        return { nodes: parseTree(snapshot.treeText) };
    }

    private markerCount(snapshot: ParsedSnapshot, binding: Binding): number {
        // VS Code exposes the same status item as a wrapping group and its button.
        // Count the actionable status control, not its duplicate group label.
        return snapshot.nodes.filter((node) => (node.role === 'button' || node.role === 'status bar item') && node.label === binding.marker).length;
    }

    private requireMarker(snapshot: ParsedSnapshot, binding: Binding): void {
        if (this.markerCount(snapshot, binding) !== 1) throw new DesktopSetupError('window_binding_failed');
    }

    private requireBinding(): Binding {
        if (!this.binding || this.disposed.signal.aborted) throw new DesktopSetupError('window_binding_failed');
        return this.binding;
    }

    private combinedSignal(signal: AbortSignal): AbortSignal {
        return AbortSignal.any([signal, this.disposed.signal]);
    }

    private throwIfCancelled(signal: AbortSignal): void {
        if (signal.aborted || this.disposed.signal.aborted) throw new DesktopSetupError('cancelled');
    }

    private async command(
        args: readonly string[],
        signal: AbortSignal,
        failure: DesktopSetupErrorCode,
        allowProviderFailure = false
    ): Promise<Record<string, unknown>> {
        this.throwIfCancelled(signal);
        const controller = new AbortController();
        const combined = AbortSignal.any([signal, this.disposed.signal, controller.signal]);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, Math.min(COMMAND_TIMEOUT_MS, this.timing.commandTimeoutMs));
        try {
            const raw = await this.runner.run(this.executable, args, combined);
            if (Buffer.byteLength(raw, 'utf8') > MAX_OUTPUT_BYTES) throw new DesktopSetupError('version_unsupported');
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new DesktopSetupError('version_unsupported');
            }
            if (!isObject(parsed)) throw new DesktopSetupError('version_unsupported');
            if (!allowProviderFailure && parsed.ok !== true) throw new DesktopSetupError(failure);
            return parsed;
        } catch (error) {
            if (error instanceof DesktopSetupError) throw error;
            if (signal.aborted || this.disposed.signal.aborted) throw new DesktopSetupError('cancelled');
            if (timedOut) throw new DesktopSetupError(failure);
            throw new DesktopSetupError(failure);
        } finally {
            clearTimeout(timer);
        }
    }
}

function parseTree(tree: string): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const line of tree.split(/\r?\n/)) {
        const match = /^(\s*)(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        const depth = match[1].length;
        const index = Number(match[2]);
        if (!Number.isSafeInteger(index)) continue;
        const parsedRole = parseRole(match[3]);
        if (!parsedRole) continue;
        const actionMatch = /, Secondary Actions: (.*)$/.exec(parsedRole.tail);
        const actions = new Set(actionMatch ? actionMatch[1].split(',').map((action) => action.trim()).filter(Boolean) : []);
        let label = parsedRole.tail.replace(/, Secondary Actions:.*$/, '').trim();
        let value: string | undefined;
        if (parsedRole.role === 'edit' || parsedRole.role === 'combo box' || parsedRole.role === 'combobox') {
            const valueMatch = /^(.*), (?:Value|Text): (.*)$/.exec(label);
            if (valueMatch) {
                label = valueMatch[1].trim();
                value = valueMatch[2];
            }
        }
        if (parsedRole.role === 'option') {
            const comma = label.indexOf(',');
            if (comma >= 0) label = label.slice(0, comma).trim();
            const space = label.indexOf(' ');
            if (space > 0 && ICON_PREFIXES.has(label.slice(0, space))) label = label.slice(space + 1).trim();
        }
        nodes.push({ index, depth, role: parsedRole.role, label, value, actions });
    }
    return nodes;
}

function parseRole(text: string): { role: string; tail: string } | undefined {
    for (const role of [
        'status bar item', 'toggle button', 'menu item', 'tab item', 'tree item', 'list item',
        'combo box', 'combobox', 'edit', 'option', 'button', 'text', 'group', 'window',
        'application', 'list', 'toolbar', 'tool bar', 'tab', 'main'
    ]) {
        if (text.startsWith(`${role} `)) return { role, tail: text.slice(role.length + 1) };
    }
    // Other roles are retained only for exact marker matching.
    const space = text.indexOf(' ');
    if (space <= 0) return undefined;
    return { role: text.slice(0, space), tail: text.slice(space + 1).replace(/, Secondary Actions:.*$/, '').trim() };
}

function matchingHeaders(nodes: readonly TreeNode[], labels: readonly string[]): HeaderMatch[] {
    const matches: HeaderMatch[] = [];
    for (const node of nodes) {
        if (node.role !== 'edit' && node.role !== 'combo box' && node.role !== 'combobox') continue;
        const canonical = labels.filter((label) => node.label === label || node.label.endsWith(` - ${label}`));
        if (canonical.length > 1) throw new DesktopSetupError('ambiguous_picker');
        if (canonical.length === 1) matches.push({ node, canonical: canonical[0] });
    }
    return matches;
}

function locateSingleHeader(
    snapshot: ParsedSnapshot,
    inputs: readonly string[],
    requiredAction?: string
): HeaderMatch | undefined {
    const headers = matchingHeaders(snapshot.nodes, inputs);
    if (headers.length > 1) throw new DesktopSetupError('ambiguous_picker');
    const header = headers[0];
    return header && (!requiredAction || header.node.actions.has(requiredAction)) ? header : undefined;
}

function isGeneratedAliasEntry(inputs: readonly string[], value: string): boolean {
    return inputs.length === 1 && inputs[0] === 'Alias your server' && /^m[a-f0-9]{8}$/.test(value);
}

function locateEnteredHeader(snapshot: ParsedSnapshot, inputs: readonly string[], value: string): HeaderMatch | undefined {
    const headers = matchingHeaders(snapshot.nodes, inputs).filter((header) => header.node.actions.has('SetValue'));
    if (isGeneratedAliasEntry(inputs, value)) {
        // The Windows provider appends the actual input value to its accessible
        // name, without a Value: field: "Colab CPU - Alias your server m01234567".
        const suffix = 'Colab CPU - Alias your server ' + value;
        for (const node of snapshot.nodes) {
            if (!['edit', 'combo box', 'combobox'].includes(node.role) || !node.actions.has('SetValue')) continue;
            if (node.label === suffix) {
                headers.push({ node: { ...node, value }, canonical: 'Alias your server' });
            }
        }
    }
    if (headers.length > 1) throw new DesktopSetupError('ambiguous_picker');
    return headers[0];
}

function entryMatches(header: HeaderMatch | undefined, canonical: string, inputs: readonly string[], value: string): boolean {
    if (!header || header.canonical !== canonical) return false;
    if (isGeneratedAliasEntry(inputs, value) && header.node.label !== 'Colab CPU - Alias your server'
        && header.node.label !== 'Colab CPU - Alias your server ' + value) return false;
    // An exposed mismatch always fails. Only our own alias may use the following
    // picker as value proof; authentication and arbitrary inputs cannot use this path.
    return header.node.value === value || (header.node.value === undefined && isGeneratedAliasEntry(inputs, value));
}

function locateChoice(
    snapshot: ParsedSnapshot,
    inputs: readonly string[],
    options: readonly string[]
): (HeaderMatch & { node: TreeNode }) | undefined {
    const header = locateSingleHeader(snapshot, inputs);
    if (!header) return undefined;
    const scopedOptions = pickerOptions(snapshot.nodes, header.node);
    const optionMatches = scopedOptions.flatMap((node) => {
        if (node.role !== 'option') return [];
        if (!node.actions.has('Select')) return [];
        const canonical = options.filter((label) => node.label === label);
        if (canonical.length > 1) throw new DesktopSetupError('ambiguous_picker');
        return canonical.length === 1 ? [{ node, canonical: canonical[0] }] : [];
    });
    if (optionMatches.length > 1) throw new DesktopSetupError('ambiguous_picker');
    if (optionMatches.length !== 1) return undefined;
    return optionMatches[0];
}

function pickerOptions(nodes: readonly TreeNode[], header: TreeNode): readonly TreeNode[] {
    const headerPosition = nodes.indexOf(header);
    if (headerPosition < 0) return [];
    let parentDepth = -1;
    for (let index = headerPosition - 1; index >= 0; index--) {
        if (nodes[index].depth < header.depth) {
            parentDepth = nodes[index].depth;
            break;
        }
    }
    let parentEnd = nodes.length;
    for (let index = headerPosition + 1; index < nodes.length; index++) {
        if (nodes[index].depth <= parentDepth) {
            parentEnd = index;
            break;
        }
    }
    const lists = nodes.slice(headerPosition + 1, parentEnd).filter(
        (node) => node.role === 'list' && node.depth === header.depth && node.label === header.label
    );
    if (lists.length > 1) throw new DesktopSetupError('ambiguous_picker');
    if (lists.length !== 1) return [];
    const listPosition = nodes.indexOf(lists[0]);
    let listEnd = parentEnd;
    for (let index = listPosition + 1; index < parentEnd; index++) {
        if (nodes[index].depth <= lists[0].depth) {
            listEnd = index;
            break;
        }
    }
    return nodes.slice(listPosition + 1, listEnd).filter((node) => node.depth > lists[0].depth);
}

function providerMatchesPlatform(platform: string, provider: string): boolean {
    // This release is source-matched only to the observed Windows provider contract.
    return platform === 'win32' && provider === 'orca-computer-use-windows';
}

function validateAllowlist(labels: readonly string[]): readonly string[] {
    if (labels.length === 0 || labels.length > 16 || new Set(labels).size !== labels.length) {
        throw new DesktopSetupError('ambiguous_picker');
    }
    for (const label of labels) validateInternalText(label, 'ambiguous_picker');
    return labels;
}

function validateInternalText(value: string, code: DesktopSetupErrorCode): void {
    if (!value || value.length > 256 || /[\r\n\0]/.test(value)) throw new DesktopSetupError(code);
}

function isSafeEnteredValue(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(value);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DesktopSetupError('cancelled'));
            return;
        }
        const timer = setTimeout(done, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(new DesktopSetupError('cancelled'));
        };
        function done() {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function providerErrorCode(envelope: Record<string, unknown>): string | undefined {
    const error = isObject(envelope.error) ? envelope.error : isObject(envelope.result) && isObject(envelope.result.error) ? envelope.result.error : undefined;
    return error && typeof error.code === 'string' ? error.code : undefined;
}

function objectAt(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
    let current: unknown = value;
    for (const key of keys) {
        if (!isObject(current)) return undefined;
        current = current[key];
    }
    return isObject(current) ? current : undefined;
}

function arrayAt(value: unknown, ...keys: string[]): unknown[] | undefined {
    let current: unknown = value;
    for (const key of keys) {
        if (!isObject(current)) return undefined;
        current = current[key];
    }
    return Array.isArray(current) ? current : undefined;
}

function boolAt(value: unknown, ...keys: string[]): boolean | undefined {
    let current: unknown = value;
    for (const key of keys) {
        if (!isObject(current)) return undefined;
        current = current[key];
    }
    return typeof current === 'boolean' ? current : undefined;
}

function positiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function scalarId(value: unknown): string | undefined {
    if (typeof value === 'string' && value.length > 0 && value.length < 256) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
