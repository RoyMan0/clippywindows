'use strict';

/**
 * Tell Clippy which VS Code window has focus, and which folders it has open.
 *
 * Clippy stays quiet when you are already looking at the window a session is
 * asking from. On the Mac it used to work that out from window titles, which
 * macOS only hands over with Accessibility permission — and an unsigned build
 * loses that permission every time it is replaced. VS Code knows the answer
 * itself, without any permission: `window.state.focused` is true only while
 * this window is the one you are using. Every window (local or remote) runs
 * this half of the bridge, so each one reports for itself.
 *
 * A report on every focus change, and a heartbeat while open, so Clippy can
 * tell a window that is still there from one that has gone.
 */

const path = require('node:path');
const crypto = require('node:crypto');

const HEARTBEAT_MS = 20_000;

/** A folder's name, from a workspace folder URI (local or remote). */
const folderName = (folder) => path.posix.basename(String(folder?.uri?.path || '').replace(/\/+$/, ''));

/**
 * A folder's full path as the agent there would write its cwd: the native path
 * for a local folder (`/Users/me/app`, `C:\\Users\\me\\app`), the path on
 * that machine for a remote one (`/Volume1/share/app`).
 */
const folderPath = (folder) => {
  const uri = folder?.uri;
  if (!uri) return '';
  return String(uri.scheme === 'file' && uri.fsPath ? uri.fsPath : uri.path || '');
};

function startFocusReports({ vscode, post, heartbeatMs = HEARTBEAT_MS }) {
  const window = crypto.randomBytes(6).toString('hex');
  const report = (extra = {}) => {
    const body = {
      window,
      focused: Boolean(vscode.window.state?.focused),
      folders: (vscode.workspace.workspaceFolders || []).map(folderName).filter(Boolean),
      paths: (vscode.workspace.workspaceFolders || []).map(folderPath).filter(Boolean),
      remote: vscode.env?.remoteName || '',
      ...extra,
    };
    Promise.resolve()
      .then(() => post(body))
      .catch(() => {}); // Clippy not running: nothing to tell
  };
  const subs = [
    vscode.window.onDidChangeWindowState(() => report()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => report()),
  ];
  const timer = setInterval(() => report(), heartbeatMs);
  timer.unref?.();
  report();
  return {
    dispose() {
      clearInterval(timer);
      for (const s of subs) s?.dispose?.();
      report({ focused: false, gone: true });
    },
  };
}

module.exports = { startFocusReports, folderName, folderPath };
