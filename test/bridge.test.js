'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createBridgeServer, fromLoopbackClient } = require('../vscode/clippy-bridge-remote/bridge-core');
const { createDeliverer } = require('../vscode/clippy-bridge-ui/deliver-core');
const { createHookServer } = require('../src/server');
const { installHooks, checkDrift, listInstalled, uninstallHooks, relayCommand, SPECS } = require('../bin/clippy-hooks');

const KEY = 'test-key-0123456789abcdefghij';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * The whole chain as it runs for real, minus VS Code's command plumbing in
 * the middle: hook → remote half → (VS Code) → local half → Clippy's server.
 */
async function withChain(onEvent, fn) {
  const clippy = createHookServer({ port: 0, onEvent });
  const clippyPort = (await clippy.listenOn()).port;
  const local = createDeliverer({ port: clippyPort });
  const bridge = createBridgeServer({
    key: KEY,
    host: 'uder',
    deliver: (ev) => local.deliver(JSON.parse(JSON.stringify(ev))), // as VS Code would serialise it
    cancel: (id) => local.cancel(id),
  });
  const bridgePort = await listen(bridge);
  try {
    await fn({ bridgePort, base: `http://127.0.0.1:${bridgePort}`, local });
  } finally {
    bridge.closeAllConnections?.();
    bridge.close();
    clippy.closeAllConnections?.();
    clippy.close();
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

test('the remote half refuses a wrong key and anything a web page sends', async () => {
  await withChain(() => undefined, async ({ base }) => {
    assert.equal((await request(base, { path: '/status' })).status, 403);
    assert.equal((await request(base, { path: '/status', headers: { 'X-Clippy-Relay-Key': 'nope' } })).status, 403);
    assert.equal((await request(base, { path: '/status', headers: keyed({ Origin: 'http://evil.test' }) })).status, 403);
    assert.equal((await request(base, { path: '/status', headers: keyed({ Host: 'evil.test' }) })).status, 403);
    const ok = await request(base, { path: '/status', headers: keyed() });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).bridge, 'clippy');
  });
  assert.equal(fromLoopbackClient({ headers: { host: 'localhost:43118' } }), true);
});

test('a held prompt reaches Clippy and its decision comes back to the hook', async () => {
  const seen = [];
  await withChain(
    (event, kind, payload, ctx) => {
      seen.push({ event, kind, payload, ctx });
      if (event === 'PermissionRequest') {
        return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
      }
      return undefined;
    },
    async ({ base }) => {
      const held = await request(base, {
        path: '/hook/PermissionRequest?source=claude&hold=1',
        method: 'POST',
        headers: keyed({ 'X-Clippy-Entrypoint': 'claude-vscode' }),
        body: '{"session_id":"s1","tool_name":"Bash"}',
      });
      assert.equal(held.status, 200);
      assert.equal(JSON.parse(held.text).hookSpecificOutput.decision.behavior, 'allow');

      const passive = await request(base, {
        path: '/hook/Notification?kind=idle_prompt&source=claude',
        method: 'POST',
        headers: keyed(),
        body: '{"session_id":"s1"}',
      });
      assert.equal(passive.status, 204);
      await new Promise((r) => setTimeout(r, 100));

      const perm = seen.find((e) => e.event === 'PermissionRequest');
      assert.equal(perm.payload.tool_name, 'Bash');
      assert.equal(perm.ctx.source, 'claude');
      assert.equal(perm.ctx.headers['x-clippy-hook'], '#clippy');
      assert.equal(perm.ctx.headers['x-clippy-remote'], 'uder');
      assert.equal(perm.ctx.headers['x-clippy-entrypoint'], 'claude-vscode');
      assert.equal(perm.ctx.headers['x-clippy-relay-key'], undefined, 'the key never leaves the remote machine');
      const note = seen.find((e) => e.event === 'Notification');
      assert.equal(note.kind, 'idle_prompt');
    }
  );
});

test('a hook that gives up closes its card in Clippy', async () => {
  let closed = false;
  let arrived;
  const arrivedP = new Promise((r) => (arrived = r));
  await withChain(
    (event, kind, payload, ctx) => {
      ctx.onClose(() => (closed = true));
      arrived();
      return new Promise(() => {}); // the user never answers
    },
    async ({ bridgePort }) => {
      const req = http.request({
        host: '127.0.0.1',
        port: bridgePort,
        path: '/hook/PermissionRequest?source=claude&hold=1',
        method: 'POST',
        headers: keyed(),
      });
      req.on('error', () => {});
      req.end('{}');
      await arrivedP;
      req.destroy(); // Claude Code cancelling the hook
      for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(closed, true);
    }
  );
});

