'use strict';

/**
 * The Mac's side of the VS Code / text-reply work: its hooks are sh + curl,
 * so the exact commands the installer writes are run here against a real
 * hook server.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const { createHookServer } = require('../src/server');
const { installHooks, MEANINGFUL_TOOLS } = require('../bin/clippy-hooks');
const { terminalFromHeaders, editorAppIn } = require('../src/terminal');

const hasCurl = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v curl'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = process.platform === 'win32' || !hasCurl;

function runHook(command, stdin, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => resolve({ code, out, err }));
    child.stdin.end(stdin);
  });
}

async function withServer(onEvent, fn) {
  const server = createHookServer({ port: 0, onEvent });
  const { port } = await server.listenOn();
  try {
    await fn(installHooks({}, port, { style: 'command' }));
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

const groupFor = (settings, event, matcher = '') =>
  (settings.hooks[event] || []).find((g) => (g.matcher || '') === matcher);

test('the Mac hooks say when a session is the VS Code extension', { skip }, async () => {
  let seen = null;
  await withServer(
    (event, kind, payload, ctx) => {
      seen = ctx.headers;
    },
    async (settings) => {
      const cmd = groupFor(settings, 'Stop').hooks.find((h) => !h.asyncRewake).command;
      await runHook(cmd, '{"session_id":"s1"}', { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' });
    }
  );
  assert.equal(seen['x-clippy-entrypoint'], 'claude-vscode');
  const term = terminalFromHeaders({ ...seen, 'x-clippy-pid': '4242', 'x-clippy-term': 'vscode' });
  assert.equal(term.program, 'vscode');
  assert.equal(term.entrypoint, 'claude-vscode');
  assert.equal(term.pid, 4242, 'the process walk still has its pid');
});

test("the Mac's PostToolUse passes a note through, and prints nothing otherwise", { skip }, async () => {
  let note = null;
  await withServer(
    () => note || undefined,
    async (settings) => {
      const cmd = groupFor(settings, 'PostToolUse', MEANINGFUL_TOOLS).hooks[0].command;
      const quiet = await runHook(cmd, '{"session_id":"s1"}');
      assert.equal(quiet.code, 0);
      assert.equal(quiet.out, '', 'no {"ok":true} for Claude Code to choke on');
      note = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'user note: use the beta tag' } };
      const withNote = await runHook(cmd, '{"session_id":"s1"}');
      assert.equal(JSON.parse(withNote.out).hookSpecificOutput.additionalContext, 'user note: use the beta tag');
    }
  );
});

test("the Mac's background reply wait exits 2 with the reply, 0 otherwise", { skip }, async () => {
  let reply = {};
  await withServer(
    (event) => (event === 'StopWait' ? reply : undefined),
    async (settings) => {
      const cmd = groupFor(settings, 'Stop').hooks.find((h) => h.asyncRewake).command;
      reply = { clippyRewake: 'The user replied to your last message via Clippy:\n\nAlso update the changelog' };
      const woke = await runHook(cmd, '{"session_id":"s1"}');
      assert.equal(woke.code, 2);
      assert.match(woke.err, /Also update the changelog/);
      reply = {};
      const quiet = await runHook(cmd, '{"session_id":"s1"}');
      assert.equal(quiet.code, 0);
      assert.equal(quiet.err, '');
    }
  );
});

test('with Clippy not running, the Mac wait ends at once and quietly', { skip }, async () => {
  const settings = installHooks({}, 1, { style: 'command' }); // nothing listens on port 1
  const cmd = groupFor(settings, 'Stop').hooks.find((h) => h.asyncRewake).command;
  const started = Date.now();
  const res = await runHook(cmd, '{}');
  assert.equal(res.code, 0);
  assert.ok(Date.now() - started < 3000);
});

test('a remote session finds VS Code by its bundle, not by a process it lacks', async () => {
  const table = new Map([
    [1, { ppid: 0, comm: '/sbin/launchd' }],
    [500, { ppid: 1, comm: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' }],
    [510, { ppid: 500, comm: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)' }],
    [600, { ppid: 1, comm: '/Applications/Ghostty.app/Contents/MacOS/ghostty' }],
  ]);
  const app = await editorAppIn(table, async () => 'com.microsoft.VSCode');
  assert.deepEqual(app, {
    pid: 500,
    name: 'Visual Studio Code',
    bundle: '/Applications/Visual Studio Code.app',
    bundleId: 'com.microsoft.VSCode',
  });
  assert.equal(await editorAppIn(new Map([[600, table.get(600)]])), null);
});

/* ---------------- "stay quiet" for VS Code sessions on the Mac ---------------- */

