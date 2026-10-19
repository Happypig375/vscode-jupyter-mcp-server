import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    createColabDesktopDriverForTest,
    DesktopSetupError,
    DesktopSetupErrorCode,
    OrcaCommandRunner,
    resolveColabDesktopExecutableForTest,
    runOrcaCommandForTest
} from '../colabDesktop';

const MARKER = 'JUPYTER_MCP_SETUP_7f3c2a';

interface FixtureOptions {
    windows?: string[];
    tree?: (windowId: string) => string;
    onAction?: (args: readonly string[]) => unknown;
    override?: (args: readonly string[], signal: AbortSignal) => Promise<string> | string | undefined;
}

class FixtureRunner implements OrcaCommandRunner {
    readonly calls: string[][] = [];
    constructor(private readonly fixture: FixtureOptions = {}) {}

    async run(_executable: string, args: readonly string[], signal: AbortSignal): Promise<string> {
        this.calls.push([...args]);
        if (signal.aborted) throw new Error('aborted provider detail');
        const overridden = this.fixture.override?.(args, signal);
        if (overridden !== undefined) return await overridden;
        const command = args[1];
        if (command === 'capabilities') {
            return json({ ok: true, result: {
                platform: 'win32', provider: 'orca-computer-use-windows', providerVersion: '1.0.0', protocolVersion: 1,
                supports: {
                    apps: { list: true, pids: true }, windows: { list: true, targetById: true },
                    actions: { click: true, setValue: true, pressKey: true }
                }
            } });
        }
        if (command === 'list-apps') return json({ ok: true, result: { apps: [{ name: 'Code', pid: 42 }] } });
        if (command === 'list-windows') {
            return json({ ok: true, result: { windows: (this.fixture.windows ?? ['w1']).map((id) => ({ id })) } });
        }
        if (command === 'get-app-state') {
            const windowId = valueAfter(args, '--window-id');
            return snapshot(windowId, this.fixture.tree?.(windowId) ?? pickerTree(MARKER, 'Select Kernel', ['Colab']));
        }
        if (command === 'click' || command === 'set-value' || command === 'press-key') {
            return json(this.fixture.onAction?.(args) ?? { ok: true, result: { verified: null } });
        }
        throw new Error('unexpected fixture command');
    }
}

function json(value: unknown): string {
    return JSON.stringify(value);
}

function snapshot(windowId: string, treeText: string): string {
    return json({
        ok: true,
        result: {
            snapshot: {
                app: { name: 'Code', pid: 42 },
                window: { id: windowId },
                treeText,
                truncation: { truncated: false }
            }
        }
    });
}

function pickerTree(marker: string | undefined, input: string, options: readonly string[], value?: string): string {
    const lines = ['0 window Code'];
    if (marker) lines.push(`\t1 status bar item ${marker}`);
    lines.push('\t10 group Quick Input');
    lines.push(`\t\t11 edit ${input}${value === undefined ? '' : `, Value: ${value}`}, Secondary Actions: SetValue`);
    lines.push(`\t\t12 list ${input}, Secondary Actions: SetValue`);
    options.forEach((option, i) => lines.push(`\t\t\t${20 + i} option ${option}, Secondary Actions: Select`));
    return lines.join('\n');
}

function valueAfter(args: readonly string[], flag: string): string {
    const index = args.indexOf(flag);
    assert.ok(index >= 0 && index + 1 < args.length, `missing ${flag}`);
    return args[index + 1];
}

async function rejectsCode(promise: Promise<unknown>, code: DesktopSetupErrorCode): Promise<DesktopSetupError> {
    try {
        await promise;
        assert.fail(`expected ${code}`);
    } catch (error) {
        assert.ok(error instanceof DesktopSetupError);
        assert.strictEqual(error.code, code);
        assert.strictEqual(error.message, new DesktopSetupError(code).message);
        return error;
    }
}

