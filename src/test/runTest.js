// Test runner: compiles, then runs the deterministic MCP integration test suites
// (mcp.test.js: empty window / no Jupyter; mcp.jupyter.test.js: Jupyter present).
// They load the bundle with a vscode shim and exercise tools over a real MCP HTTP
// connection. No GUI / no VS Code download needed — identical on all platforms and CI.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

function main() {
    const root = path.resolve(__dirname, '..', '..');
    const compile = spawnSync('npm', ['run', 'compile'], { cwd: root, stdio: 'inherit', shell: true });
    if (compile.status !== 0) {
        process.exit(compile.status || 1);
    }
    for (const file of ['mcp.test.js', 'mcp.jupyter.test.js']) {
        const r = spawnSync('node', [path.join(__dirname, file)], { cwd: root, stdio: 'inherit', timeout: 60000 });
        if (r.status !== 0) {
            process.exit(r.status || 1);
        }
    }
    process.exit(0);
}

main();
