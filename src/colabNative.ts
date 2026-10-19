import * as http from 'http';
import { randomUUID } from 'crypto';
import { DesktopSetupChoice, DesktopSetupDriver, DesktopSetupError } from './colabDesktop';

const MAX_BYTES = 256 * 1024;
const MAX_TARGETS = 16;
const INPUT = '.quick-input-widget .quick-input-box input';
const SAFE_OPTIONS = new Set(['Select Another Kernel...', 'Colab', 'New Colab Server', 'CPU', 'Standard', 'Latest']);
interface Timing { commandMs: number; pickerMs: number; pollMs: number; }
const TIMING: Timing = { commandMs: 10_000, pickerMs: 90_000, pollMs: 200 };
interface NativeTarget { id: string; type: string; url: string; webSocketDebuggerUrl?: string; }
interface Row { label: string; description: string; detail: string; disabled: boolean; }
interface Snapshot {
    dom: boolean; markers: number; widgets: number; inputCount: number; title: string; placeholder: string;
    ariaLabel: string; value: string; active: boolean; incomplete: boolean; rows: Row[];
}
export interface ColabNativeSession {
    evaluate(expression: string, signal: AbortSignal): Promise<unknown>;
    dispose(): void;
}
export interface ColabNativeTransport {
    targets(port: number, signal: AbortSignal): Promise<NativeTarget[]>;
    connect(url: string, signal: AbortSignal): Promise<ColabNativeSession>;
}

function alive(signal: AbortSignal): void {
    if (signal.aborted) throw new DesktopSetupError('cancelled');
}
function failed(): DesktopSetupError { return new DesktopSetupError('action_failed'); }
function pause(ms: number, signal: AbortSignal): Promise<void> {
    alive(signal);
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DesktopSetupError('cancelled')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}
function boundedString(value: unknown, max = 512): value is string {
    return typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value);
}
function validPort(port: number): boolean { return Number.isInteger(port) && port > 0 && port <= 65535; }
function validateDebuggerUrl(value: string, port: number): void {
    let url: URL;
    try { url = new URL(value); } catch { throw new DesktopSetupError('native_debug_unavailable'); }
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port ||
        url.username || url.password || url.search || url.hash || !/^\/devtools\/page\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
        throw new DesktopSetupError('native_debug_unavailable');
    }
}

