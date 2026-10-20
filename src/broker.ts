import * as crypto from 'crypto';
import * as http from 'http';
import { LocalOperation } from './localOperations';
import { isNotebookRef, ListedNotebookGroup, notebookRefFor } from './notebookRefs';
import type { ColabEnvironmentPreflightLocal } from './colabEnvironment';

const BROKER_PROTOCOL = 'jupyter-mcp-window-broker-v1';
const MAX_CONTROL_BODY = 5 * 1024 * 1024;
const PREFLIGHT_TIMEOUT_MS = 30_000;
const MAX_WINDOW_LABEL_CODE_POINTS = 256;

export type BrokerRole = 'broker' | 'peer' | 'blocked' | 'stopped';

export type RoutedNotebook = ListedNotebookGroup;

interface WindowRegistration {
    id: string;
    label: string;
    peerPort: number;
    token: string;
    lastSeen: number;
}

interface BrokerCoordinatorOptions {
    port: number;
    id?: string;
    label: string;
    listLocalNotebooks: () => string[] | Promise<string[]>;
    invokeLocal: (operation: LocalOperation, args: Record<string, unknown>) => Promise<string>;
    handleMcpRequest: (req: http.IncomingMessage, res: http.ServerResponse, router: NotebookRouter) => Promise<void>;
    onRoleChanged?: (role: BrokerRole, url: string | undefined) => void;
    log?: (message: string) => void;
    heartbeatMs?: number;
    staleMs?: number;
    preflightTimeoutMs?: number;
}

export interface NotebookRouter {
    readonly windowId: string;
    readonly windowLabel: string;
    listNotebooks(): Promise<RoutedNotebook[]>;
    inspectColabEnvironmentPreflight(): Promise<string>;
    invokeNotebook(operation: LocalOperation, notebookRef: string, args: Record<string, unknown>): Promise<string>;
    invokeNotebooks(operation: LocalOperation, notebookRefs: string[], args?: Record<string, unknown>): Promise<string>;
    invokeWindow(operation: LocalOperation, args: Record<string, unknown>, windowId?: string): Promise<string>;
}

function record(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000; }
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === 'string' && values.includes(value as T); }
function blocker(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value); }
function version(value: unknown): value is string { return typeof value === 'string' && /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/.test(value); }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function boundedWindowLabel(value: string): string {
    const characters = Array.from(value);
    return characters.length <= MAX_WINDOW_LABEL_CODE_POINTS
        ? value : `${characters.slice(0, MAX_WINDOW_LABEL_CODE_POINTS - 1).join('')}…`;
}