async function testNormalPickerAndSafeEntry(): Promise<void> {
    let stage: 'kernel-source' | 'server' | 'alias' | 'done' = 'kernel-source';
    let aliasValue: string | undefined;
    const runner = new FixtureRunner({
        tree: () => {
            if (stage === 'kernel-source') {
                return pickerTree(MARKER, 'Type to choose a kernel source - Select Kernel', [
                    'Python Environments...', 'Colab'
                ]);
            }
            if (stage === 'server') {
                return pickerTree(MARKER, 'Select a remote server - Select a Jupyter Server', [
                    'symbol-event Auto Connect, 1-click connect! Most recently created server, or a new one.',
                    'add New Colab Server, CPU, GPU or TPU.',
                    'link-external Open Colab Web, Open Colab web.'
                ]);
            }
            return pickerTree(MARKER, 'Alias your server', [], aliasValue);
        },
        onAction: (args) => {
            if (args[1] === 'click') {
                const selected = valueAfter(args, '--element-index');
                if (stage === 'kernel-source') {
                    assert.strictEqual(selected, '21');
                    stage = 'server';
                } else {
                    assert.strictEqual(selected, '21');
                    stage = 'alias';
                }
            } else if (args[1] === 'set-value') {
                assert.strictEqual(stage, 'alias');
                aliasValue = valueAfter(args, '--value');
            } else if (args[1] === 'press-key') {
                assert.strictEqual(valueAfter(args, '--key'), 'Return');
                assert.strictEqual(aliasValue, 'jupyter-mcp-cpu-7f3c2a');
                stage = 'done';
            }
            return { ok: true, result: { verified: null } };
        }
    });
    const driver = createColabDesktopDriverForTest(runner, { pollMs: 1, pickerTimeoutMs: 50 });
    const signal = new AbortController().signal;
    await driver.bind(MARKER, signal);
    assert.strictEqual(await driver.waitForInput(['Select Kernel'], signal), 'Select Kernel');
    assert.strictEqual(await driver.choose(['Select Kernel'], ['Select Another Kernel...', 'Colab'], signal), 'Colab');
    assert.strictEqual(
        await driver.choose(['Select a Jupyter Server'], ['New Colab Server'], signal),
        'New Colab Server'
    );
    await driver.enter(['Alias your server'], 'jupyter-mcp-cpu-7f3c2a', signal);
    assert.strictEqual(stage, 'done');

    for (const call of runner.calls) {
        assert.ok(!call.includes('--pairing-code'));
        assert.ok(!call.includes('--environment'));
        assert.ok(!call.includes('--worktree'));
        if (['get-app-state', 'click', 'set-value', 'press-key'].includes(call[1])) {
            assert.ok(call.includes('--no-screenshot'));
            assert.strictEqual(valueAfter(call, '--app'), 'pid:42');
            assert.strictEqual(valueAfter(call, '--window-id'), 'w1');
        }
    }
    driver.dispose();
}

async function testWrongAndMultipleMarkers(): Promise<void> {
    const realStatusShape = new FixtureRunner({ tree: () => `0 window Code\n\t1 group ${MARKER}\n\t\t2 button ${MARKER}` });
    await createColabDesktopDriverForTest(realStatusShape).bind(MARKER, new AbortController().signal);
    const wrong = createColabDesktopDriverForTest(new FixtureRunner({
        tree: () => pickerTree('wrong-marker', 'Select Kernel', ['Colab'])
    }));
    await rejectsCode(wrong.bind(MARKER, new AbortController().signal), 'window_binding_failed');

    const multiple = createColabDesktopDriverForTest(new FixtureRunner({
        windows: ['w1', 'w2'],
        tree: () => pickerTree(MARKER, 'Select Kernel', ['Colab'])
    }));
    await rejectsCode(multiple.bind(MARKER, new AbortController().signal), 'window_binding_failed');
}

async function testAmbiguityNeverClicks(): Promise<void> {
    const runner = new FixtureRunner({
        tree: () => pickerTree(MARKER, 'Select Kernel', ['Colab', 'Colab'])
    });
    const driver = createColabDesktopDriverForTest(runner);
    const signal = new AbortController().signal;
    await driver.bind(MARKER, signal);
    await rejectsCode(driver.choose(['Select Kernel'], ['Colab'], signal), 'ambiguous_picker');
    assert.strictEqual(runner.calls.filter((call) => call[1] === 'click').length, 0);
}

