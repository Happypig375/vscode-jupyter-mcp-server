import * as crypto from 'crypto';
import * as http from 'http';
import { LocalOperation } from './localOperations';

const BROKER_PROTOCOL = 'jupyter-mcp-window-broker-v1';
const MAX_CONTROL_BODY = 5 * 1024 * 1024;

export type BrokerRole = 'broker' | 'peer' | 'blocked' | 'stopped';

export interface RoutedNotebook {
    notebookId: string;
    uri: string;
    windowId: string;
    windowLabel: string;
}

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
}

export interface NotebookRouter {
    readonly windowId: string;
    readonly windowLabel: string;
    listNotebooks(): Promise<RoutedNotebook[]>;
    invokeNotebook(operation: LocalOperation, notebookRef: string, args: Record<string, unknown>): Promise<string>;
    invokeNotebooks(operation: LocalOperation, notebookRefs: string[], args?: Record<string, unknown>): Promise<string>;
    invokeWindow(operation: LocalOperation, args: Record<string, unknown>, windowId?: string): Promise<string>;
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

async function requestJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(1500) });
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `HTTP ${response.status}`);
    return value;
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

/** Coordinates one externally visible MCP listener and per-window internal operation endpoints. */
export class BrokerCoordinator implements NotebookRouter {
    readonly windowId: string;
    readonly windowLabel: string;

    private readonly token = crypto.randomBytes(24).toString('hex');
    private readonly peers = new Map<string, WindowRegistration>();
    private readonly heartbeatMs: number;
    private readonly staleMs: number;
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
        this.windowLabel = options.label;
        this.brokerPort = options.port;
        this.heartbeatMs = options.heartbeatMs ?? 1000;
        this.staleMs = options.staleMs ?? 5000;
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
                return uris.map((uri) => ({
                    notebookId: `${registration.id}::${uri}`,
                    uri,
                    windowId: registration.id,
                    windowLabel: registration.label
                }));
            } catch (error) {
                this.options.log?.(`peer ${registration.label} unavailable: ${String(error)}`);
                return [];
            }
        }));
        return groups.flat().sort((a, b) => a.windowLabel.localeCompare(b.windowLabel) || a.uri.localeCompare(b.uri));
    }

    async invokeNotebook(operation: LocalOperation, notebookRef: string, args: Record<string, unknown>): Promise<string> {
        const target = await this.resolveNotebook(notebookRef);
        return this.invokeRegistration(target.registration, operation, { ...args, filePath: target.uri });
    }

    async invokeNotebooks(operation: LocalOperation, notebookRefs: string[], args: Record<string, unknown> = {}): Promise<string> {
        const targets = await Promise.all(notebookRefs.map((notebookRef) => this.resolveNotebook(notebookRef)));
        const groups = new Map<string, { registration: WindowRegistration; filePaths: string[] }>();
        for (const target of targets) {
            const group = groups.get(target.registration.id) ?? { registration: target.registration, filePaths: [] };
            group.filePaths.push(target.uri);
            groups.set(target.registration.id, group);
        }
        const results = await Promise.all([...groups.values()].map((group) =>
            this.invokeRegistration(group.registration, operation, { ...args, filePaths: group.filePaths })
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
                if (typeof body.id !== 'string' || typeof body.label !== 'string' || typeof body.peerPort !== 'number' || typeof body.token !== 'string') {
                    json(res, 400, { error: 'Invalid window registration.' });
                    return;
                }
                this.peers.set(body.id, {
                    id: body.id,
                    label: body.label,
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
        const value = await requestJson(`http://127.0.0.1:${registration.peerPort}/peer/invoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-jupyter-mcp-token': registration.token },
            body: JSON.stringify({ operation, args })
        });
        if (typeof value.result !== 'string') throw new Error('Peer returned an invalid operation result.');
        return value.result;
    }

    private async resolveNotebook(notebookRef: string): Promise<{ registration: WindowRegistration; uri: string }> {
        this.prunePeers();
        const separator = notebookRef.indexOf('::');
        if (separator > 0) {
            const id = notebookRef.slice(0, separator);
            const registration = this.peers.get(id);
            if (!registration) throw new Error(`The VS Code window in notebookId '${notebookRef}' is no longer connected.`);
            return { registration, uri: notebookRef.slice(separator + 2) };
        }

        const matches = (await this.listNotebooks()).filter((notebook) => notebook.uri.toLowerCase() === notebookRef.toLowerCase());
        if (matches.length === 0) throw new Error(`No connected VS Code window has notebook '${notebookRef}' open. Use list_notebooks to list them.`);
        if (matches.length > 1) {
            const choices = matches.map((match) => `${match.windowLabel}: ${match.notebookId}`).join('\n');
            throw new Error(`Notebook '${notebookRef}' is open in ${matches.length} VS Code windows. Pass one of these notebookId values as filePath:\n${choices}`);
        }
        const match = matches[0];
        const registration = this.peers.get(match.windowId);
        if (!registration) throw new Error(`VS Code window '${match.windowId}' disconnected while routing the request.`);
        return { registration, uri: match.uri };
    }
}
