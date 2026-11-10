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