async function testPickerOptionsStayInsideRecognizedList(): Promise<void> {
    const actual = pickerTree(MARKER, 'Select Kernel', ['Colab']);
    const hostileSibling = [
        '0 window Code',
        `\t1 status bar item ${MARKER}`,
        '\t2 group Unrelated private content',
        '\t\t3 list Unrelated private content',
        '\t\t\t4 option Colab, Secondary Actions: Select',
        ...actual.split('\n').slice(2)
    ].join('\n');
    const runner = new FixtureRunner({ tree: () => hostileSibling });
    const driver = createColabDesktopDriverForTest(runner);
    const signal = new AbortController().signal;
    await driver.bind(MARKER, signal);
    assert.strictEqual(await driver.choose(['Select Kernel'], ['Colab'], signal), 'Colab');
    const click = runner.calls.find((call) => call[1] === 'click');
    assert.ok(click);
    assert.strictEqual(valueAfter(click, '--element-index'), '20');

    const disabledRunner = new FixtureRunner({
        tree: () => pickerTree(MARKER, 'Select Kernel', ['Colab']).replace(
            'option Colab, Secondary Actions: Select', 'option Colab'
        )
    });
    const disabled = createColabDesktopDriverForTest(disabledRunner, { pollMs: 1, pickerTimeoutMs: 8 });
    await disabled.bind(MARKER, signal);
    await rejectsCode(disabled.choose(['Select Kernel'], ['Colab'], signal), 'picker_timeout');
    assert.strictEqual(disabledRunner.calls.filter((call) => call[1] === 'click').length, 0);

    const unstructuredRunner = new FixtureRunner({
        tree: () => [
            '0 window Code', `\t1 status bar item ${MARKER}`,
            '\t10 edit Select Kernel, Secondary Actions: SetValue',
            '\t20 option Colab, Secondary Actions: Select'
        ].join('\n')
    });
    const unstructured = createColabDesktopDriverForTest(unstructuredRunner, { pollMs: 1, pickerTimeoutMs: 8 });
    await unstructured.bind(MARKER, signal);
    await rejectsCode(unstructured.choose(['Select Kernel'], ['Colab'], signal), 'picker_timeout');
    assert.strictEqual(unstructuredRunner.calls.filter((call) => call[1] === 'click').length, 0);
}

async function testUnsafeChoiceTimesOutWithoutAction(): Promise<void> {
    const runner = new FixtureRunner({
        tree: () => pickerTree(MARKER, 'Select a machine shape', [
            'flame GPU A100, Paid accelerated machine.',
            'accounts-view-bar-icon Upgrade to Pro, More machines.'
        ])
    });
    const driver = createColabDesktopDriverForTest(runner, { pollMs: 1, pickerTimeoutMs: 8 });
    const signal = new AbortController().signal;
    await driver.bind(MARKER, signal);
    await rejectsCode(driver.choose(['Select a machine shape'], ['Standard'], signal), 'picker_timeout');
    await rejectsCode(driver.choose(['Select a machine shape'], ['Upgrade to Pro'], signal), 'ambiguous_picker');
    assert.strictEqual(runner.calls.filter((call) => call[1] === 'click').length, 0);
}

async function testMalformedOversizeCancellationAndSanitization(): Promise<void> {
    const malformed = createColabDesktopDriverForTest(new FixtureRunner({
        override: (args) => args[1] === 'capabilities' ? '{broken' : undefined
    }));
    await rejectsCode(malformed.bind(MARKER, new AbortController().signal), 'version_unsupported');

    const oversized = createColabDesktopDriverForTest(new FixtureRunner({
        override: (args) => args[1] === 'capabilities' ? 'x'.repeat(2 * 1024 * 1024 + 1) : undefined
    }));
    await rejectsCode(oversized.bind(MARKER, new AbortController().signal), 'version_unsupported');

    const secret = 'DO_NOT_LEAK_PROVIDER_DETAIL';
    const failing = createColabDesktopDriverForTest(new FixtureRunner({
        override: (args) => {
            if (args[1] === 'capabilities') throw new Error(secret);
            return undefined;
        }
    }));
    const error = await rejectsCode(failing.bind(MARKER, new AbortController().signal), 'version_unsupported');
    assert.ok(!error.message.includes(secret));

    const cancelled = createColabDesktopDriverForTest(new FixtureRunner());
    const controller = new AbortController();
    controller.abort();
    await rejectsCode(cancelled.bind(MARKER, controller.signal), 'cancelled');

    const stalled = createColabDesktopDriverForTest(new FixtureRunner({
        override: (args, signal) => {
            if (args[1] !== 'capabilities') return undefined;
            return new Promise<string>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('private timeout detail')), { once: true });
            });
        }
    }), { commandTimeoutMs: 5 });
    await rejectsCode(stalled.bind(MARKER, new AbortController().signal), 'version_unsupported');
}