function parseLocalPreflight(text: string): ColabEnvironmentPreflightLocal {
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Peer preflight response exceeded the size bound.');
    const value = record(JSON.parse(text));
    const native = record(value?.nativeBinding), window = record(value?.window), workspace = record(window?.workspace);
    const notebooks = record(window?.notebooks), documents = record(window?.textDocuments), tabs = record(window?.tabs);
    const terminals = record(window?.terminals), debugging = record(window?.debugging), quit = record(window?.quitPolicy);
    const application = record(value?.application);
    if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 || value.readOnly !== true ||
        !native || !oneOf(native.source, ['setting', 'launch_environment', 'none', 'invalid'] as const) ||
        !(native.port === null || (Number.isInteger(native.port) && native.port > 0 && native.port <= 65535)) ||
        typeof native.listenerAvailable !== 'boolean' || !(native.workbenchPageCount === null || count(native.workbenchPageCount)) ||
        native.exactWindowBinding !== 'not-established' || native.correspondenceReason !== 'debug-targets-do-not-expose-vscode-peer-window-ids' ||
        !window || typeof window.localHost !== 'boolean' || typeof window.trusted !== 'boolean' ||
        !workspace || !oneOf(workspace.kind, ['empty', 'single-folder', 'multi-folder', 'workspace'] as const) || !count(workspace.folderCount) ||
        !notebooks || !['total', 'fileBacked', 'untitled', 'dirty', 'visibleEditors'].every(key => count(notebooks[key])) || typeof notebooks.activeEditor !== 'boolean' ||
        !documents || !['total', 'fileBacked', 'untitled', 'dirty', 'blocking', 'visibleEditors'].every(key => count(documents[key])) || typeof documents.activeEditor !== 'boolean' ||
        !tabs || !count(tabs.total) || !count(tabs.dirty) || typeof tabs.benignWelcomeOnly !== 'boolean' ||
        !terminals || !count(terminals.total) || !debugging || typeof debugging.active !== 'boolean' ||
        !quit || !oneOf(quit.confirmBeforeClose, ['never', 'unsupported'] as const) ||
        !oneOf(quit.restoreWindows, ['all', 'folders', 'one', 'none', 'preserve', 'unresolved', 'unsupported'] as const) ||
        !application || !oneOf(application.status, ['verified', 'unsupported', 'unavailable', 'mismatch'] as const) ||
        !version(application.version) || !version(application.supportedVersion) ||
        typeof application.versionSupported !== 'boolean' || !(application.commit === null || /^[0-9a-f]{40}$/.test(application.commit)) ||
        !(application.mainProcessPid === null || (Number.isSafeInteger(application.mainProcessPid) && application.mainProcessPid > 0)) ||
        !oneOf(application.mainProcessIdentity, ['verified', 'mismatch', 'unavailable'] as const) ||
        !oneOf(application.defaultInstall, ['verified', 'unsupported'] as const) ||
        !oneOf(application.startupArguments, ['supported', 'unsupported', 'unavailable'] as const) ||
        !(application.actualWindowCount === null || count(application.actualWindowCount)) ||
        !(application.failureCode === null || blocker(application.failureCode)) ||
        !Array.isArray(value.blockers) || value.blockers.length > 32 || value.blockers.some((item: unknown) => !blocker(item))) {
        throw new Error('Peer returned an invalid preflight response.');
    }
    // Reconstruct the exact public shape so unknown peer fields never cross the MCP boundary.
    return {
        schemaVersion: 1, observedAt: value.observedAt, readOnly: true,
        nativeBinding: {
            source: native.source, port: native.port, listenerAvailable: native.listenerAvailable,
            workbenchPageCount: native.workbenchPageCount, exactWindowBinding: 'not-established',
            correspondenceReason: 'debug-targets-do-not-expose-vscode-peer-window-ids'
        },
        window: {
            localHost: window.localHost, trusted: window.trusted,
            workspace: { kind: workspace.kind, folderCount: workspace.folderCount },
            notebooks: { total: notebooks.total, fileBacked: notebooks.fileBacked, untitled: notebooks.untitled, dirty: notebooks.dirty, visibleEditors: notebooks.visibleEditors, activeEditor: notebooks.activeEditor },
            textDocuments: { total: documents.total, fileBacked: documents.fileBacked, untitled: documents.untitled, dirty: documents.dirty, blocking: documents.blocking, visibleEditors: documents.visibleEditors, activeEditor: documents.activeEditor },
            tabs: { total: tabs.total, dirty: tabs.dirty, benignWelcomeOnly: tabs.benignWelcomeOnly },
            terminals: { total: terminals.total }, debugging: { active: debugging.active },
            quitPolicy: { confirmBeforeClose: quit.confirmBeforeClose, restoreWindows: quit.restoreWindows }
        },
        application: {
            status: application.status, version: application.version, supportedVersion: application.supportedVersion,
            versionSupported: application.versionSupported, commit: application.commit, mainProcessPid: application.mainProcessPid,
            mainProcessIdentity: application.mainProcessIdentity, defaultInstall: application.defaultInstall,
            startupArguments: application.startupArguments, actualWindowCount: application.actualWindowCount,
            failureCode: application.failureCode
        },
        blockers: [...value.blockers]
    };
}