// Fixed, bounded projections only. No caller-supplied script, selector, or CDP method is exposed.
function snapshotExpression(marker: string): string {
    return `(() => {
        const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const text = e => (e?.textContent || '').trim();
        const markers = [...document.querySelectorAll('.statusbar-item-label')].filter(e => text(e) === ${JSON.stringify(marker)}).length;
        const widgets = [...document.querySelectorAll('.quick-input-widget')].filter(visible);
        const w = widgets.length === 1 ? widgets[0] : null;
        const inputs = w ? [...w.querySelectorAll('.quick-input-box input')].filter(visible) : [];
        const input = inputs.length === 1 ? inputs[0] : null;
        const rows = w ? [...w.querySelectorAll('.quick-input-list .monaco-list-row')].map(e => ({
            label: text(e.querySelector('.label-name')), description: text(e.querySelector('.label-description')),
            detail: text(e.querySelector('.label-detail')), disabled: e.getAttribute('aria-disabled') === 'true'
        })).filter(e => e.label) : [];
        const incomplete = !!w && (inputs.length !== 1 || rows.length > 128 ||
            !!w.querySelector('.monaco-progress-container.active') ||
            [...w.querySelectorAll('.quick-input-list .monaco-scrollable-element')].some(e => e.scrollHeight > e.clientHeight + 2));
        return {dom:true, markers, widgets:widgets.length, inputCount:document.querySelectorAll(${JSON.stringify(INPUT)}).length, title:text(w?.querySelector('.quick-input-title')),
            placeholder:input?.getAttribute('placeholder') || '', ariaLabel:input?.getAttribute('aria-label') || '',
            value:input?.value || '', active:!!input && document.activeElement === input, incomplete,
            rows:rows.slice(0,129)};
    })()`;
}
function parseSnapshot(raw: unknown): Snapshot {
    if (!raw || typeof raw !== 'object') throw failed();
    const v = raw as Partial<Snapshot>;
    if (v.dom !== true) throw failed();
    if (!Number.isInteger(v.markers) || !Number.isInteger(v.widgets) || !Number.isInteger(v.inputCount) ||
        !['title', 'placeholder', 'ariaLabel', 'value'].every(k => boundedString(v[k as keyof Snapshot])) ||
        typeof v.active !== 'boolean' || typeof v.incomplete !== 'boolean' || !Array.isArray(v.rows) || v.rows.length > 128 ||
        v.rows.some(r => !r || !boundedString(r.label, 256) || !r.label || !boundedString(r.description) ||
            !boundedString(r.detail) || typeof r.disabled !== 'boolean')) throw failed();
    return v as Snapshot;
}
function header(snapshot: Snapshot, allowed: readonly string[]): string | undefined {
    if (snapshot.widgets > 1) throw new DesktopSetupError('ambiguous_picker');
    if (snapshot.widgets !== 1) return undefined;
    const names = [snapshot.title, snapshot.placeholder, snapshot.ariaLabel];
    const matches = allowed.filter(label => names.some(name => name === label || name.endsWith(' - ' + label)));
    if (matches.length > 1) throw new DesktopSetupError('ambiguous_picker');
    return matches[0];
}
function labels(values: readonly string[]): readonly string[] {
    if (!values.length || values.length > 8 || new Set(values).size !== values.length || values.some(v => !boundedString(v, 256) || !v)) throw failed();
    return values;
}
function rowKey(row: Row): string { return JSON.stringify(row); }
function rowsKey(rows: Row[]): string { return JSON.stringify(rows); }

class NativeDriver implements DesktopSetupDriver {
    private session?: ColabNativeSession;
    private marker?: string;
    private choices?: { headers: readonly string[]; rows: string; items: Map<string, Row>; };
    private disposed = false;
    constructor(private port: number, private transport: ColabNativeTransport, private timing: Timing) {}

