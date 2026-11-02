'use strict';

const vscode = require('vscode');
const { createDeliverer } = require('./deliver-core');

function activate(context) {
  const port = Number(vscode.workspace.getConfiguration('clippyBridge').get('clippyPort', 43117)) || 43117;
  const bridge = createDeliverer({ port });
  context.subscriptions.push(
    vscode.commands.registerCommand('clippyBridge.deliver', (ev) => bridge.deliver(ev)),
    vscode.commands.registerCommand('clippyBridge.cancel', (id) => bridge.cancel(id)),
    vscode.commands.registerCommand('clippyBridge.ping', () => bridge.ping())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
