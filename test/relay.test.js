'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRelay, fromLoopbackClient, vscodeSettings } = require('../relay/clippy-relay');
const { RelayClient, parseQuery } = require('../src/relay-client');
const { installHooks, checkDrift, listInstalled, uninstallHooks, relayCommand, SPECS } = require('../bin/clippy-hooks');

const KEY = 'test-key-0123456789abcdefghij';

async function withRelay(opts, fn) {
  const relay = createRelay({ key: KEY, ...opts });
  await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
  const port = relay.server.address().port;
  try {
    await fn({ relay, port, base: `http://127.0.0.1:${port}` });
  } finally {
    relay.server.closeAllConnections?.();
    relay.server.close();
  }
}

function request(base, { path: p, method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + p);
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const keyed = (extra = {}) => ({ 'X-Clippy-Relay-Key': KEY, ...extra });

test('the relay refuses a wrong key and anything a web page sends', async () => {
  await withRelay({}, async ({ base }) => {
    assert.equal((await request(base, { path: '/status' })).status, 403);
    assert.equal((await request(base, { path: '/status', headers: { 'X-Clippy-Relay-Key': 'nope' } })).status, 403);
    assert.equal((await request(base, { path: '/status', headers: keyed({ Origin: 'http://evil.test' }) })).status, 403);
    assert.equal((await request(base, { path: '/status', headers: keyed({ Host: 'evil.test' }) })).status, 403);
    const ok = await request(base, { path: '/status', headers: keyed() });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).connected, false);
  });
  // Any loopback port is fine: VS Code may forward to a different one.
  assert.equal(fromLoopbackClient({ headers: { host: '127.0.0.1:61234' } }), true);
});

test('with no Clippy connected, hooks pass straight through with no decision', async () => {
  await withRelay({}, async ({ base }) => {
    const res = await request(base, {
      path: '/hook/PermissionRequest?source=claude&hold=1',
      method: 'POST',
      headers: keyed(),
      body: '{"session_id":"s"}',
    });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
  });
});

test('a held prompt goes to Clippy and its answer comes back to the hook', async () => {
  await withRelay({}, async ({ port, base }) => {
    const seen = [];
    const client = new RelayClient({
      config: () => ({ port, key: KEY }),
      waitMs: 500,
      retryMs: 50,
      log: () => {},
      onEvent: (event, kind, payload, ctx) => {
        seen.push({ event, kind, payload, source: ctx.source, headers: ctx.headers });
        if (event === 'PermissionRequest') {
          return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
        }
        return undefined;
      },
    });
    client.start();
    try {
      // Wait for the first poll so the relay knows Clippy is there.
      for (let i = 0; i < 50 && !JSON.parse((await request(base, { path: '/status', headers: keyed() })).text).connected; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const passive = await request(base, {
        path: '/hook/Notification?kind=idle_prompt&source=claude',
        method: 'POST',
        headers: keyed({ 'X-Clippy-Hook': '#clippy', 'X-Clippy-Entrypoint': 'claude-vscode' }),
        body: '{"session_id":"s1"}',
      });
      assert.equal(passive.status, 204, 'passive events never wait on Clippy');

      const held = await request(base, {
        path: '/hook/PermissionRequest?source=claude&hold=1',
        method: 'POST',
        headers: keyed({ 'X-Clippy-Hook': '#clippy', 'X-Clippy-Remote': 'uder' }),
        body: '{"session_id":"s1","tool_name":"Bash"}',
      });
      assert.equal(held.status, 200);
      assert.equal(JSON.parse(held.text).hookSpecificOutput.decision.behavior, 'allow');

      const note = seen.find((e) => e.event === 'Notification');
      assert.equal(note.kind, 'idle_prompt');
      assert.equal(note.headers['x-clippy-entrypoint'], 'claude-vscode');
      assert.equal(note.headers['x-clippy-relay-key'], undefined, 'the key never reaches the app');
      const perm = seen.find((e) => e.event === 'PermissionRequest');
      assert.equal(perm.payload.tool_name, 'Bash');
      assert.equal(perm.headers['x-clippy-remote'], 'uder');
    } finally {
      client.stop();
    }
  });
});

test('a hook that gives up closes its card in Clippy', async () => {
  await withRelay({}, async ({ port, base }) => {
    let closed = false;
    let arrived;
    const arrivedP = new Promise((r) => (arrived = r));
    const client = new RelayClient({
      config: () => ({ port, key: KEY }),
      waitMs: 500,
      retryMs: 50,
      log: () => {},
      onEvent: (event, kind, payload, ctx) => {
        ctx.onClose(() => (closed = true));
        arrived();
        return new Promise(() => {}); // the user never answers
      },
    });
    client.start();
    try {
      for (let i = 0; i < 50 && !JSON.parse((await request(base, { path: '/status', headers: keyed() })).text).connected; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const url = new URL(`${base}/hook/PermissionRequest?source=claude&hold=1`);
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST', headers: keyed() });
      req.on('error', () => {});
      req.end('{}');
      await arrivedP;
      req.destroy(); // what Claude Code does when the hook is cancelled
      for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(closed, true);
    } finally {
      client.stop();
    }
  });
});

test('when Clippy goes away, held prompts are handed back at once', async () => {
  let t = 0;
  await withRelay({ now: () => t, presentMs: 1000 }, async ({ relay, base }) => {
    // Pretend Clippy polled once, then hold a prompt.
    const poll = request(base, { path: '/next?wait=0', headers: keyed() });
    await poll;
    const pending = request(base, { path: '/hook/PermissionRequest?source=claude&hold=1', method: 'POST', headers: keyed(), body: '{}' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(relay.sweep(), 0, 'still connected');
    t = 5000;
    assert.equal(relay.sweep(), 1);
    assert.equal((await pending).status, 204);
  });
});

test('relay hooks install, are ours, and are never reported as out of date for their style', () => {
  const settings = installHooks({}, 43117, { style: 'relay' });
  assert.equal(listInstalled(settings).length, SPECS.length);
  const perm = settings.hooks.PermissionRequest[0].hooks[0];
  assert.equal(perm.command, `sh "$HOME/.clippy-relay/hook.sh" 'PermissionRequest?source=claude' hold #clippy`);
  assert.equal(perm.timeout, 120);
  const idle = settings.hooks.Notification.find((g) => g.matcher === 'idle_prompt').hooks[0];
  assert.equal(idle.command, `sh "$HOME/.clippy-relay/hook.sh" 'Notification?kind=idle_prompt&source=claude' #clippy`);
  assert.deepEqual(checkDrift(settings, 43117, { style: 'relay' }), {
    installed: true,
    missing: [],
    stale: false,
    wrongPort: false,
    noTerminalInfo: false,
  });
  assert.equal(checkDrift(settings, 43117, { style: 'command' }).stale, true);
  uninstallHooks(settings);
  assert.equal(settings.hooks, undefined);
  assert.match(relayCommand(SPECS[0]), /#clippy$/);
});

test('parseQuery reads kind and source', () => {
  assert.deepEqual(parseQuery('kind=idle_prompt&source=claude'), { kind: 'idle_prompt', source: 'claude' });
  assert.deepEqual(parseQuery(''), { kind: null, source: 'claude' });
});

test('the VS Code port label is merged into existing machine settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-relay-home-'));
  const file = path.join(home, '.vscode-server', 'data', 'Machine', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"editor.fontSize": 14}');
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(vscodeSettings(home), true);
  } finally {
    console.log = log;
  }
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved['editor.fontSize'], 14);
  assert.equal(saved['remote.portsAttributes']['43118'].label, 'Clippy relay');
});