    async bind(marker: string, signal: AbortSignal): Promise<void> {
        alive(signal);
        if (this.disposed || this.session || !/^MCP Colab setup [a-f0-9-]{36}$/.test(marker)) throw new DesktopSetupError('window_binding_failed');
        if (!validPort(this.port)) throw new DesktopSetupError('native_debug_unavailable');
        const targets = await this.transport.targets(this.port, signal);
        if (!Array.isArray(targets) || targets.length > MAX_TARGETS) throw new DesktopSetupError('window_binding_failed');
        const matches: ColabNativeSession[] = [];
        try {
            for (const target of targets) {
                alive(signal);
                if (target.type !== 'page' || typeof target.url !== 'string' || !/\/workbench(?:\.html)?(?:[?#]|$)/.test(target.url)) continue;
                if (typeof target.webSocketDebuggerUrl !== 'string') throw new DesktopSetupError('native_debug_unavailable');
                validateDebuggerUrl(target.webSocketDebuggerUrl, this.port);
                const session = await this.transport.connect(target.webSocketDebuggerUrl, signal);
                let keep = false;
                try {
                    const raw = await session.evaluate(snapshotExpression(marker), signal);
                    const snapshot = parseSnapshot(raw);
                    if (snapshot.markers > 1) throw new DesktopSetupError('window_binding_failed');
                    if (snapshot.markers === 1) { matches.push(session); keep = true; }
                } finally { if (!keep) session.dispose(); }
            }
            alive(signal);
            if (matches.length !== 1) throw new DesktopSetupError('window_binding_failed');
            this.marker = marker; this.session = matches[0];
            await this.snapshot(signal); // exact marker still owns this renderer
        } catch (error) {
            matches.forEach(s => s.dispose()); this.session = undefined;
            throw error instanceof DesktopSetupError ? error : new DesktopSetupError('native_debug_unavailable');
        }
    }
    async waitForInput(inputLabels: readonly string[], signal: AbortSignal): Promise<string> {
        const inputs = labels(inputLabels);
        return (await this.poll(inputs, signal)).name;
    }
    async choose(inputLabels: readonly string[], optionLabels: readonly string[], signal: AbortSignal): Promise<string> {
        const inputs = labels(inputLabels), options = labels(optionLabels);
        const aliasPicker = inputs.length === 1 && ['Select a Jupyter Server', 'Mount Server to Workspace'].includes(inputs[0]);
        if (options.some(o => !SAFE_OPTIONS.has(o) && !(aliasPicker && /^m[a-f0-9]{8}$/.test(o)))) throw failed();
        const found = await this.poll(inputs, signal, s => s.rows.some(r => options.includes(r.label) && !r.disabled));
        const rows = found.snapshot.rows.filter(r => options.includes(r.label) && !r.disabled);
        if (rows.length !== 1) throw new DesktopSetupError('ambiguous_picker');
        await this.select(inputs, rows[0], signal);
        return rows[0].label;
    }
    async enter(inputLabels: readonly string[], value: string, signal: AbortSignal): Promise<void> {
        const inputs = labels(inputLabels);
        if (inputs.length !== 1 || inputs[0] !== 'Alias your server' || !/^m[a-f0-9]{8}$/.test(value)) throw failed();
        const first = await this.poll(inputs, signal);
        this.requireCpu(first.snapshot);
        await this.setValue(value, inputs, signal, undefined, true);
        const proof = await this.snapshot(signal);
        this.requireCpu(proof);
        if (header(proof, inputs) !== inputs[0] || proof.value !== value || !proof.active) throw failed();
        await this.submit(inputs, value, signal, undefined, true);
    }
    async listChoices(inputLabels: readonly string[], signal: AbortSignal): Promise<DesktopSetupChoice[]> {
        const inputs = labels(inputLabels);
        if (inputs.length !== 1 || !/^Select a Kernel from m[a-f0-9]{8}$/.test(inputs[0])) throw failed();
        this.choices = undefined;
        const found = await this.poll(inputs, signal, s => s.rows.length > 0);
        const s = found.snapshot;
        if (s.value || s.incomplete || s.rows.some(r => r.disabled)) throw new DesktopSetupError('kernel_choices_incomplete');
        if (new Set(s.rows.map(r => r.label)).size !== s.rows.length) throw new DesktopSetupError('ambiguous_picker');
        const items = new Map(s.rows.map(row => [randomUUID(), row]));
        this.choices = { headers: [...inputs], rows: rowsKey(s.rows), items };
        return [...items].map(([choiceId, row]) => ({ choiceId, label: row.label }));
    }
    async chooseListed(inputLabels: readonly string[], choiceId: string, signal: AbortSignal): Promise<void> {
        const inputs = labels(inputLabels), listing = this.choices;
        this.choices = undefined; // a listing is single-use, including failures
        const row = listing?.items.get(choiceId);
        if (!listing || !row || JSON.stringify(inputs) !== JSON.stringify(listing.headers)) throw new DesktopSetupError('kernel_choice_stale');
        const proof = await this.snapshot(signal);
        if (!header(proof, inputs) || proof.value || proof.incomplete || rowsKey(proof.rows) !== listing.rows) throw new DesktopSetupError('kernel_choice_stale');
        await this.select(inputs, row, signal);
    }
    dispose(): void { this.disposed = true; this.choices = undefined; this.session?.dispose(); this.session = undefined; }
    private async snapshot(signal: AbortSignal): Promise<Snapshot> {
        alive(signal);
        if (this.disposed || !this.session || !this.marker) throw new DesktopSetupError('window_binding_failed');
        const s = parseSnapshot(await this.session.evaluate(snapshotExpression(this.marker), signal));
        alive(signal);
        if (s.markers !== 1) throw new DesktopSetupError('window_binding_failed');
        return s;
    }
    private async poll(inputs: readonly string[], signal: AbortSignal, ready: (s: Snapshot) => boolean = () => true): Promise<{ snapshot: Snapshot; name: string }> {
        const deadline = Date.now() + this.timing.pickerMs;
        while (true) {
            const s = await this.snapshot(signal), name = header(s, inputs);
            if (name && ready(s)) return { snapshot: s, name };
            if (Date.now() >= deadline) throw new DesktopSetupError('picker_timeout');
            await pause(this.timing.pollMs, signal);
        }
    }
    private requireCpu(s: Snapshot): void {
        if (s.ariaLabel !== 'Colab CPU - Alias your server' && !(s.title === 'Colab CPU' && s.placeholder === 'Alias your server')) throw new DesktopSetupError('cpu_selection_unconfirmed');
    }
    private async setValue(value: string, inputs: readonly string[], signal: AbortSignal, row?: Row, cpu = false): Promise<void> {
        const expression = `(() => {
            const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
            const text = e => (e?.textContent || '').trim();
            const markers = [...document.querySelectorAll('.statusbar-item-label')].filter(e => text(e) === ${JSON.stringify(this.marker)});
            const widgets = [...document.querySelectorAll('.quick-input-widget')].filter(visible);
            const allInputs = [...document.querySelectorAll(${JSON.stringify(INPUT)})];
            if (markers.length !== 1 || widgets.length !== 1 || allInputs.length !== 1) return false;
            const widget = widgets[0], input = allInputs[0];
            const widgetInputs = [...widget.querySelectorAll('.quick-input-box input')].filter(visible);
            if (widgetInputs.length !== 1 || widgetInputs[0] !== input || document.activeElement !== input || !visible(input)) return false;
            const labels = ${JSON.stringify(inputs)}, expectedRow = ${JSON.stringify(row ?? null)};
            const title = text(widget.querySelector('.quick-input-title')), placeholder = input.getAttribute('placeholder') || '', aria = input.getAttribute('aria-label') || '';
            if (labels.filter(label => [title,placeholder,aria].some(name => name === label || name.endsWith(' - ' + label))).length !== 1) return false;
            if (expectedRow) {
                const rows = [...widget.querySelectorAll('.quick-input-list .monaco-list-row')].map(e => ({
                    label:text(e.querySelector('.label-name')),description:text(e.querySelector('.label-description')),
                    detail:text(e.querySelector('.label-detail')),disabled:e.getAttribute('aria-disabled') === 'true'
                })).filter(r => r.label);
                if (rows.filter(r => JSON.stringify(r) === JSON.stringify(expectedRow) && !r.disabled).length !== 1) return false;
            }
            if (${cpu} && aria !== 'Colab CPU - Alias your server' && !(title === 'Colab CPU' && placeholder === 'Alias your server')) return false;
            input.value = ${JSON.stringify(value)};
            input.dispatchEvent(new Event('input', {bubbles:true,cancelable:true}));
            return input.value === ${JSON.stringify(value)};
        })()`;
        alive(signal); if (await this.session!.evaluate(expression, signal) !== true) throw failed();
    }
    private async select(inputs: readonly string[], row: Row, signal: AbortSignal): Promise<void> {
        const before = await this.snapshot(signal);
        if (!header(before, inputs) || before.rows.filter(r => rowKey(r) === rowKey(row) && !r.disabled).length !== 1) throw new DesktopSetupError('kernel_choice_stale');
        await this.setValue(row.label, inputs, signal, row);
        // Filtering is asynchronous. Do not press Enter while another item could be active.
        const filtered = await this.poll(inputs, signal, s => s.value === row.label && s.rows.length === 1 && rowKey(s.rows[0]) === rowKey(row));
        if (!filtered.snapshot.active || filtered.snapshot.incomplete) throw failed();
        const proof = await this.snapshot(signal);
        if (!header(proof, inputs) || proof.value !== row.label || !proof.active || proof.rows.length !== 1 || rowKey(proof.rows[0]) !== rowKey(row)) throw new DesktopSetupError('kernel_choice_stale');
        await this.submit(inputs, row.label, signal, row);
    }
    private async submit(inputs: readonly string[], value: string, signal: AbortSignal, row?: Row, cpu = false): Promise<void> {
        alive(signal);
        // Validate and dispatch synchronously in one renderer turn. The event is
        // targeted to the proved input object, never to whichever control has focus
        // when a later generic CDP key command eventually arrives.
        const expression = `(() => {
            const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
            const widgets = [...document.querySelectorAll('.quick-input-widget')].filter(visible);
            const inputs = [...document.querySelectorAll(${JSON.stringify(INPUT)})];
            if (widgets.length !== 1 || inputs.length !== 1) return false;
            const widget = widgets[0], input = inputs[0], labels = ${JSON.stringify(inputs)}, expectedRow = ${JSON.stringify(row ?? null)};
            const text = e => (e?.textContent || '').trim();
            const check = () => {
                const markers = [...document.querySelectorAll('.statusbar-item-label')].filter(e => text(e) === ${JSON.stringify(this.marker)});
                const currentWidgets = [...document.querySelectorAll('.quick-input-widget')].filter(visible);
                const currentInputs = [...document.querySelectorAll(${JSON.stringify(INPUT)})];
                if (markers.length !== 1 || currentWidgets.length !== 1 || currentWidgets[0] !== widget ||
                    currentInputs.length !== 1 || currentInputs[0] !== input || document.activeElement !== input ||
                    !visible(input) || input.value !== ${JSON.stringify(value)}) return false;
                const title = text(widget.querySelector('.quick-input-title')), placeholder = input.getAttribute('placeholder') || '', aria = input.getAttribute('aria-label') || '';
                if (labels.filter(label => [title,placeholder,aria].some(name => name === label || name.endsWith(' - ' + label))).length !== 1) return false;
                if (${cpu} && aria !== 'Colab CPU - Alias your server' && !(title === 'Colab CPU' && placeholder === 'Alias your server')) return false;
                if (expectedRow) {
                    const rows = [...widget.querySelectorAll('.quick-input-list .monaco-list-row')].map(e => ({
                        label:text(e.querySelector('.label-name')),description:text(e.querySelector('.label-description')),
                        detail:text(e.querySelector('.label-detail')),disabled:e.getAttribute('aria-disabled') === 'true'
                    })).filter(r => r.label);
                    if (rows.length !== 1 || JSON.stringify(rows[0]) !== JSON.stringify(expectedRow) ||
                        widget.querySelector('.monaco-progress-container.active')) return false;
                }
                return true;
            };
            if (!check()) return false;
            input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
            input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
            return true;
        })()`;
        if (await this.session!.evaluate(expression, signal) !== true) throw failed();
    }
}

class CdpSession implements ColabNativeSession {
    private nextId = 0;
    private closed = false;
    private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; clean(): void }>();
    private constructor(private socket: WebSocket, private timeout: number) {
        socket.addEventListener('message', event => {
            try {
                if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_BYTES) throw failed();
                const message = JSON.parse(event.data);
                const request = this.pending.get(message.id);
                if (!request) return;
                this.pending.delete(message.id); request.clean();
                if (message.error) request.reject(failed()); else request.resolve(message.result);
            } catch { this.dispose(); }
        });
        socket.addEventListener('close', () => this.dispose());
        socket.addEventListener('error', () => this.dispose());
    }
    static async connect(url: string, signal: AbortSignal, timeout: number): Promise<CdpSession> {
        alive(signal);
        if (typeof WebSocket !== 'function') throw new DesktopSetupError('native_driver_unavailable');
        const socket = new WebSocket(url), session = new CdpSession(socket, timeout);
        try { await new Promise<void>((resolve, reject) => {
            const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); socket.removeEventListener('open', open); socket.removeEventListener('error', error); socket.removeEventListener('close', error); };
            const error = () => { clean(); session.dispose(); reject(new DesktopSetupError('native_debug_unavailable')); };
            const abort = () => { clean(); session.dispose(); reject(new DesktopSetupError('cancelled')); };
            const open = () => { clean(); resolve(); };
            const timer = setTimeout(error, timeout);
            signal.addEventListener('abort', abort, { once: true }); socket.addEventListener('open', open, { once: true });
            socket.addEventListener('error', error, { once: true }); socket.addEventListener('close', error, { once: true });
            if (signal.aborted) abort();
        });
        alive(signal); return session;
        } catch (error) { session.dispose(); throw error; }
    }
    async evaluate(expression: string, signal: AbortSignal): Promise<unknown> {
        const response = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, signal) as { exceptionDetails?: unknown; result?: { value?: unknown } };
        if (!response || response.exceptionDetails || !response.result || !Object.hasOwn(response.result, 'value')) throw failed();
        return response.result.value;
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        for (const request of this.pending.values()) { request.clean(); request.reject(failed()); }
        this.pending.clear(); try { this.socket.close(); } catch { /* Already closed or never opened. */ }
    }
    private command(method: string, params: object, signal: AbortSignal): Promise<unknown> {
        alive(signal);
        if (this.closed) return Promise.reject(failed());
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
            const abort = () => { this.pending.delete(id); clean(); reject(new DesktopSetupError('cancelled')); this.dispose(); };
            const timer = setTimeout(() => { this.pending.delete(id); clean(); reject(failed()); this.dispose(); }, this.timeout);
            this.pending.set(id, { resolve, reject, clean }); signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) { abort(); return; }
            try { this.socket.send(JSON.stringify({ id, method, params })); } catch { this.dispose(); }
        });
    }
}