test('with Clippy not running, the hook gets no decision straight away', async () => {
  const probe = http.createServer();
  const deadPort = await listen(probe);
  await new Promise((r) => probe.close(r));
  const local = createDeliverer({ port: deadPort });
  const bridge = createBridgeServer({ key: KEY, deliver: (ev) => local.deliver(ev) });
  const port = await listen(bridge);
  try {
    const started = Date.now();
    const res = await request(`http://127.0.0.1:${port}`, {
      path: '/hook/PermissionRequest?source=claude&hold=1',
      method: 'POST',
      headers: keyed(),
      body: '{}',
    });
    assert.equal(res.status, 204);
    assert.ok(Date.now() - started < 2000);
    assert.equal(bridge.stats.failed, 1);
  } finally {
    bridge.close();
  }
});

test('when the local half is missing entirely, the hook still passes', async () => {
  const bridge = createBridgeServer({
    key: KEY,
    deliver: () => Promise.reject(new Error("command 'clippyBridge.deliver' not found")),
  });
  const port = await listen(bridge);
  try {
    const res = await request(`http://127.0.0.1:${port}`, {
      path: '/hook/PermissionRequest?source=claude&hold=1',
      method: 'POST',
      headers: keyed(),
      body: '{}',
    });
    assert.equal(res.status, 204);
    assert.match(bridge.stats.lastError, /not found/);
  } finally {
    bridge.close();
  }
});

test('relay hooks install, are ours, and are never reported as out of date for their style', () => {
  const settings = installHooks({}, 43117, { style: 'relay' });
  assert.equal(listInstalled(settings).length, SPECS.length + 1, 'plus the rewake wait');
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

test('both extension manifests run where they must', () => {
  const remote = require('../vscode/clippy-bridge-remote/package.json');
  const ui = require('../vscode/clippy-bridge-ui/package.json');
  assert.deepEqual(remote.extensionKind, ['workspace']);
  assert.deepEqual(ui.extensionKind, ['ui']);
  assert.ok(ui.activationEvents.includes('onCommand:clippyBridge.deliver'));
});

/* ---------------- hook.sh, for real ---------------- */

const hasCurl = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v curl'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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

test('hook.sh carries a prompt through the whole bridge and prints the decision', { skip: process.platform === 'win32' || !hasCurl }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-bridge-'));
  fs.writeFileSync(path.join(dir, 'key'), `${KEY}\n`);
  await withChain(
    (event, kind, payload, ctx) =>
      event === 'PermissionRequest'
        ? { hookSpecificOutput: { decision: { behavior: 'deny', message: `no ${payload.tool_name} from ${ctx.headers['x-clippy-entrypoint']}` } } }
        : undefined,
    async ({ bridgePort }) => {
      const env = { CLIPPY_RELAY_PORT: String(bridgePort), CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' };
      const res = await runHook(dir, ['PermissionRequest?source=claude', 'hold'], '{"tool_name":"Bash"}', env);
      assert.equal(res.code, 0);
      assert.equal(JSON.parse(res.out).hookSpecificOutput.decision.message, 'no Bash from claude-vscode');
      const passive = await runHook(dir, ['Stop?source=claude'], '{}', env);
      assert.equal(passive.code, 0);
      assert.equal(passive.out, '');
    }
  );
});

test('hook.sh with no VS Code connected exits quietly at once', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-bridge-'));
  fs.writeFileSync(path.join(dir, 'key'), `${KEY}\n`);
  const probe = http.createServer();
  const deadPort = await listen(probe);
  await new Promise((r) => probe.close(r));
  const started = Date.now();
  const res = await runHook(dir, ['PermissionRequest?source=claude', 'hold'], '{}', { CLIPPY_RELAY_PORT: String(deadPort) });
  assert.equal(res.code, 0);
  assert.equal(res.out, '');
  assert.ok(Date.now() - started < 3000);
});

test('hook.sh without a key does nothing at all', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-bridge-'));
  const res = await runHook(dir, ['Stop?source=claude'], '{}');
  assert.equal(res.code, 0);
  assert.equal(res.out, '');
});

/* ---------------- usage read on the remote machine ---------------- */