/* ---------------- hook.sh, for real ---------------- */

function runHook(dir, args, stdin, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('sh', [path.join(__dirname, '..', 'relay', 'hook.sh'), ...args], {
      env: { ...process.env, CLIPPY_RELAY_DIR: dir, ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(stdin);
  });
}

const hasCurl = (() => {
  try {
    require('node:child_process').execFileSync('sh', ['-c', 'command -v curl'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('hook.sh carries a held prompt through the relay and prints the decision', { skip: process.platform === 'win32' || !hasCurl }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-relay-'));
  fs.writeFileSync(path.join(dir, 'key'), `${KEY}\n`);
  await withRelay({}, async ({ port }) => {
    const client = new RelayClient({
      config: () => ({ port, key: KEY }),
      waitMs: 500,
      retryMs: 50,
      log: () => {},
      onEvent: (event, kind, payload, ctx) =>
        event === 'PermissionRequest'
          ? { hookSpecificOutput: { decision: { behavior: 'deny', message: `no ${payload.tool_name} from ${ctx.headers['x-clippy-entrypoint']}` } } }
          : undefined,
    });
    client.start();
    try {
      await new Promise((r) => setTimeout(r, 150));
      const env = { CLIPPY_RELAY_PORT: String(port), CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' };
      const res = await runHook(dir, ['PermissionRequest?source=claude', 'hold'], '{"tool_name":"Bash"}', env);
      assert.equal(res.code, 0);
      assert.equal(JSON.parse(res.out).hookSpecificOutput.decision.message, 'no Bash from claude-vscode');
      const passive = await runHook(dir, ['Stop?source=claude'], '{}', env);
      assert.equal(passive.code, 0);
      assert.equal(passive.out, '');
    } finally {
      client.stop();
    }
  });
});

test('hook.sh with no relay running exits quietly and starts one', { skip: process.platform === 'win32' || !hasCurl }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-relay-'));
  fs.writeFileSync(path.join(dir, 'key'), `${KEY}\n`);
  fs.copyFileSync(path.join(__dirname, '..', 'relay', 'clippy-relay.js'), path.join(dir, 'clippy-relay.js'));
  // A free port, nothing listening on it.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const env = { CLIPPY_RELAY_PORT: String(port), PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` };
  const res = await runHook(dir, ['PermissionRequest?source=claude', 'hold'], '{}', env);
  assert.equal(res.code, 0);
  assert.equal(res.out, '');
  let status = null;
  for (let i = 0; i < 50 && !status; i++) {
    await new Promise((r) => setTimeout(r, 100));
    status = await request(`http://127.0.0.1:${port}`, { path: '/status', headers: keyed() }).catch(() => null);
  }
  assert.ok(status, 'the relay came up');
  assert.equal(JSON.parse(status.text).relay, 'clippy');
  // Leave nothing running behind the test.
  spawn('pkill', ['-f', path.join(dir, 'clippy-relay.js')]);
});

test('hook.sh without a key does nothing at all', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-relay-'));
  const res = await runHook(dir, ['Stop?source=claude'], '{}');
  assert.equal(res.code, 0);
  assert.equal(res.out, '');
});
