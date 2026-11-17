'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBridgeServer } = require('./bridge-core');
const { createUsagePusher } = require('./usage-push');

// Clippy's own usage reader, copied in at packaging time (see
// scripts/prepare-bridge.js). Without it the bridge still carries events; the
// stats panel just has nothing to show for remote sessions.
let usage = null;
try {
  usage = require('./lib/usage');
} catch {
  usage = null;
}

const DELIVER = 'clippyBridge.deliver';
const CANCEL = 'clippyBridge.cancel';
const RETRY_MS = 15_000;

let server = null; // the shared port (43118): sessions not started from a VS Code window
let own = null; // this window's own port, registered for its sessions' hooks
let ownFile = '';
let retry = null;
let out = null;
let pusher = null;

function setting(name, fallback) {
  return vscode.workspace.getConfiguration('clippyBridge').get(name, fallback);
}

function keyPath() {
  return path.join(os.homedir(), '.clippy-relay', 'key');
}

/**
 * Where each VS Code window's bridge says which port it listens on, named after
 * its extension host's pid. Claude Code sessions run as children of that
 * process, so hook.sh walks up its own parents to the first pid with a file
 * here — the window the session actually belongs to, on whichever computer.
 */
const hostsDir = () => path.join(os.homedir(), '.clippy-relay', 'hosts');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Forget registrations left by windows that have gone. */
function pruneHosts() {
  let names = [];
  try {
    names = fs.readdirSync(hostsDir());
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(name);
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) {
      try {
        fs.rmSync(path.join(hostsDir(), name), { force: true });
      } catch {}
    }
  }
}

function unregister() {
  if (!ownFile) return;
  try {
    fs.rmSync(ownFile, { force: true });
  } catch {}
  ownFile = '';
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
  const deliver = (ev) => vscode.commands.executeCommand(DELIVER, ev);
  const log = (msg) => out.appendLine(`${new Date().toISOString()} ${msg}`);
  if (!pusher) pusher = usage ? createUsagePusher({ usage, deliver, host: os.hostname(), log }) : null;
  const makeServer = () =>
    createBridgeServer({
      key,
      host: os.hostname(),
      deliver: (ev) => {
        pusher?.note(ev);
        return deliver(ev);
      },
      cancel: (id) => vscode.commands.executeCommand(CANCEL, id),
      log,
    });

  // This window's own port, for the sessions it runs: their hooks find it
  // through the registration file, so they reach this window's computer even
  // when other windows (on this or another computer) are connected too.
  if (!own) {
    const o = makeServer();
    o.on('error', (err) => out.appendLine(`Bridge error: ${err.message}`));
    o.listen(0, '127.0.0.1', () => {
      own = o;
      try {
        pruneHosts();
        fs.mkdirSync(hostsDir(), { recursive: true, mode: 0o700 });
        ownFile = path.join(hostsDir(), String(process.pid));
        fs.writeFileSync(ownFile, `${o.address().port}\n`, { mode: 0o600 });
        out.appendLine(`This window's sessions reach it on 127.0.0.1:${o.address().port}.`);
      } catch (err) {
        out.appendLine(`Could not register this window (${err.message}); its sessions use the shared port.`);
      }
    });
  }

  // The shared port: sessions that weren't started from a VS Code window (a
  // `claude` in an SSH terminal) still reach whichever window holds it.
  const s = makeServer();
  s.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Another VS Code window connected to this machine has the port; it
      // delivers to the same Clippy. Take over if it closes.
      out.appendLine(`Shared port ${port} is held by another VS Code window; this window's own sessions still come here.`);
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
      const mine = own ? `this window on port ${own.address().port}` : 'this window not registered';
      vscode.window.showInformationMessage(
        `Clippy Bridge on ${os.hostname()}: ${mine}; shared port ${server ? 'held here' : 'held by another window'}. Local half: ${local}.`
      );
      out.show(true);
    })
  );
  context.subscriptions.push({
    dispose() {
      clearTimeout(retry);
      server?.close();
      server = null;
      own?.close();
      own = null;
      unregister();
    },
  });
  start();
}

function deactivate() {
  pusher?.stop();
  clearTimeout(retry);
  server?.close();
  server = null;
  own?.close();
  own = null;
  unregister();
}

module.exports = { activate, deactivate };