test('the remote bridge reads usage there and sends it as a ClippyUsage event', async () => {
  const { createUsagePusher } = require('../vscode/clippy-bridge-remote/usage-push');
  const usage = require('../src/usage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-remote-usage-'));
  const transcript = path.join(dir, 'abc.jsonl');
  const ts = new Date().toISOString();
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: 'fix the build' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: {
          model: 'claude-opus-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'Fixed the build.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 },
        },
      }),
    ].join('\n') + '\n'
  );
  const claudeJson = path.join(dir, '.claude.json');
  fs.writeFileSync(
    claudeJson,
    JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs: 1_785_873_983_262,
        utilization: { limits: [{ kind: 'session', group: 'session', percent: 37, severity: 'normal', resets_at: null }] },
      },
    })
  );

  const sent = [];
  const pusher = createUsagePusher({
    usage,
    host: 'uder',
    claudeJson,
    projectsDir: dir,
    debounceMs: 10,
    deliver: async (ev) => sent.push(ev),
  });
  pusher.note({ event: 'PreToolUse', body: JSON.stringify({ session_id: 's1', transcript_path: transcript }) });
  pusher.note({ event: 'PostToolUse', body: JSON.stringify({ session_id: 's1', transcript_path: transcript }) });
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sent.length, 1, 'a burst of events is one send');
  const ev = sent[0];
  assert.equal(ev.event, 'ClippyUsage');
  assert.equal(ev.headers['x-clippy-remote'], 'uder');
  const body = JSON.parse(ev.body);
  assert.equal(body.session_id, 's1');
  assert.equal(body.session.context, 41050); // input + cache + output, as Clippy counts it
  assert.equal(body.recap, 'Fixed the build.');
  assert.equal(body.official.limits[0].percent, 37);
  assert.equal(body.windows, null, 'no transcript sweep when Claude Code cached /usage');
  // It survives VS Code's trip (JSON) intact.
  assert.deepEqual(JSON.parse(JSON.stringify(body)), body);
  pusher.stop();
});

test('events without a transcript, and its own events, never trigger a send', async () => {
  const { createUsagePusher } = require('../vscode/clippy-bridge-remote/usage-push');
  const sent = [];
  const pusher = createUsagePusher({ usage: require('../src/usage'), debounceMs: 5, deliver: async (ev) => sent.push(ev) });
  pusher.note({ event: 'Stop', body: '{"session_id":"s1"}' });
  pusher.note({ event: 'ClippyUsage', body: '{"session_id":"s1","transcript_path":"/x"}' });
  pusher.note({ event: 'Stop', body: 'not json' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0);
  pusher.stop();
});

/* ---------------- words back to Claude ---------------- */

test('a note typed beside Allow comes back with that session\'s next tool result', async () => {
  await withChain(
    (event) =>
      event === 'PermissionRequest'
        ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }, clippyNote: 'use --force this time' }
        : undefined,
    async ({ base }) => {
      const perm = await request(base, {
        path: '/hook/PermissionRequest?source=claude&hold=1',
        method: 'POST',
        headers: keyed(),
        body: '{"session_id":"s1","tool_name":"Bash"}',
      });
      const decision = JSON.parse(perm.text);
      assert.equal(decision.hookSpecificOutput.decision.behavior, 'allow');
      assert.equal(decision.clippyNote, undefined, 'the hook never sees the extra field');

      const other = await request(base, { path: '/hook/PostToolUse?source=claude', method: 'POST', headers: keyed(), body: '{"session_id":"s2"}' });
      assert.equal(other.status, 204, 'another session gets nothing');
      const post = await request(base, { path: '/hook/PostToolUse?source=claude', method: 'POST', headers: keyed(), body: '{"session_id":"s1"}' });
      assert.equal(post.status, 200);
      const out = JSON.parse(post.text).hookSpecificOutput;
      assert.equal(out.hookEventName, 'PostToolUse');
      assert.match(out.additionalContext, /use --force this time/);
      const again = await request(base, { path: '/hook/PostToolUse?source=claude', method: 'POST', headers: keyed(), body: '{"session_id":"s1"}' });
      assert.equal(again.status, 204, 'delivered once');
    }
  );
});

test('hook.sh in rewake mode exits 2 with the reply, and 0 when signed off', { skip: process.platform === 'win32' || !hasCurl }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-bridge-'));
  fs.writeFileSync(path.join(dir, 'key'), `${KEY}\n`);
  let answer = null;
  await withChain(
    (event) => (event === 'StopWait' ? new Promise((r) => setTimeout(() => r(answer), 200)) : undefined),
    async ({ bridgePort }) => {
      const env = { CLIPPY_RELAY_PORT: String(bridgePort) };
      const runRewake = () =>
        new Promise((resolve) => {
          const child = spawn('sh', [path.join(__dirname, '..', 'relay', 'hook.sh'), 'StopWait?source=claude', 'rewake'], {
            env: { ...process.env, CLIPPY_RELAY_DIR: dir, ...env },
          });
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (err += d));
          child.on('exit', (code) => resolve({ code, out, err }));
          child.stdin.end('{"session_id":"s1"}');
        });
      answer = { clippyRewake: 'The user replied to your last message via Clippy:\n\nAlso update the README.' };
      const replied = await runRewake();
      assert.equal(replied.code, 2);
      assert.equal(replied.out, '');
      assert.match(replied.err, /Also update the README\./);
      answer = {};
      const signedOff = await runRewake();
      assert.equal(signedOff.code, 0);
      assert.equal(signedOff.err, '');
    }
  );
});