export function aggregateColabEnvironmentPreflight(
    inputs: Array<{ windowId: string; text?: string }>,
    observedAt = Date.now()
): string {
    const parsed = inputs.map(input => {
        if (!uuid(input.windowId)) return { windowId: undefined, observation: undefined };
        try { return { windowId: input.windowId, observation: input.text === undefined ? undefined : parseLocalPreflight(input.text) }; }
        catch { return { windowId: input.windowId, observation: undefined }; }
    });
    const invalidPeerIdCount = parsed.filter(item => item.windowId === undefined).length;
    const available = parsed.filter((item): item is { windowId: string; observation: ColabEnvironmentPreflightLocal } => Boolean(item.windowId && item.observation));
    const unavailablePeerIds = parsed.filter((item): item is { windowId: string; observation: undefined } => Boolean(item.windowId && !item.observation)).map(item => item.windowId).sort();
    const windows = available.map(item => ({
        windowId: item.windowId,
        observedAt: item.observation.observedAt,
        nativeBinding: item.observation.nativeBinding,
        window: item.observation.window,
        blockers: item.observation.blockers
    })).sort((left, right) => left.windowId.localeCompare(right.windowId));
    const applicationValues = available.map(item => item.observation.application);
    const applicationConsistent = applicationValues.length > 0 && applicationValues.every(value => JSON.stringify(value) === JSON.stringify(applicationValues[0]));
    const application = applicationConsistent ? {
        corroboration: 'consistent' as const,
        corroboratedPeerCount: applicationValues.length,
        ...applicationValues[0]
    } : {
        corroboration: applicationValues.length ? 'inconsistent' as const : 'unavailable' as const,
        corroboratedPeerCount: applicationValues.length,
        status: 'unavailable' as const,
        version: null,
        supportedVersion: null,
        versionSupported: false,
        commit: null,
        mainProcessPid: null,
        mainProcessIdentity: 'unavailable' as const,
        defaultInstall: 'unsupported' as const,
        startupArguments: 'unavailable' as const,
        actualWindowCount: null,
        failureCode: applicationValues.length ? 'application_corroboration_inconsistent' : 'application_corroboration_unavailable'
    };
    const actualWindowCount = application.actualWindowCount;
    const connectedPeerCount = inputs.length;
    const blockers = new Set<string>(windows.flatMap(item => item.blockers));
    if (invalidPeerIdCount) blockers.add('invalid_peer_registration');
    if (unavailablePeerIds.length) blockers.add('peer_preflight_unavailable');
    if (!applicationConsistent) blockers.add(applicationValues.length ? 'application_corroboration_inconsistent' : 'application_corroboration_unavailable');
    if (actualWindowCount !== null && actualWindowCount !== connectedPeerCount) blockers.add('connected_peer_count_differs_from_app_window_count');
    if (actualWindowCount !== null && actualWindowCount > 1) blockers.add('multiple_app_windows');
    const completeSingleWindowState = invalidPeerIdCount === 0 && unavailablePeerIds.length === 0 &&
        connectedPeerCount === 1 && available.length === 1 && actualWindowCount === 1 &&
        application.corroboration === 'consistent' && application.status === 'verified';
    const nativeCandidates = completeSingleWindowState ? windows.filter(item => item.blockers.length === 0 &&
        item.nativeBinding.listenerAvailable && (item.nativeBinding.workbenchPageCount ?? 0) > 0).map(item => item.windowId) : [];
    const restartCandidates = windows.filter(item => {
        const remaining = item.blockers.filter(code => code !== 'native_binding_unavailable');
        return completeSingleWindowState && remaining.length === 0 && !item.nativeBinding.listenerAvailable;
    }).map(item => item.windowId);
    const candidateWindowIds = nativeCandidates.length ? nativeCandidates : restartCandidates;
    const supportedNextOperation = candidateWindowIds.length ? {
        status: 'available', tool: 'prepare_colab_environment', candidateWindowIds,
        reasonCode: nativeCandidates.length ? 'native_listener_candidate_requires_exact_prepare_binding' : 'single_empty_window_candidate_requires_prepare_revalidation'
    } : {
        status: 'blocked', tool: null, candidateWindowIds: [] as string[], reasonCode: 'current_mcp_cannot_resolve_preflight_blockers'
    };
    return JSON.stringify({
        schemaVersion: 1, status: 'colab_environment_preflight', readOnly: true, observedAt,
        connectedPeerCount, respondingPeerCount: available.length, unavailablePeerIds, invalidPeerIdCount, application,
        appWindowCountMatchesConnectedPeerCount: actualWindowCount === null ? null : actualWindowCount === connectedPeerCount,
        peerWindowCorrespondence: {
            availability: 'not-exposed', countEqualityDoesNotEstablishMapping: true,
            reason: 'VS Code status window rows do not expose the broker peer UUID or another public exact correspondence field.'
        },
        windows, blockers: [...blockers].sort(), supportedNextOperation,
        snapshot: { retained: false, reason: 'No restart mode consumes a snapshot in this release; every call is point-in-time evidence only.' },
        limitations: [
            'Peer-to-app-window correspondence is not exposed; equal counts do not establish a mapping.',
            'The loopback target catalog does not establish which workbench page belongs to a broker peer; prepare_colab_environment performs its own exact marker binding.',
            'The recommendation gate requires one complete corroborated peer and app window. An already-running native listener may still be usable only if prepare_colab_environment independently passes its marker-bound revalidation.',
            'Startup-argument corroboration reuses the automatic-restart allowlist. A previously bootstrapped debug-port/workspace launch can therefore suppress a recommendation even when the native catalog is reachable; inspection does not prove native readiness failed.',
            'This tool does not save, close, focus, reload, restart, select a runtime, or preserve a reusable restart authorization.'
        ]
    });
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_CONTROL_BODY) throw new Error('Broker control request is too large.');
        chunks.push(buffer);
    }
    if (!chunks.length) return {};
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
    return value as Record<string, unknown>;
}

