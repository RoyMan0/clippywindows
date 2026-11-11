'use strict';

const vscode = require('vscode');
const { createDeliverer } = require('./deliver-core');
const { startFocusReports } = require('./focus-report');

function activate(context) {
  const port = Number(vscode.workspace.getConfiguration('clippyBridge').get('clippyPort', 43117)) || 43117;
  const bridge = createDeliverer({ port });
  context.subscriptions.push(
    vscode.commands.registerCommand('clippyBridge.deliver', (ev) => bridge.deliver(ev)),
    vscode.commands.registerCommand('clippyBridge.cancel', (id) => bridge.cancel(id)),
    vscode.commands.registerCommand('clippyBridge.ping', () => bridge.ping()),
    // Which window you're in, so Clippy stays quiet only over the right one.
    startFocusReports({ vscode, post: (body) => bridge.report('ClippyFocus', body) })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