async function testCapabilityVersionAndSemanticRequirements(): Promise<void> {
    const capabilities = (changes: Record<string, unknown> = {}) => json({ ok: true, result: {
        platform: 'win32', provider: 'orca-computer-use-windows', providerVersion: '1.0.0', protocolVersion: 1,
        supports: {
            apps: { list: true, pids: true }, windows: { list: true, targetById: true },
            actions: { click: true, setValue: true, pressKey: true }
        },
        ...changes
    } });
    const wrongProtocol = createColabDesktopDriverForTest(new FixtureRunner({
        override: (args) => args[1] === 'capabilities' ? capabilities({ protocolVersion: 2 }) : undefined
    }));
    await rejectsCode(wrongProtocol.bind(MARKER, new AbortController().signal), 'version_unsupported');

    const wrongProvider = createColabDesktopDriverForTest(new FixtureRunner({
        override: (args) => args[1] === 'capabilities' ? capabilities({ providerVersion: '1.1.0' }) : undefined
    }));
    await rejectsCode(wrongProvider.bind(MARKER, new AbortController().signal), 'version_unsupported');

    const noClick = createColabDesktopDriverForTest(new FixtureRunner({
        override: (args) => args[1] === 'capabilities' ? capabilities({
            supports: {
                apps: { list: true, pids: true }, windows: { list: true, targetById: true },
                actions: { click: false, setValue: true, pressKey: true }
            }
        }) : undefined
    }));
    await rejectsCode(noClick.bind(MARKER, new AbortController().signal), 'capability_unsupported');
}

async function testOneWindowFocusRestoreRetry(): Promise<void> {
    let firstClick = true;
    const runner = new FixtureRunner({
        onAction: (args) => {
            if (args[1] === 'click' && firstClick) {
                firstClick = false;
                return { ok: false, error: { code: 'window_not_focused', message: 'private provider text' } };
            }
            return { ok: true, result: { verified: null } };
        }
    });
    const driver = createColabDesktopDriverForTest(runner);
    const signal = new AbortController().signal;
    await driver.bind(MARKER, signal);
    assert.strictEqual(await driver.choose(['Select Kernel'], ['Colab'], signal), 'Colab');
    const clicks = runner.calls.filter((call) => call[1] === 'click');
    assert.strictEqual(clicks.length, 2);
    assert.ok(!clicks[0].includes('--restore-window'));
    assert.ok(clicks[1].includes('--restore-window'));
    const restoredSnapshots = runner.calls.filter((call) => call[1] === 'get-app-state' && call.includes('--restore-window'));
    assert.strictEqual(restoredSnapshots.length, 1);
}

async function testEntryRefusesWithoutValueProof(): Promise<void> {
    const runner = new FixtureRunner({
        tree: () => pickerTree(MARKER, 'Alias your server', []),
        onAction: () => ({ ok: true, result: { verified: null } })
    });
    const driver = createColabDesktopDriverForTest(runner);
    const signal = new AbortController().signal;
    await driver.bind(MARKER, signal);
    await rejectsCode(driver.enter(['Alias your server'], 'safe-alias', signal), 'action_failed');
    assert.strictEqual(runner.calls.filter((call) => call[1] === 'press-key').length, 0);
}