async function requestJson(url: string, init: RequestInit = {}, timeoutMs = 1500): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const body = typeof init.body === 'string' ? init.body : undefined;
        const headers = { ...init.headers as Record<string, string>, ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}) };
        const request = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: init.method ?? 'GET', headers }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            response.on('end', () => {
                if (timer) clearTimeout(timer);
                try {
                    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                    if ((response.statusCode ?? 500) >= 400) throw new Error(typeof value.error === 'string' ? value.error : `HTTP ${response.statusCode}`);
                    resolve(value);
                } catch (error) { reject(error); }
            });
            response.once('error', (error) => { if (timer) clearTimeout(timer); reject(error); });
            response.once('aborted', () => { if (timer) clearTimeout(timer); reject(new Error('Peer response ended before completion.')); });
        });
        let timer: NodeJS.Timeout | undefined;
        const deadline = Date.now() + timeoutMs;
        const scheduleTimeout = () => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) { request.destroy(new Error(`Peer request timed out after ${timeoutMs} ms.`)); return; }
            timer = setTimeout(scheduleTimeout, Math.min(remaining, 2_147_000_000));
        };
        request.once('error', (error) => { if (timer) clearTimeout(timer); reject(error); });
        scheduleTimeout();
        if (body) request.write(body);
        request.end();
    });
}

function listen(server: http.Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', onError);
            const address = server.address();
            if (!address || typeof address === 'string') return reject(new Error('Could not determine listening port.'));
            resolve(address.port);
        });
    });
}