const { editorFocused, parseFrontEditor } = require('../src/frontmost');
const { titleNames } = require('../src/win-windows');

const said = (bundleId, name, title) => async () => `${bundleId}\t${name}\t${title}\n`;

test('the Mac stays quiet when this project\'s VS Code window is in front', async () => {
  const exec = said('com.microsoft.VSCode', 'Code', 'server.js — gnarshare-working [Tunnel: Uder]');
  assert.equal(await editorFocused(null, 'gnarshare-working', { exec, titleNames }), true);
});

test('another project\'s VS Code window does not silence this one', async () => {
  const exec = said('com.microsoft.VSCode', 'Code', 'notes.md — other-project');
  assert.equal(await editorFocused(null, 'gnarshare-working', { exec, titleNames }), false);
});

test('any other app in front means pop up', async () => {
  const exec = said('com.apple.Safari', 'Safari', 'gnarshare-working - GitHub');
  assert.equal(await editorFocused(null, 'gnarshare-working', { exec, titleNames }), false);
});

test('no window title (no Accessibility yet): the editor in front is enough', async () => {
  const exec = said('com.microsoft.VSCode', 'Code', '');
  assert.equal(await editorFocused(null, 'gnarshare-working', { exec, titleNames }), true);
});

test('System Events refused: falls back to the app lsappinfo saw', async () => {
  const exec = async () => {
    throw new Error('not authorised to send Apple events');
  };
  assert.equal(await editorFocused({ pid: 5, bundleId: 'com.microsoft.VSCode', name: 'Code' }, 'x', { exec, titleNames }), true);
  assert.equal(await editorFocused({ pid: 6, bundleId: 'com.apple.Safari', name: 'Safari' }, 'x', { exec, titleNames }), false);
  assert.equal(await editorFocused(null, 'x', { exec, titleNames }), false, 'not knowing never silences');
});

test('Cursor and other VS Code builds count as the editor', async () => {
  const exec = said('com.todesktop.230313mzl4w4u92', 'Cursor', 'app.ts — gnarshare-working');
  assert.equal(await editorFocused(null, 'gnarshare-working', { exec, titleNames }), true);
  assert.deepEqual(parseFrontEditor('a\tb\tc d\n'), { bundleId: 'a', name: 'b', title: 'c d' });
});

test('when titles cannot be read, Clippy is told which permission is missing', async () => {
  const states = [];
  const onTitle = (s) => states.push(s);
  await editorFocused(null, 'p', { exec: said('com.microsoft.VSCode', 'Code', ''), titleNames, onTitle });
  await editorFocused({ pid: 5, bundleId: 'com.microsoft.VSCode', name: 'Code' }, 'p', {
    exec: async () => {
      throw new Error('not authorised');
    },
    titleNames,
    onTitle,
  });
  await editorFocused(null, 'p', { exec: said('com.microsoft.VSCode', 'Code', 'a — p'), titleNames, onTitle });
  await editorFocused(null, 'p', { exec: said('com.apple.Safari', 'Safari', ''), titleNames, onTitle });
  assert.deepEqual(states, ['accessibility', 'automation', 'ok'], 'another app in front says nothing either way');
});

/* ---------------- VS Code's own word on which window has focus ---------------- */

const { focusFromEditorReports } = require('../src/frontmost');
const { startFocusReports, folderName } = require('../vscode/clippy-bridge-ui/focus-report');

test('in the local project window, a remote session prompts (another folder)', () => {
  const now = 1_000_000;
  const reports = [
    { window: 'a', focused: false, folders: ['gnarshare-working'], remote: 'tunnel', at: now - 1000 },
    { window: 'b', focused: true, folders: ['flight-clock-app'], remote: '', at: now - 500 },
  ];
  assert.equal(focusFromEditorReports(reports, 'gnarshare-working', { now }).focused, false);
  assert.equal(focusFromEditorReports(reports, 'flight-clock-app', { now }).focused, true);
  assert.equal(focusFromEditorReports(reports, 'Flight-Clock-App', { now }).focused, true, 'case does not matter');
});

