import * as assert from 'assert';
import {
    ColabTerminalDependenciesForTest, ColabTerminalError, ColabTerminalLikeForTest, createColabTerminalsForTest
} from '../colabTerminals';

class Source<T> {
    private readonly listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
}

interface FakeTerminal extends ColabTerminalLikeForTest {
    disposeCalls: number;
    pidValue: Promise<number | undefined>;
    disposeAction?: () => void;
}

function terminal(name: string, pid: number | undefined): FakeTerminal {
    return {
        name, pidValue: Promise.resolve(pid), get processId() { return this.pidValue; }, exitStatus: undefined,
        state: { isInteractedWith: false, shell: 'pwsh' }, disposeCalls: 0,
        dispose() { this.disposeCalls++; this.disposeAction?.(); }
    };
}

function harness() {
    let now = 1_800_000_000_000, serial = 0;
    const terminals: FakeTerminal[] = [];
    const events = { open: new Source<FakeTerminal>(), close: new Source<FakeTerminal>(), state: new Source<FakeTerminal>(), start: new Source<FakeTerminal>(), end: new Source<FakeTerminal>() };
    const timers: Array<{ due: number; callback: () => void; disposed: boolean }> = [];
    const deps: ColabTerminalDependenciesForTest = {
        now: () => now, uuid: () => `opaque-${++serial}`, terminals: () => terminals,
        onDidOpen: events.open.event, onDidClose: events.close.event, onDidChangeState: events.state.event,
        onDidStartExecution: events.start.event, onDidEndExecution: events.end.event,
        schedule: (callback, milliseconds) => {
            const timer = { due: now + milliseconds, callback, disposed: false }; timers.push(timer);
            return { dispose: () => { timer.disposed = true; } };
        },
        delay: async () => undefined
    };
    return { terminals, events, deps, manager: createColabTerminalsForTest(deps), advance: (ms: number) => {
        now += ms;
        for (const timer of timers) if (!timer.disposed && timer.due <= now) { timer.disposed = true; timer.callback(); }
    } };
}

function parsed(value: string): any { return JSON.parse(value); }
async function rejectsCode(work: () => Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(work, (error: ColabTerminalError) => error.code === code);
}

const cases: Array<[string, () => Promise<void>]> = [];
function test(name: string, work: () => Promise<void>): void { cases.push([name, work]); }

test('inventory exposes bounded safe metadata without terminal launch details', async () => {
    const h = harness();
    const first = terminal('PowerShell\n' + 'x'.repeat(200), 43152);
    const unresolved = terminal('Unknown PID', undefined);
    unresolved.pidValue = new Promise(() => undefined);
    (first as any).creationOptions = { args: ['secret command'], env: { TOKEN: 'secret' }, cwd: 'private' };
    h.terminals.push(first, unresolved);
    const result = parsed(await h.manager.list());
    assert.strictEqual(result.status, 'terminal_inventory'); assert.strictEqual(result.terminals.length, 2);
    assert.strictEqual(result.terminals[0].processId, 43152); assert.strictEqual(result.terminals[1].processId, null);
    assert.ok(result.terminals[0].name.length <= 120); assert.doesNotMatch(result.terminals[0].name, /\n/);
    assert.strictEqual(JSON.stringify(result).includes('secret'), false); assert.match(result.warning, /cannot prove/);
});

test('new and expired inventories invalidate old opaque references', async () => {
    const h = harness(); h.terminals.push(terminal('one', 1));
    const first = parsed(await h.manager.list()), second = parsed(await h.manager.list());
    await rejectsCode(() => h.manager.close(first.inventoryId, [first.terminals[0].terminalRef]), 'terminal_inventory_stale');
    h.advance(60_001);
    await rejectsCode(() => h.manager.close(second.inventoryId, [second.terminals[0].terminalRef]), 'terminal_inventory_expired');
});

test('foreign, duplicate, and changed references fail before any terminal mutation', async () => {
    for (const mode of ['foreign', 'duplicate', 'changed'] as const) {
        const h = harness(), one = terminal('one', 1), two = terminal('two', 2); h.terminals.push(one, two);
        const inventory = parsed(await h.manager.list());
        const refs = inventory.terminals.map((item: any) => item.terminalRef);
        if (mode === 'changed') { one.state.isInteractedWith = true; h.events.state.fire(one); }
        const action = mode === 'foreign' ? () => h.manager.close(inventory.inventoryId, [refs[0], 'foreign'])
            : mode === 'duplicate' ? () => h.manager.close(inventory.inventoryId, [refs[0], refs[0]])
                : () => h.manager.close(inventory.inventoryId, refs);
        await rejectsCode(action, mode === 'foreign' ? 'terminal_ref_foreign' : mode === 'duplicate' ? 'terminal_refs_invalid' : 'terminal_inventory_changed');
        assert.strictEqual(one.disposeCalls, 0); assert.strictEqual(two.disposeCalls, 0);
    }
});

test('a process id resolving differently makes the whole close preflight stale', async () => {
    const h = harness(), one = terminal('one', undefined), two = terminal('two', 2);
    one.pidValue = new Promise(() => undefined); h.terminals.push(one, two);
    const inventory = parsed(await h.manager.list());
    one.pidValue = Promise.resolve(1234);
    await rejectsCode(() => h.manager.close(inventory.inventoryId, inventory.terminals.map((item: any) => item.terminalRef)), 'terminal_inventory_changed');
    assert.strictEqual(one.disposeCalls + two.disposeCalls, 0);
});

test('explicit closure reports closed, requested, and unknown outcomes without widening selection', async () => {
    const h = harness(), closed = terminal('closed', 1), requested = terminal('requested', 2), failed = terminal('failed', 3), untouched = terminal('untouched', 4);
    h.terminals.push(closed, requested, failed, untouched);
    closed.disposeAction = () => { h.terminals.splice(h.terminals.indexOf(closed), 1); h.events.close.fire(closed); };
    failed.disposeAction = () => { throw new Error('close failed'); };
    const inventory = parsed(await h.manager.list());
    const chosen = inventory.terminals.slice(0, 3).map((item: any) => item.terminalRef);
    const result = parsed(await h.manager.close(inventory.inventoryId, chosen));
    assert.deepStrictEqual(result.results.map((item: any) => item.status), ['closed', 'requested', 'unknown']);
    assert.strictEqual(result.remainingCount, 3); assert.strictEqual(untouched.disposeCalls, 0);
    assert.strictEqual(closed.disposeCalls, 1); assert.strictEqual(requested.disposeCalls, 1); assert.strictEqual(failed.disposeCalls, 1);
});

test('close listener is installed before synchronous disposal confirmation', async () => {
    const h = harness(), one = terminal('one', 1); h.terminals.push(one);
    one.disposeAction = () => { h.events.close.fire(one); h.terminals.length = 0; };
    const inventory = parsed(await h.manager.list());
    const result = parsed(await h.manager.close(inventory.inventoryId, [inventory.terminals[0].terminalRef]));
    assert.strictEqual(result.results[0].status, 'closed'); assert.strictEqual(result.remainingCount, 0);
});

async function main(): Promise<void> {
    let passed = 0;
    for (const [name, work] of cases) { await work(); console.log('PASS ' + name); passed++; }
    console.log(`${passed} Colab terminal tests passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
