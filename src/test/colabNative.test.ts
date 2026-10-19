import * as assert from 'assert';
import * as vm from 'vm';
import { createColabNativeDriverForTest, connectColabNativeSessionForTest, ColabNativeSession, ColabNativeTransport } from '../colabNative';
import { DesktopSetupErrorCode } from '../colabDesktop';

const MARKER = 'MCP Colab setup 12345678-1234-1234-1234-123456789abc';
const SIGNAL = new AbortController().signal;
const KERNEL_HEADER = 'Select a Kernel from m12345678';
const TARGET = { id: 'owner', type: 'page', url: 'vscode-file://vscode-app/workbench/workbench.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/owner' };

class Fixture implements ColabNativeSession {
    markerCount = 1; widgets = 1; hiddenInputs = 0; active = true; incomplete = false; busy = false;
    title = KERNEL_HEADER; placeholder = KERNEL_HEADER; ariaLabel = KERNEL_HEADER; value = '';
    rows = [{ label: 'Kernel A', description: 'first environment', detail: '', disabled: false }, { label: 'Kernel B', description: '', detail: '', disabled: false }];
    writes: string[] = []; inputEvents: Array<{ bubbles: boolean; cancelable: boolean }> = []; submits = 0; disposed = false; evaluations: string[] = [];
    beforeEvaluate?: (expression: string) => void;
    async evaluate(expression: string): Promise<unknown> {
        this.evaluations.push(expression);
        this.beforeEvaluate?.(expression);
        const input: any = {
            getClientRects: () => [1],
            getAttribute: (name: string) => name === 'placeholder' ? this.placeholder : name === 'aria-label' ? this.ariaLabel : null,
            dispatchEvent: (event: { type: string; bubbles?: boolean; cancelable?: boolean }) => {
                if (event.type === 'input') this.inputEvents.push({ bubbles: event.bubbles === true, cancelable: event.cancelable === true });
                if (event.type === 'keydown') this.submits++;
                return true;
            }
        };
        Object.defineProperty(input, 'value', { get: () => this.value, set: (value: string) => { this.writes.push(value); this.value = value; } });
        const selectedRows = this.rows.filter(r => !this.value || r.label.toLowerCase().includes(this.value.toLowerCase()));
        const widget = {
            getClientRects: () => [1],
            querySelector: (selector: string) => selector === '.quick-input-title' ? { textContent: this.title } :
                selector === '.monaco-progress-container.active' && this.busy ? {} : null,
            querySelectorAll: (selector: string) => {
                if (selector === '.quick-input-box input') return [input];
                if (selector === '.quick-input-list .monaco-scrollable-element') return [{ scrollHeight: this.incomplete ? 200 : 100, clientHeight: 100 }];
                if (selector === '.quick-input-list .monaco-list-row') return selectedRows.map(row => ({
                    querySelector: (s: string) => ({ textContent: s === '.label-name' ? row.label : s === '.label-description' ? row.description : row.detail }),
                    getAttribute: () => String(row.disabled)
                }));
                throw new Error('unexpected selector');
            }
        };
        return await vm.runInNewContext(expression, {
            document: { querySelectorAll: (selector: string) => selector === '.statusbar-item-label' ? Array.from({ length: this.markerCount }, () => ({textContent:MARKER})) :
                selector === '.quick-input-widget .quick-input-box input' ? [...Array.from({length:this.hiddenInputs},()=>({})),input] : Array.from({ length: this.widgets }, () => widget), activeElement: this.active ? input : undefined },
            getComputedStyle: () => ({ visibility: 'visible' }),
            Event: class { type: string; bubbles: boolean; cancelable: boolean; constructor(type: string, options: { bubbles?: boolean; cancelable?: boolean } = {}) { this.type = type; this.bubbles = options.bubbles === true; this.cancelable = options.cancelable === true; } },
            KeyboardEvent: class { constructor(public type: string, public options: object) {} }
        });
    }
    dispose(): void { this.disposed = true; }
}
function setup(fixture = new Fixture(), overrides: Partial<ColabNativeTransport> = {}) {
    const transport: ColabNativeTransport = { targets: async () => [TARGET], connect: async () => fixture, ...overrides };
    const driver = createColabNativeDriverForTest(9222, transport, { pickerMs: 20, pollMs: 1 });
    return { fixture, driver };
}
async function rejects(promise: Promise<unknown>, code: DesktopSetupErrorCode) {
    await assert.rejects(promise, (e: { code?: string }) => e.code === code);
}
const cases: Array<[string, () => Promise<void>]> = [];
function test(name: string, fn: () => Promise<void>) { cases.push([name, fn]); }