test('no VS Code window focused means you are elsewhere', () => {
  const now = 1_000_000;
  const reports = [{ window: 'a', focused: false, folders: ['x'], at: now }];
  assert.deepEqual(focusFromEditorReports(reports, 'x', { now }).focused, false);
});

test('no recent reports: fall back to window titles', () => {
  const now = 1_000_000;
  assert.equal(focusFromEditorReports([], 'x', { now }), null);
  assert.equal(focusFromEditorReports([{ window: 'a', focused: true, folders: ['x'], at: now - 120_000 }], 'x', { now }), null);
});

test('the extension reports focus changes, folders and a goodbye', async () => {
  const posts = [];
  let onState = null;
  const vscode = {
    window: { state: { focused: true }, onDidChangeWindowState: (fn) => ((onState = fn), { dispose() {} }) },
    workspace: {
      workspaceFolders: [{ uri: { path: '/Volume1/GnarShare/gnarshare-working' } }],
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    },
    env: { remoteName: 'tunnel' },
  };
  const reporter = startFocusReports({ vscode, post: async (b) => posts.push(b), heartbeatMs: 60_000 });
  vscode.window.state.focused = false;
  onState();
  reporter.dispose();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(posts.map((p) => [p.focused, p.gone || false]), [[true, false], [false, false], [false, true]]);
  assert.deepEqual(posts[0].folders, ['gnarshare-working']);
  assert.equal(posts[0].remote, 'tunnel');
  assert.equal(new Set(posts.map((p) => p.window)).size, 1, 'one id per window');
  assert.equal(folderName({ uri: { path: '/a/b/' } }), 'b');
});

/* ---------------- matching by full path ---------------- */

const { within } = require('../src/frontmost');
const { folderPath } = require('../vscode/clippy-bridge-ui/focus-report');

test('a session in a subfolder of the focused window counts as that window', () => {
  const now = 1_000_000;
  const reports = [
    { window: 'l', focused: true, folders: ['Projects'], paths: ['/Users/roy/Projects'], at: now },
    { window: 'r', focused: false, folders: ['gnarshare-working'], paths: ['/Volume1/GnarShare/gnarshare-working'], at: now },
  ];
  const local = focusFromEditorReports(reports, 'flight-clock-app', { now, cwd: '/Users/roy/Projects/flight-clock-app' });
  assert.equal(local.focused, true, 'Claude started below the folder VS Code has open');
  const deeper = focusFromEditorReports(reports, 'ios', { now, cwd: '/Users/roy/Projects/flight-clock-app/ios' });
  assert.equal(deeper.focused, true);
  const remote = focusFromEditorReports(reports, 'gnarshare-working', { now, cwd: '/Volume1/GnarShare/gnarshare-working' });
  assert.equal(remote.focused, false, 'the NAS session is in the other window');
});

test('a folder whose name only starts the same is a different folder', () => {
  assert.equal(within('/Users/roy/app-old', '/Users/roy/app'), false);
  assert.equal(within('/Users/roy/app', '/Users/roy/app/'), true);
  assert.equal(within('C:\\Users\\roy\\app\\src', '/c:/Users/Roy/app'), true, 'Windows paths compare too');
  assert.equal(within('', '/x'), false);
});

test('reports from an older extension still match by name', () => {
  const now = 1_000_000;
  const reports = [{ window: 'l', focused: true, folders: ['flight-clock-app'], at: now }];
  assert.equal(focusFromEditorReports(reports, 'flight-clock-app', { now, cwd: '/Users/roy/flight-clock-app' }).focused, true);
});

test('the extension reports native paths for local folders and remote paths for remote ones', () => {
  assert.equal(folderPath({ uri: { scheme: 'file', fsPath: '/Users/roy/app', path: '/Users/roy/app' } }), '/Users/roy/app');
  assert.equal(folderPath({ uri: { scheme: 'vscode-remote', path: '/Volume1/GnarShare/gnarshare-working' } }), '/Volume1/GnarShare/gnarshare-working');
});
