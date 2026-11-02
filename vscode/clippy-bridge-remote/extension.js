'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBridgeServer } = require('./bridge-core');

const DELIVER = 'clippyBridge.deliver';
const CANCEL = 'clippyBridge.cancel';
const RETRY_MS = 15_000;

let server = null;
let retry = null;
let out = null;

function setting(name, fallback) {
  return vscode.workspace.getConfiguration('clippyBridge').get(name, fallback);
}

function keyPath() {
  return path.join(os.homedir(), '.clippy-relay', 'key');
}

function start() {
  clearTimeout(retry);
  let key = '';
  try {
    key = fs.readFileSync(keyPath(), 'utf8').trim();
  } catch {
    out.appendLine(`No key at ${keyPath()} — run Clippy's setup command on this machine, then reload the window.`);
    return;
  }
  const port = Number(setting('port', 43118)) || 43118;
  const s = createBridgeServer({
    key,
    host: os.hostname(),
    deliver: (ev) => vscode.commands.executeCommand(DELIVER, ev),
    cancel: (id) => vscode.commands.executeCommand(CANCEL, id),
    log: (msg) => out.appendLine(`${new Date().toISOString()} ${msg}`),
  });
  s.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Another VS Code window connected to this machine has the port; it
      // delivers to the same Clippy. Take over if it closes.
      out.appendLine(`Port ${port} is in use (another VS Code window?) — will retry.`);
      retry = setTimeout(start, RETRY_MS);
    } else {
      out.appendLine(`Bridge error: ${err.message}`);
    }
  });
  s.listen(port, '127.0.0.1', () => {
    server = s;
    out.appendLine(`Listening for Claude Code hooks on 127.0.0.1:${port} (${os.hostname()}).`);
  });
}

function activate(context) {
  out = vscode.window.createOutputChannel('Clippy Bridge');
  context.subscriptions.push(out);
  context.subscriptions.push(
    vscode.commands.registerCommand('clippyBridge.remoteStatus', async () => {
      let local = 'not installed on this computer';
      try {
        const r = await vscode.commands.executeCommand('clippyBridge.ping');
        local = r && r.clippy ? 'installed, Clippy is running' : 'installed, but Clippy is not running';
      } catch {}
      vscode.window.showInformationMessage(
        `Clippy Bridge on ${os.hostname()}: ${server ? 'listening' : 'not listening'}. Local half: ${local}.`
      );
      out.show(true);
    })
  );
  context.subscriptions.push({
    dispose() {
      clearTimeout(retry);
      server?.close();
      server = null;
    },
  });
  start();
}

function deactivate() {
  clearTimeout(retry);
  server?.close();
  server = null;
}

module.exports = { activate, deactivate };
