// Test runner: compiles, then runs the deterministic MCP integration test suites
// (mcp.test.js: empty window / no Jupyter; mcp.jupyter.test.js: Jupyter present).
// They load the bundle with a vscode shim and exercise tools over a real MCP HTTP
// connection. No GUI / no VS Code download needed — identical on all platforms and CI.
'use strict';
const { spawnSync } = require('child_process');
const net = require('net');
const path = require('path');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => resolve(address.port));
        });
    });
}

async function main() {
    const root = path.resolve(__dirname, '..', '..');
    for (const file of ['mcp.test.js', 'mcp.jupyter.test.js']) {
        const port = await getFreePort();
        const r = spawnSync('node', [path.join(__dirname, file)], {
            cwd: root,
            stdio: 'inherit',
            timeout: 60000,
            env: { ...process.env, MCP_TEST_PORT: String(port) }
        });
        if (r.status !== 0) {
            process.exit(r.status || 1);
        }
    }
    const broker = spawnSync('node', [path.join(root, '.vscode-test', 'broker.test.cjs')], {
        cwd: root,
        stdio: 'inherit',
        timeout: 60000
    });
    if (broker.status !== 0) process.exit(broker.status || 1);
    process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