async function targets(port: number, signal: AbortSignal): Promise<NativeTarget[]> {
    alive(signal);
    if (!validPort(port)) throw new DesktopSetupError('native_debug_unavailable');
    return new Promise((resolve, reject) => {
        let settled = false, bytes = 0; const chunks: Buffer[] = [];
        const finish = (error?: Error, value?: NativeTarget[]) => {
            if (settled) return; settled = true; clearTimeout(timer);
            if (error) { request.destroy(); reject(error); } else resolve(value!);
        };
        const request = http.get({ hostname: '127.0.0.1', port, path: '/json/list', agent: false, signal }, response => {
            if (response.statusCode !== 200) { response.resume(); finish(new DesktopSetupError('native_debug_unavailable')); return; }
            response.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > MAX_BYTES) finish(new DesktopSetupError('native_debug_unavailable')); else chunks.push(chunk);
            });
            response.on('error', () => finish(new DesktopSetupError('native_debug_unavailable')));
            response.on('end', () => {
                if (settled) return;
                try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!Array.isArray(result)) throw failed(); finish(undefined, result); }
                catch { finish(new DesktopSetupError('native_debug_unavailable')); }
            });
        });
        const timer = setTimeout(() => finish(new DesktopSetupError('native_debug_unavailable')), TIMING.commandMs);
        request.on('error', () => finish(new DesktopSetupError(signal.aborted ? 'cancelled' : 'native_debug_unavailable')));
    });
}
const transport: ColabNativeTransport = { targets, connect: (url, signal) => CdpSession.connect(url, signal, TIMING.commandMs) };
export function createColabNativeDriver(port = 0): DesktopSetupDriver {
    const resolved = port === 0 ? Number(process.env.JUPYTER_MCP_NATIVE_DEBUG_PORT ?? 0) : port;
    return new NativeDriver(resolved, transport, TIMING);
}
export function createColabNativeDriverForTest(port: number, testTransport: ColabNativeTransport, timing: Partial<Timing> = {}): DesktopSetupDriver {
    return new NativeDriver(port, testTransport, { ...TIMING, ...timing });
}
export function connectColabNativeSessionForTest(url: string, signal: AbortSignal, timeoutMs = 50): Promise<ColabNativeSession> {
    return CdpSession.connect(url, signal, timeoutMs);
}