async function testGeneratedAliasRequiresExactFollowingPicker(): Promise<void> {
    const alias = 'maabbccdd';
    for (const variant of ['success', 'focus-retry', 'windows-value-suffix', 'wrong-picker', 'exposed-mismatch', 'changed-to-gpu'] as const) {
        let submitted = false; let returnCount = 0; let written = false;
        const runner = new FixtureRunner({
            tree: () => submitted
                ? pickerTree(MARKER, 'Select a Kernel from ' + (variant === 'wrong-picker' ? 'another server' : alias), ['Python 3'])
                : pickerTree(MARKER, written && variant === 'windows-value-suffix' ? 'Colab CPU - Alias your server ' + alias
                    : written && variant === 'changed-to-gpu' ? 'Colab GPU - Alias your server' : 'Colab CPU - Alias your server', [], variant === 'exposed-mismatch' ? 'another server' : undefined),
            onAction: (args) => {
                if (args[1] === 'set-value') { assert.strictEqual(valueAfter(args, '--value'), alias); written = true; }
                if (args[1] === 'press-key') {
                    returnCount++;
                    if (variant === 'focus-retry' && returnCount === 1) return { ok: false, error: { code: 'window_not_focused' } };
                    submitted = true;
                }
                return { ok: true, result: { verified: null } };
            }
        });
        const driver = createColabDesktopDriverForTest(runner, { pickerTimeoutMs: 40, pollMs: 2 });
        const signal = new AbortController().signal;
        await driver.bind(MARKER, signal);
        if (variant === 'wrong-picker') await rejectsCode(driver.enter(['Alias your server'], alias, signal), 'picker_timeout');
        else if (variant === 'exposed-mismatch' || variant === 'changed-to-gpu') await rejectsCode(driver.enter(['Alias your server'], alias, signal), 'action_failed');
        else await driver.enter(['Alias your server'], alias, signal);
        assert.strictEqual(returnCount, variant === 'exposed-mismatch' || variant === 'changed-to-gpu' ? 0 : variant === 'focus-retry' ? 2 : 1);
        assert.strictEqual(runner.calls.filter((call) => call[1] === 'click').length, 0);
        driver.dispose();
    }
}

async function testEntryFailureDiagnosticNeverExposesProviderText(): Promise<void> {
    const runner = new FixtureRunner({
        tree: () => pickerTree(MARKER, 'Colab CPU - Alias your server', []),
        onAction: () => ({ ok: false, error: { code: 'private_account_name', message: 'private notebook contents' } })
    });
    const driver = createColabDesktopDriverForTest(runner);
    const signal = new AbortController().signal;
    await driver.bind(MARKER, signal);
    const error = await rejectsCode(driver.enter(['Alias your server'], 'm1234abcd', signal), 'action_failed');
    assert.strictEqual(error.operation, 'input_write');
    assert.strictEqual(error.providerCode, 'unrecognized_error');
    assert.doesNotMatch(JSON.stringify(error), /private/);
    assert.strictEqual(runner.calls.filter((call) => call[1] === 'press-key').length, 0);
    driver.dispose();
}

async function testAliasRequiresObservedCpuTitleBeforeAnyWrite(): Promise<void> {
    for (const title of ['Alias your server', 'Colab GPU - Alias your server', 'Colab TPU - Alias your server']) {
        const runner = new FixtureRunner({ tree: () => pickerTree(MARKER, title, []) });
        const driver = createColabDesktopDriverForTest(runner);
        const signal = new AbortController().signal;
        await driver.bind(MARKER, signal);
        await rejectsCode(driver.enter(['Alias your server'], 'm1234abcd', signal), 'cpu_selection_unconfirmed');
        assert.strictEqual(runner.calls.filter((call) => ['click', 'set-value', 'press-key'].includes(call[1])).length, 0);
        driver.dispose();
    }
}

async function testRecommendedPythonPicker(): Promise<void> {
    const title = 'Select a Kernel from m1234abcd';
    const runner = new FixtureRunner({ tree: () => pickerTree(MARKER, title, [
        'star-full Python 3 (ipykernel), usr\\bin\\python3, Recommended',
        'julia 1.12, usr\\local\\bin\\julia, Jupyter Kernel', 'R, usr\\lib\\R\\bin\\R'
    ]) });
    const driver = createColabDesktopDriverForTest(runner);
    const signal = new AbortController().signal;
    await driver.bind(MARKER, signal);
    assert.strictEqual(await driver.choose([title], ['Python 3 (ipykernel)', 'Python 3', 'python3'], signal), 'Python 3 (ipykernel)');
    const clicks = runner.calls.filter((call) => call[1] === 'click');
    assert.strictEqual(clicks.length, 1); assert.strictEqual(valueAfter(clicks[0], '--element-index'), '20');
    driver.dispose();
}