test('listing makes no input or Enter action; explicit non-first choice is selected', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL);
    const choices = await driver.listChoices!([KERNEL_HEADER], SIGNAL);
    assert.deepEqual(choices.map(c => c.label), ['Kernel A', 'Kernel B']);
    assert.deepEqual(fixture.writes, []); assert.equal(fixture.submits, 0);
    await driver.chooseListed!([KERNEL_HEADER], choices[1].choiceId, SIGNAL);
    assert.deepEqual(fixture.writes, ['Kernel B']); assert.equal(fixture.submits, 1);
    assert.deepEqual(fixture.inputEvents, [{ bubbles: true, cancelable: true }]);
    const write = fixture.evaluations.find(expression => expression.includes("new Event('input'"));
    assert.ok(write); assert.doesNotMatch(write!, /\basync\b|\bawait\b|window\.driver/);
    assert.ok(fixture.evaluations.every(expression => !expression.includes('window.driver')));
});
test('missing native port refuses discovery', async () => {
    const driver = createColabNativeDriverForTest(0, { targets: async () => { throw new Error('should not discover'); }, connect: async () => new Fixture() });
    await rejects(driver.bind(MARKER, SIGNAL), 'native_debug_unavailable');
});
test('debug targets cannot redirect to another host or port', async () => {
    for (const url of ['ws://example.org:9222/devtools/page/owner', 'ws://127.0.0.1:9223/devtools/page/owner', 'ws://user@127.0.0.1:9222/devtools/page/owner', 'ws://127.0.0.1:9222/devtools/browser/owner']) {
        const { driver } = setup(undefined, { targets: async () => [{ ...TARGET, webSocketDebuggerUrl: url }], connect: async () => { throw new Error('must not connect'); } });
        await rejects(driver.bind(MARKER, SIGNAL), 'native_debug_unavailable');
    }
});
test('non-owner targets are closed and unique owner is selected', async () => {
    const other = new Fixture(); other.markerCount = 0; const owner = new Fixture();
    const { driver } = setup(owner, { targets: async () => [{ ...TARGET, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/other' }, TARGET], connect: async url => url.endsWith('/other') ? other : owner });
    await driver.bind(MARKER, SIGNAL); assert.equal(other.disposed, true); assert.equal(owner.disposed, false);
});
test('two owner windows refuse binding', async () => {
    const fixtures = [new Fixture(), new Fixture()]; let i = 0;
    const { driver } = setup(undefined, { targets: async () => [TARGET, TARGET], connect: async () => fixtures[i++] });
    await rejects(driver.bind(MARKER, SIGNAL), 'window_binding_failed'); assert.ok(fixtures.every(f => f.disposed));
});
test('DOM-only binding needs no smoke driver and duplicate marker refuses binding', async () => {
    const fixture = new Fixture(); await setup(fixture).driver.bind(MARKER, SIGNAL);
    assert.ok(fixture.evaluations.every(expression => !expression.includes('window.driver')));
    const duplicate = new Fixture(); duplicate.markerCount = 2;
    await rejects(setup(duplicate).driver.bind(MARKER, SIGNAL), 'window_binding_failed');
});
test('relisting invalidates all prior choice IDs', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL);
    const old = await driver.listChoices!([KERNEL_HEADER], SIGNAL); await driver.listChoices!([KERNEL_HEADER], SIGNAL);
    await rejects(driver.chooseListed!([KERNEL_HEADER], old[0].choiceId, SIGNAL), 'kernel_choice_stale');
    assert.equal(fixture.submits, 0); assert.deepEqual(fixture.writes, []);
});
test('changed list or changed description invalidates selection before typing', async () => {
    for (const change of [(f: Fixture) => f.rows.reverse(), (f: Fixture) => { f.rows[0].description = 'other environment'; }]) {
        const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL);
        const choices = await driver.listChoices!([KERNEL_HEADER], SIGNAL); change(fixture);
        await rejects(driver.chooseListed!([KERNEL_HEADER], choices[0].choiceId, SIGNAL), 'kernel_choice_stale'); assert.deepEqual(fixture.writes, []);
    }
});
test('wrong setup header and unknown ID cannot select', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL);
    const choices = await driver.listChoices!([KERNEL_HEADER], SIGNAL);
    await rejects(driver.chooseListed!(['Select a Kernel from m87654321'], choices[0].choiceId, SIGNAL), 'kernel_choice_stale');
    await rejects(driver.chooseListed!([KERNEL_HEADER], 'unknown', SIGNAL), 'kernel_choice_stale'); assert.equal(fixture.submits, 0);
});
test('filtered, loading, virtualized or disabled picker does not claim complete listing', async () => {
    for (const change of [(f: Fixture) => { f.value = 'Kernel'; }, (f: Fixture) => { f.busy = true; }, (f: Fixture) => { f.incomplete = true; }, (f: Fixture) => { f.rows[1].disabled = true; }]) {
        const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL); change(fixture);
        await rejects(driver.listChoices!([KERNEL_HEADER], SIGNAL), 'kernel_choices_incomplete'); assert.equal(fixture.submits, 0);
    }
});
test('duplicate kernel labels are ambiguous even with distinct descriptions', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL); fixture.rows[1].label = fixture.rows[0].label;
    await rejects(driver.listChoices!([KERNEL_HEADER], SIGNAL), 'ambiguous_picker');
});
test('lost owner marker before select prevents mutation', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL);
    const choices = await driver.listChoices!([KERNEL_HEADER], SIGNAL); fixture.markerCount = 0;
    await rejects(driver.chooseListed!([KERNEL_HEADER], choices[0].choiceId, SIGNAL), 'window_binding_failed'); assert.deepEqual(fixture.writes, []);
});
test('lost owner between observation and mutation is caught in renderer', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL); const choices = await driver.listChoices!([KERNEL_HEADER], SIGNAL);
    fixture.beforeEvaluate = expression => { if (expression.includes("new Event('input'")) fixture.markerCount = 0; };
    await rejects(driver.chooseListed!([KERNEL_HEADER], choices[0].choiceId, SIGNAL), 'action_failed'); assert.deepEqual(fixture.writes, []);
});
test('inactive input never receives text or Enter', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL); const choices = await driver.listChoices!([KERNEL_HEADER], SIGNAL); fixture.active = false;
    await rejects(driver.chooseListed!([KERNEL_HEADER], choices[0].choiceId, SIGNAL), 'action_failed'); assert.deepEqual(fixture.writes, []);
});
test('a hidden stale input prevents all text mutation', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER,SIGNAL); const choices=await driver.listChoices!([KERNEL_HEADER],SIGNAL);
    fixture.hiddenInputs=1;
    await rejects(driver.chooseListed!([KERNEL_HEADER],choices[0].choiceId,SIGNAL),'action_failed'); assert.deepEqual(fixture.writes,[]); assert.equal(fixture.submits,0);
});
test('picker or focus changes after final proof are rejected at submission', async () => {
    for (const change of [(f:Fixture)=>{f.active=false;},(f:Fixture)=>{f.placeholder='Other';f.ariaLabel='Other';f.title='Other';},(f:Fixture)=>{f.rows[0].description='changed';}]) {
        const {fixture,driver}=setup();await driver.bind(MARKER,SIGNAL);const choices=await driver.listChoices!([KERNEL_HEADER],SIGNAL);
        fixture.beforeEvaluate=expression=>{if(expression.includes("new KeyboardEvent('keydown'"))change(fixture);};
        await rejects(driver.chooseListed!([KERNEL_HEADER],choices[0].choiceId,SIGNAL),'action_failed');assert.equal(fixture.submits,0);
    }
});
test('abort immediately after socket open disposes an unreturned connection', async () => {
    const original=globalThis.WebSocket, controller=new AbortController();let closed=0;
    class FakeSocket extends EventTarget { constructor(){super();queueMicrotask(()=>{this.dispatchEvent(new Event('open'));controller.abort();});} close(){closed++;} }
    Object.defineProperty(globalThis,'WebSocket',{configurable:true,writable:true,value:FakeSocket});
    try {await rejects(connectColabNativeSessionForTest('ws://127.0.0.1:9222/devtools/page/owner',controller.signal),'cancelled');assert.equal(closed,1);}
    finally {Object.defineProperty(globalThis,'WebSocket',{configurable:true,writable:true,value:original});}
});
test('abort during listener registration cannot send a CDP command', async () => {
    const original=globalThis.WebSocket;let sent=0,closed=0;
    class FakeSocket extends EventTarget { constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));} close(){closed++;} send(){sent++;} }
    Object.defineProperty(globalThis,'WebSocket',{configurable:true,writable:true,value:FakeSocket});
    try {
        const session=await connectColabNativeSessionForTest('ws://127.0.0.1:9222/devtools/page/owner',SIGNAL);
        const controller=new AbortController();const add=controller.signal.addEventListener.bind(controller.signal);
        controller.signal.addEventListener=((...args:Parameters<AbortSignal['addEventListener']>)=>{controller.abort();add(...args);}) as AbortSignal['addEventListener'];
        await rejects(session.evaluate('true',controller.signal),'cancelled');assert.equal(sent,0);assert.equal(closed,1);
    } finally {Object.defineProperty(globalThis,'WebSocket',{configurable:true,writable:true,value:original});}
});
test('CPU proof required before alias entry; exact CPU alias works', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL);
    fixture.title = 'Colab GPU'; fixture.placeholder = 'Alias your server'; fixture.ariaLabel = 'Colab GPU - Alias your server';
    await rejects(driver.enter(['Alias your server'], 'm12345678', SIGNAL), 'cpu_selection_unconfirmed'); assert.deepEqual(fixture.writes, []);
    fixture.title = 'Colab CPU'; fixture.ariaLabel = 'Colab CPU - Alias your server';
    await driver.enter(['Alias your server'], 'm12345678', SIGNAL); assert.equal(fixture.submits, 1);
});
test('existing server selection allows only one exact MCP alias row', async () => {
    const alias = 'm7ae91d89';
    const one = setup(); await one.driver.bind(MARKER, SIGNAL);
    one.fixture.title = 'Select a Jupyter Server'; one.fixture.placeholder = 'Select a Jupyter Server'; one.fixture.ariaLabel = 'Select a Jupyter Server';
    one.fixture.rows = [{ label: alias, description: 'existing server', detail: '', disabled: false }];
    assert.equal(await one.driver.choose(['Select a Jupyter Server'], [alias], SIGNAL), alias);
    assert.deepEqual(one.fixture.writes, [alias]); assert.equal(one.fixture.submits, 1);

    const duplicate = setup(); await duplicate.driver.bind(MARKER, SIGNAL);
    duplicate.fixture.title = 'Select a Jupyter Server'; duplicate.fixture.placeholder = 'Select a Jupyter Server'; duplicate.fixture.ariaLabel = 'Select a Jupyter Server';
    duplicate.fixture.rows = [
        { label: alias, description: 'first', detail: '', disabled: false },
        { label: alias, description: 'second', detail: '', disabled: false }
    ];
    await rejects(duplicate.driver.choose(['Select a Jupyter Server'], [alias], SIGNAL), 'ambiguous_picker');
    await rejects(duplicate.driver.choose(['Select a Jupyter Server'], ['mABCDEF12'], SIGNAL), 'action_failed');
    await rejects(duplicate.driver.choose([KERNEL_HEADER], [alias], SIGNAL), 'action_failed');
    assert.equal(duplicate.fixture.submits, 0);

    const missing = setup(); await missing.driver.bind(MARKER, SIGNAL);
    missing.fixture.title = 'Select a Jupyter Server'; missing.fixture.placeholder = 'Select a Jupyter Server'; missing.fixture.ariaLabel = 'Select a Jupyter Server';
    missing.fixture.rows = [{ label: 'm00000000', description: '', detail: '', disabled: false }];
    await rejects(missing.driver.choose(['Select a Jupyter Server'], [alias], SIGNAL), 'picker_timeout');

    const mount = setup(); await mount.driver.bind(MARKER, SIGNAL);
    mount.fixture.title = 'Mount Server to Workspace'; mount.fixture.placeholder = 'Mount Server to Workspace'; mount.fixture.ariaLabel = 'Mount Server to Workspace';
    mount.fixture.rows = [{ label: alias, description: '', detail: '', disabled: false }];
    assert.equal(await mount.driver.choose(['Mount Server to Workspace'], [alias], SIGNAL), alias);
});
test('notebook-specific initial picker selects only the source action and rejects another notebook', async () => {
    const expected = "Select kernel for 'nested\\target.ipynb'";
    const headers = ['Select Kernel', expected, "Change kernel for 'nested\\target.ipynb'"];
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL);
    fixture.title = ''; fixture.placeholder = expected; fixture.ariaLabel = expected;
    fixture.rows = [{ label: 'Python', description: '.venv\\Scripts\\python.exe', detail: '', disabled: false }, { label: 'Select Another Kernel...', description: '', detail: '', disabled: false }];
    assert.equal(await driver.choose(headers, ['Select Another Kernel...', 'Colab'], SIGNAL), 'Select Another Kernel...');
    assert.deepEqual(fixture.writes, ['Select Another Kernel...']); assert.equal(fixture.submits, 1);
    const other = setup(); await other.driver.bind(MARKER, SIGNAL);
    other.fixture.title = ''; other.fixture.placeholder = "Select kernel for 'other.ipynb'"; other.fixture.ariaLabel = other.fixture.placeholder;
    other.fixture.rows = fixture.rows;
    await rejects(other.driver.choose(headers, ['Select Another Kernel...', 'Colab'], SIGNAL), 'picker_timeout');
    assert.deepEqual(other.fixture.writes, []); assert.equal(other.fixture.submits, 0);
});
test('source picker after controller suggestions accepts the installed Select Another Kernel title', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL);
    fixture.title = 'Select Another Kernel'; fixture.placeholder = 'Type to choose a kernel source'; fixture.ariaLabel = fixture.placeholder;
    fixture.rows = [{ label: 'Colab', description: '', detail: '', disabled: false }];
    assert.equal(await driver.choose(['Select Kernel', 'Select Another Kernel'], ['Colab'], SIGNAL), 'Colab');
    assert.deepEqual(fixture.writes, ['Colab']); assert.equal(fixture.submits, 1);
});
test('cancelled listing/selection and disposed driver never act', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL); const choices = await driver.listChoices!([KERNEL_HEADER], SIGNAL);
    const abort = new AbortController(); abort.abort();
    await rejects(driver.chooseListed!([KERNEL_HEADER], choices[0].choiceId, abort.signal), 'cancelled');
    driver.dispose(); await rejects(driver.waitForInput([KERNEL_HEADER], SIGNAL), 'window_binding_failed'); assert.deepEqual(fixture.writes, []);
});
test('unexpected picker times out and multiple widgets refuse safely', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL);
    await rejects(driver.waitForInput(['Unexpected'], SIGNAL), 'picker_timeout');
    fixture.widgets = 2; await rejects(driver.waitForInput([KERNEL_HEADER], SIGNAL), 'ambiguous_picker');
});
test('arbitrary setup options cannot be automated', async () => {
    const { fixture, driver } = setup(); await driver.bind(MARKER, SIGNAL);
    await rejects(driver.choose([KERNEL_HEADER], ['Upgrade'], SIGNAL), 'action_failed'); assert.equal(fixture.submits, 0);
});

async function main() {
    for (const [name, run] of cases) { await run(); console.log('PASS ' + name); }
    console.log(`${cases.length}/${cases.length} native Colab driver tests passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
