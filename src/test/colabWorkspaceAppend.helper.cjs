'use strict';

// Isolated live-fixture instrumentation, never included in the extension package.
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

exports.activate = (context, options) => {
    const vscode = require('vscode');
    const activationId = crypto.randomUUID();
    const marker = options.markerPrefix + ' ' + activationId;
    const state = () => ({
        schema: 'colab-workspace-append-state-v1',
        nonce: options.nonce,
        activationId,
        extensionHostPid: process.pid,
        vscodeVersion: vscode.version,
        observedAt: new Date().toISOString(),
        workspaceUri: vscode.workspace.workspaceFile?.toString() ?? null,
        roots: (vscode.workspace.workspaceFolders ?? []).map(folder => ({ uri: folder.uri.toString(), name: folder.name }))
    });
    fs.writeFileSync(path.join(options.stateDirectory, 'activation-' + activationId + '.json'), JSON.stringify(state()), { flag: 'wx' });
    let attempted = false;
    let settleTimer;
    const command = 'jupyterMcp.colabEnvironmentLiveFixtureAppend';
    context.subscriptions.push(vscode.commands.registerCommand(command, () => {
        assert.strictEqual(attempted, false, 'Append fixture command already attempted.');
        attempted = true;
        const request = JSON.parse(fs.readFileSync(options.requestPath, 'utf8'));
        assert.deepStrictEqual(Object.keys(request).sort(), ['activationId', 'expectedRoot', 'expectedWorkspaceUri', 'extensionHostPid', 'nonce', 'requestedAt', 'schema']);
        assert.strictEqual(request.schema, 'colab-workspace-append-request-v1');
        assert.strictEqual(request.nonce, options.nonce);
        assert.strictEqual(request.activationId, activationId);
        assert.strictEqual(request.extensionHostPid, process.pid);
        const age = Date.now() - Date.parse(request.requestedAt);
        assert.ok(Number.isFinite(age) && age >= 0 && age <= 15000, 'Append fixture request expired.');
        const before = state();
        assert.strictEqual(vscode.workspace.workspaceFile?.scheme, 'untitled');
        assert.strictEqual(before.workspaceUri, request.expectedWorkspaceUri);
        assert.deepStrictEqual(before.roots, [request.expectedRoot]);
        assert.strictEqual(vscode.workspace.notebookDocuments.length, 0);
        assert.strictEqual(vscode.workspace.textDocuments.filter(document => document.isDirty || document.isUntitled).length, 0);
        const appended = vscode.Uri.parse(options.appendRootUri);
        assert.strictEqual(appended.scheme, 'file');
        assert.strictEqual(fs.statSync(appended.fsPath).isDirectory(), true);
        const invocationId = crypto.randomUUID();
        const accepted = vscode.workspace.updateWorkspaceFolders(1, 0, { uri: appended, name: options.appendRootName });
        fs.writeFileSync(options.acknowledgmentPath, JSON.stringify({
            schema: 'colab-workspace-append-ack-v1', nonce: options.nonce, invocationId,
            requestedAt: new Date().toISOString(), accepted, before,
            appendedRoot: { uri: appended.toString(), name: options.appendRootName }
        }), { flag: 'wx' });
        if (accepted) {
            // If this extension host restarts, its disposal cancels this proof.
            settleTimer = setTimeout(() => {
                fs.writeFileSync(options.settledPath, JSON.stringify({
                    schema: 'colab-workspace-append-settled-v1', nonce: options.nonce,
                    invocationId, state: state()
                }), { flag: 'wx' });
            }, 1000);
        }
    }));
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999998);
    item.text = marker;
    item.command = command;
    item.show();
    context.subscriptions.push(item, new vscode.Disposable(() => clearTimeout(settleTimer)));
};