function close(server: http.Server | undefined): Promise<void> {
    if (!server?.listening) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([work, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Coordinates one externally visible MCP listener and per-window internal operation endpoints. */
export class BrokerCoordinator implements NotebookRouter {
    readonly windowId: string;
    readonly windowLabel: string;

    private readonly token = crypto.randomBytes(24).toString('hex');
    private readonly peers = new Map<string, WindowRegistration>();
    private readonly heartbeatMs: number;
    private readonly staleMs: number;
    private readonly preflightTimeoutMs: number;
    private peerServer?: http.Server;
    private brokerServer?: http.Server;
    private peerPort = 0;
    private brokerPort: number;
    private timer?: NodeJS.Timeout;
    private ticking = false;
    private stopping = false;
    private currentRole: BrokerRole = 'stopped';

    constructor(private readonly options: BrokerCoordinatorOptions) {
        this.windowId = options.id ?? crypto.randomUUID();
        if (!uuid(this.windowId)) throw new Error('Broker window id must be a UUID.');
        this.windowLabel = boundedWindowLabel(options.label);
        this.brokerPort = options.port;
        this.heartbeatMs = options.heartbeatMs ?? 1000;
        this.staleMs = options.staleMs ?? 5000;
        this.preflightTimeoutMs = Math.max(10, Math.min(PREFLIGHT_TIMEOUT_MS, options.preflightTimeoutMs ?? PREFLIGHT_TIMEOUT_MS));
    }

    get role(): BrokerRole { return this.currentRole; }
    get isBroker(): boolean { return this.currentRole === 'broker'; }
    get url(): string | undefined {
        if (this.currentRole !== 'broker' && this.currentRole !== 'peer') return undefined;
        return `http://127.0.0.1:${this.brokerPort}/mcp`;
    }

    async start(): Promise<void> {
        this.stopping = false;
        this.peerServer = http.createServer((req, res) => void this.handlePeerRequest(req, res));
        this.peerPort = await listen(this.peerServer, 0);
        if (!await this.tryBecomeBroker()) await this.registerWithBroker();
        this.timer = setInterval(() => void this.tick(), this.heartbeatMs);
    }

    async stop(): Promise<void> {
        if (this.currentRole === 'stopped' && !this.peerServer && !this.brokerServer) return;
        this.stopping = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (!this.isBroker) await this.unregister().catch(() => undefined);
        await close(this.brokerServer);
        await close(this.peerServer);
        this.brokerServer = undefined;
        this.peerServer = undefined;
        this.peers.clear();
        this.setRole('stopped');
    }

    async listNotebooks(): Promise<RoutedNotebook[]> {
        this.prunePeers();
        const registrations = [...this.peers.values()];
        const groups = await Promise.all(registrations.map(async (registration) => {
            try {
                const uris = registration.id === this.windowId
                    ? await this.options.listLocalNotebooks()
                    : await this.getRemoteNotebooks(registration);
                return { windowId: registration.id, windowLabel: registration.label,
                    notebooks: uris.map((uri) => ({ notebookRef: notebookRefFor(registration.id, uri), uri })) };
            } catch (error) {
                this.options.log?.(`peer ${registration.label} unavailable: ${String(error)}`);
                return { windowId: registration.id, windowLabel: registration.label, notebooks: [] };
            }
        }));
        return groups.sort((a, b) => a.windowLabel.localeCompare(b.windowLabel) || a.windowId.localeCompare(b.windowId));
    }

    async inspectColabEnvironmentPreflight(): Promise<string> {
        this.prunePeers();
        const registrations = [...this.peers.values()];
        const results = await Promise.all(registrations.map(async registration => {
            try {
                const text = await withTimeout(
                    this.invokeRegistration(registration, 'inspect_colab_environment_preflight', {}),
                    this.preflightTimeoutMs,
                    'Peer preflight timed out.'
                );
                return { windowId: registration.id, text };
            } catch {
                return { windowId: registration.id };
            }
        }));
        return aggregateColabEnvironmentPreflight(results);
    }

    async invokeNotebook(operation: LocalOperation, notebookRef: string, args: Record<string, unknown>): Promise<string> {
        const target = await this.resolveNotebook(notebookRef);
        return this.invokeRegistration(target.registration, operation, { ...args, notebookRef: target.uri });
    }

    async invokeNotebooks(operation: LocalOperation, notebookRefs: string[], args: Record<string, unknown> = {}): Promise<string> {
        const targets = await Promise.all(notebookRefs.map((notebookRef) => this.resolveNotebook(notebookRef)));
        const groups = new Map<string, { registration: WindowRegistration; notebookRefs: string[] }>();
        for (const target of targets) {
            const group = groups.get(target.registration.id) ?? { registration: target.registration, notebookRefs: [] };
            group.notebookRefs.push(target.uri);
            groups.set(target.registration.id, group);
        }
        const results = await Promise.all([...groups.values()].map((group) =>
            this.invokeRegistration(group.registration, operation, { ...args, notebookRefs: group.notebookRefs })
        ));
        return results.join('\n\n');
    }

    async invokeWindow(operation: LocalOperation, args: Record<string, unknown>, windowId = this.windowId): Promise<string> {
        this.prunePeers();
        const target = this.peers.get(windowId);
        if (!target) throw new Error(`VS Code window '${windowId}' is not connected to the MCP broker.`);
        return this.invokeRegistration(target, operation, args);
    }

    private selfRegistration(): WindowRegistration {
        return {
            id: this.windowId,
            label: this.windowLabel,
            peerPort: this.peerPort,
            token: this.token,
            lastSeen: Date.now()
        };
    }

    private setRole(role: BrokerRole): void {
        if (role === this.currentRole) return;
        this.currentRole = role;
        this.options.onRoleChanged?.(role, this.url);
    }

    private async tick(): Promise<void> {
        if (this.ticking || this.stopping) return;
        this.ticking = true;
        try {
            if (this.brokerServer?.listening) {
                this.peers.set(this.windowId, this.selfRegistration());
                this.prunePeers();
            } else if (!await this.registerWithBroker()) {
                await this.tryBecomeBroker();
            }
        } finally {
            this.ticking = false;
        }
    }

    private async tryBecomeBroker(): Promise<boolean> {
        if (this.brokerServer?.listening || this.stopping) return Boolean(this.brokerServer?.listening);
        const server = http.createServer((req, res) => void this.handleBrokerRequest(req, res));
        try {
            const port = await listen(server, this.options.port);
            this.brokerServer = server;
            this.brokerPort = port;
            this.peers.clear();
            this.peers.set(this.windowId, this.selfRegistration());
            server.once('close', () => {
                if (this.brokerServer === server) this.brokerServer = undefined;
                if (!this.stopping) this.setRole('blocked');
            });
            this.setRole('broker');
            this.options.log?.(`window ${this.windowLabel} became broker on ${this.url}`);
            return true;
        } catch (error) {
            server.close();
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EADDRINUSE') this.options.log?.(`broker listen failed: ${String(error)}`);
            this.setRole('blocked');
            return false;
        }
    }

    private async registerWithBroker(): Promise<boolean> {
        if (this.options.port === 0) return false;
        try {
            const value = await requestJson(`http://127.0.0.1:${this.options.port}/broker/register`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(this.selfRegistration())
            });
            if (value.protocol !== BROKER_PROTOCOL) return false;
            this.brokerPort = this.options.port;
            this.setRole('peer');
            return true;
        } catch {
            return false;
        }
    }

    private async unregister(): Promise<void> {
        if (this.options.port === 0) return;
        await requestJson(`http://127.0.0.1:${this.options.port}/broker/unregister`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: this.windowId, token: this.token })
        });
    }

    private async handleBrokerRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
            if (req.method === 'GET' && path === '/broker/health') {
                json(res, 200, { protocol: BROKER_PROTOCOL, ownerId: this.windowId });
                return;
            }
            if (req.method === 'POST' && path === '/broker/register') {
                const body = await readJson(req);
                if (!uuid(body.id) || typeof body.label !== 'string' ||
                    typeof body.peerPort !== 'number' || !Number.isInteger(body.peerPort) || body.peerPort <= 0 || body.peerPort > 65535 ||
                    typeof body.token !== 'string' || !/^[0-9a-f]{48}$/.test(body.token)) {
                    json(res, 400, { error: 'Invalid window registration.' });
                    return;
                }
                this.peers.set(body.id, {
                    id: body.id,
                    label: boundedWindowLabel(body.label),
                    peerPort: body.peerPort,
                    token: body.token,
                    lastSeen: Date.now()
                });
                json(res, 200, { protocol: BROKER_PROTOCOL, ownerId: this.windowId });
                return;
            }
            if (req.method === 'POST' && path === '/broker/unregister') {
                const body = await readJson(req);
                const current = typeof body.id === 'string' ? this.peers.get(body.id) : undefined;
                if (current && body.token === current.token) this.peers.delete(current.id);
                json(res, 200, { protocol: BROKER_PROTOCOL });
                return;
            }
            if (path === '/mcp') {
                await this.options.handleMcpRequest(req, res, this);
                return;
            }
            json(res, 404, { error: 'Not found.' });
        } catch (error) {
            this.options.log?.(`broker request error: ${String(error)}`);
            if (!res.headersSent) json(res, 500, { error: String(error) });
        }
    }

    private async handlePeerRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
            if (req.headers['x-jupyter-mcp-token'] !== this.token) {
                json(res, 403, { error: 'Forbidden.' });
                return;
            }
            if (req.method === 'GET' && path === '/peer/notebooks') {
                json(res, 200, { notebooks: await this.options.listLocalNotebooks() });
                return;
            }
            if (req.method === 'POST' && path === '/peer/invoke') {
                const body = await readJson(req);
                if (typeof body.operation !== 'string' || !body.args || typeof body.args !== 'object') {
                    json(res, 400, { error: 'Invalid operation request.' });
                    return;
                }
                const result = await this.options.invokeLocal(body.operation as LocalOperation, body.args as Record<string, unknown>);
                json(res, 200, { result });
                return;
            }
            json(res, 404, { error: 'Not found.' });
        } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    }

    private prunePeers(): void {
        const oldest = Date.now() - this.staleMs;
        for (const [id, registration] of this.peers) {
            if (id !== this.windowId && registration.lastSeen < oldest) this.peers.delete(id);
        }
    }

    private async getRemoteNotebooks(registration: WindowRegistration): Promise<string[]> {
        const value = await requestJson(`http://127.0.0.1:${registration.peerPort}/peer/notebooks`, {
            headers: { 'x-jupyter-mcp-token': registration.token }
        });
        return Array.isArray(value.notebooks) ? value.notebooks.filter((uri): uri is string => typeof uri === 'string') : [];
    }

    private async invokeRegistration(registration: WindowRegistration, operation: LocalOperation, args: Record<string, unknown>): Promise<string> {
        if (registration.id === this.windowId) return this.options.invokeLocal(operation, args);
        const requestedWait = ['run_cells', 'get_execution', 'configure_kernel', 'mount_colab_server', 'get_kernel_setup', 'select_setup_kernel', 'cancel_kernel_setup'].includes(operation) ? args.waitMs : undefined;
        const timeoutMs = operation === 'inspect_colab_environment_preflight' ? this.preflightTimeoutMs :
            typeof requestedWait === 'number' && Number.isSafeInteger(requestedWait) && requestedWait >= 0
            ? Math.max(1500, Math.min(Number.MAX_SAFE_INTEGER, requestedWait + 1500))
            : 2_147_000_000;
        const value = await requestJson(`http://127.0.0.1:${registration.peerPort}/peer/invoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-jupyter-mcp-token': registration.token },
            body: JSON.stringify({ operation, args })
        }, timeoutMs);
        if (typeof value.result !== 'string') throw new Error('Peer returned an invalid operation result.');
        return value.result;
    }

    private async resolveNotebook(notebookRef: string): Promise<{ registration: WindowRegistration; uri: string }> {
        this.prunePeers();
        const groups = await this.listNotebooks();
        const entries = groups.flatMap((group) => group.notebooks.map((notebook) => ({ ...notebook, group })));
        if (isNotebookRef(notebookRef)) {
            const matches = entries.filter((entry) => entry.notebookRef === notebookRef);
            if (matches.length !== 1) throw new Error(`Notebook reference '${notebookRef}' is unknown, stale, or collides with another open notebook.`);
            const registration = this.peers.get(matches[0].group.windowId);
            if (!registration) throw new Error(`VS Code window '${matches[0].group.windowId}' disconnected while resolving notebook reference.`);
            return { registration, uri: matches[0].uri };
        }
        if (notebookRef.startsWith('nb_')) throw new Error(`Malformed notebook reference '${notebookRef}'. Use a notebookRef from list_notebooks.`);
        const matches = entries.filter((entry) => entry.uri.toLowerCase() === notebookRef.toLowerCase());
        if (matches.length === 0) throw new Error(`No connected VS Code window has notebook '${notebookRef}' open. Use list_notebooks to list them.`);
        if (matches.length > 1) {
            const choices = matches.map((match) => `${match.group.windowLabel}: ${match.notebookRef}`).join('\n');
            throw new Error(`Notebook '${notebookRef}' is open in ${matches.length} VS Code windows. Pass one of these notebookRef values as notebookRef:\n${choices}`);
        }
        const match = matches[0];
        const registration = this.peers.get(match.group.windowId);
        if (!registration) throw new Error(`VS Code window '${match.group.windowId}' disconnected while routing the request.`);
        return { registration, uri: match.uri };
    }
}