function testExecutableResolution(): void {
    const seen: string[] = [];
    const explicit = resolveColabDesktopExecutableForTest('C:\\tools\\orca.exe', {
        platform: 'win32', localAppData: 'C:\\Local',
        isFile(candidate) { seen.push(candidate); return candidate === 'C:\\tools\\orca.exe'; }
    });
    assert.strictEqual(explicit, 'C:\\tools\\orca.exe');
    assert.deepStrictEqual(seen, ['C:\\tools\\orca.exe']);

    const envSeen: string[] = [];
    assert.throws(() => resolveColabDesktopExecutableForTest(undefined, {
        platform: 'win32', environmentCommand: 'C:\\missing\\orca.exe', localAppData: 'C:\\Local',
        isFile(candidate) { envSeen.push(candidate); return candidate.endsWith('resources\\bin\\orca.exe'); }
    }), (error: unknown) => error instanceof DesktopSetupError && error.code === 'orca_missing');
    assert.deepStrictEqual(envSeen, ['C:\\missing\\orca.exe'], 'Invalid environment configuration must not fall through');

    const linuxSeen: string[] = [];
    const linux = resolveColabDesktopExecutableForTest(undefined, {
        platform: 'linux',
        isFile(candidate) { linuxSeen.push(candidate); return candidate === '/usr/bin/orca-ide'; }
    });
    assert.strictEqual(linux, '/usr/bin/orca-ide');
    assert.deepStrictEqual(linuxSeen, ['/usr/local/bin/orca-ide', '/usr/bin/orca-ide']);
    assert.ok(linuxSeen.every((candidate) => path.posix.basename(candidate) === 'orca-ide'));

    assert.throws(() => resolveColabDesktopExecutableForTest('orca', {
        platform: 'linux', isFile: () => true
    }), (error: unknown) => error instanceof DesktopSetupError && error.code === 'orca_missing');
}

async function testSpawnRunnerWaitsForCloseAfterOutputOverflow(): Promise<void> {
    const testDir = path.resolve('.vscode-test');
    await fs.promises.mkdir(testDir, { recursive: true });
    const helper = path.join(testDir, 'colab-desktop-overflow-helper.cjs');
    await fs.promises.writeFile(helper, [
        "const fs=require('fs');",
        "fs.writeFileSync(process.argv[3], String(process.pid));",
        "const target=process.argv[2]==='stderr'?process.stderr:process.stdout;",
        `target.write(Buffer.alloc(${2 * 1024 * 1024 + 64 * 1024}, 120));`,
        "setInterval(()=>{},1000);"
    ].join('\n'));
    try {
        for (const stream of ['stdout', 'stderr']) {
            const pidFile = path.join(testDir, `colab-desktop-${stream}.pid`);
            await fs.promises.rm(pidFile, { force: true });
            await assert.rejects(
                runOrcaCommandForTest(process.execPath, [helper, stream, pidFile], new AbortController().signal)
            );
            const pid = Number(await fs.promises.readFile(pidFile, 'utf8'));
            assert.ok(Number.isSafeInteger(pid) && pid > 0);
            assert.strictEqual(processExists(pid), false, `${stream} overflow must reject only after child close`);
            await fs.promises.rm(pidFile, { force: true });
        }
    } finally {
        await fs.promises.rm(helper, { force: true });
    }
}

function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    testExecutableResolution();
    await testNormalPickerAndSafeEntry();
    await testWrongAndMultipleMarkers();
    await testAmbiguityNeverClicks();
    await testPickerOptionsStayInsideRecognizedList();
    await testUnsafeChoiceTimesOutWithoutAction();
    await testMalformedOversizeCancellationAndSanitization();
    await testCapabilityVersionAndSemanticRequirements();
    await testOneWindowFocusRestoreRetry();
    await testEntryRefusesWithoutValueProof();
    await testGeneratedAliasRequiresExactFollowingPicker();
    await testEntryFailureDiagnosticNeverExposesProviderText();
    await testRecommendedPythonPicker();
    await testAliasRequiresObservedCpuTitleBeforeAnyWrite();
    await testSpawnRunnerWaitsForCloseAfterOutputOverflow();
    console.log('colabDesktop tests passed');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
