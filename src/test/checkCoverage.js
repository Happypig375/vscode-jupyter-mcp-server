// Verifies src coverage meets thresholds by parsing c8's text report (the All files
// row, which with excludeAfterRemap is src-only). c8's own --check-coverage is
// unreliable with sourcemap-remapped bundles, so we enforce thresholds here.
// Runs each test suite under c8 with --clean=false so coverage accumulates, then
// reports the merged result.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const THRESHOLDS = { statements: 75, branches: 55, functions: 85, lines: 75 };

function main() {
    const root = path.resolve(__dirname, '..', '..');
    const c8Bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'c8.cmd' : 'c8');
    const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' };
    // First suite cleans; subsequent ones accumulate (--clean=false).
    execFileSync(c8Bin, ['node', path.join(__dirname, 'mcp.test.js')], opts);
    const out = execFileSync(c8Bin, ['--clean=false', 'node', path.join(__dirname, 'mcp.jupyter.test.js')], opts);
    console.log(out);

    // Find the "All files" row (with excludeAfterRemap this is src-only).
    const m = out.match(/All files\s+\|\s*([\d.]+)\s+\|\s*([\d.]+)\s+\|\s*([\d.]+)\s+\|\s*([\d.]+)/);
    if (!m) {
        console.error('Could not parse coverage report');
        process.exit(1);
    }
    const [_, stmts, branch, funcs, lines] = m.map(Number);
    const results = { statements: stmts, branches: branch, functions: funcs, lines };
    let ok = true;
    for (const [k, v] of Object.entries(THRESHOLDS)) {
        const got = results[k];
        const pass = got >= v;
        console.log(`${pass ? 'PASS' : 'FAIL'} ${k}: ${got.toFixed(2)}% >= ${v}%`);
        if (!pass) ok = false;
    }
    process.exit(ok ? 0 : 1);
}

main();
