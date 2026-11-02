#!/usr/bin/env node
'use strict';

/**
 * Clippy relay: carries hook events from a remote machine (a NAS you reach
 * through a VS Code Remote Tunnel, say) to Clippy on your own computer.
 *
 * The problem it solves: when VS Code is connected to a remote machine, Claude
 * Code runs *there*, and its hooks can't reach Clippy's 127.0.0.1:43117 — that
 * address is the remote machine itself. Nor should Clippy listen on the
 * network: whatever can reach it can approve Claude's commands.
 *
 * So both ends stay loopback-only, and VS Code's own port forwarding (which
 * travels inside the tunnel you are already using, from anywhere) joins them:
 *
 *   Claude Code ─hook.sh─▶ relay 127.0.0.1:43118 on the remote
 *                              ▲ VS Code forwards 43118 to your computer
 *   Clippy ── long-polls ──────┘ GET /next, POST /answer/<id>
 *
 * Interactive hooks (permission, question) are held open here until Clippy
 * answers or gives up; everything else is acknowledged at once and queued, so
 * no ordinary tool call waits on a round trip through the tunnel. When Clippy
 * isn't connected, the relay answers "no decision" immediately and Claude
 * Code shows its normal prompt.
 *
 * Every request must carry the key written to ~/.clippy-relay/key at setup,
 * which only this user can read: other accounts or containers on the remote
 * machine can't inject events or answer prompts. Requests that look like they
 * come from a web page are refused outright.
 *
 * Commands:
 *   node clippy-relay.js serve             run the relay (hook.sh starts it on demand)
 *   node clippy-relay.js post <url> <secs> POST stdin to the relay (used if curl is missing)
 *   node clippy-relay.js vscode-settings   label the port in VS Code's Ports panel
 *
 * It stops by itself after IDLE_EXIT_MS without a hook, so it only runs while
 * you are actually using Claude on this machine.
 *
 * Plain Node, no dependencies: it runs on the Node that VS Code's server
 * already installed on the remote machine.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = process.env.CLIPPY_RELAY_DIR || path.join(os.homedir(), '.clippy-relay');
const PORT = Number(process.env.CLIPPY_RELAY_PORT) || 43118;
const VERSION = 1;

const MAX_BODY = 1024 * 1024;
const HOLD_MAX_MS = 110_000; // under hook.sh's curl -m 115 and the hook's 120 s
const PRESENT_MS = 15_000; // a Clippy that polled this recently is "connected"
const EVENT_TTL_MS = 30_000; // passive events nobody collected in time are dropped
const MAX_QUEUE = 500;
const IDLE_EXIT_MS = 30 * 60_000;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Same rule as Clippy's own server: no Origin header, and a loopback Host. */
function fromLoopbackClient(req) {
  if (req.headers.origin) return false;
  const host = String(req.headers.host || '');
  if (!host) return true;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host);
  // Any port: VS Code may forward the relay to a different local port.
  return Boolean(m) && LOOPBACK.has(m[1].toLowerCase());
}

function sameKey(given, key) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(key || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/** The X-Clippy-* headers a hook sent (lower-cased by Node), minus the key. */
function forwardedHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith('x-clippy-') && k !== 'x-clippy-relay-key') out[k] = String(v);
  }
  return out;
}

function readBody(req, res, done) {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) tooBig = true;
    else chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) {
      res.writeHead(413).end();
      return;
    }
    done(Buffer.concat(chunks).toString('utf8'));
  });
}

/**
 * The relay itself, separate from `serve` so tests can drive it.
 *
 * @param {object} opts
 * @param {string} opts.key
 * @param {() => number} [opts.now]
 * @param {number} [opts.holdMaxMs]
 * @param {number} [opts.presentMs]
 * @param {number} [opts.eventTtlMs]
 */
function createRelay({
  key,
  now = Date.now,
  holdMaxMs = HOLD_MAX_MS,
  presentMs = PRESENT_MS,
  eventTtlMs = EVENT_TTL_MS,
} = {}) {
  if (!key) throw new Error('the relay needs a key');
  let queue = [];
  const held = new Map(); // id -> { res, timer }
  const waiters = new Set(); // { res, timer }
  let lastPollAt = -Infinity;
  let lastHookAt = now();
  let seq = 0;

  const present = () => waiters.size > 0 || now() - lastPollAt < presentMs;

  function flush() {
    if (!queue.length || !waiters.size) return;
    const events = queue;
    queue = [];
    const [waiter] = waiters; // one poller at a time is the normal case
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    lastPollAt = now();
    waiter.res.writeHead(200, { 'Content-Type': 'application/json' });
    waiter.res.end(JSON.stringify({ events }));
  }

  function enqueue(item) {
    queue.push(item);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    flush();
  }

  /** Answer a held hook (once) and forget it. */
  function release(id, reply) {
    const h = held.get(id);
    if (!h) return false;
    held.delete(id);
    clearTimeout(h.timer);
    if (!h.res.writableEnded && !h.res.destroyed) {
      if (reply && typeof reply === 'object') {
        h.res.writeHead(200, { 'Content-Type': 'application/json' });
        h.res.end(JSON.stringify(reply));
      } else {
        h.res.writeHead(204).end();
      }
    }
    return true;
  }

  function onHook(req, res, url) {
    lastHookAt = now();
    const event = url.pathname.slice('/hook/'.length);
    const hold = url.searchParams.get('hold') === '1';
    url.searchParams.delete('hold');
    readBody(req, res, (body) => {
      // Nobody to show it to: answer "no decision" so the normal prompt
      // appears straight away, and don't let it pile up.
      if (!present()) {
        res.writeHead(204).end();
        return;
      }
      const id = `r${++seq}`;
      const item = {
        id,
        at: now(),
        event,
        query: url.searchParams.toString(),
        headers: forwardedHeaders(req.headers),
        body,
        hold,
      };
      if (!hold) {
        res.writeHead(204).end();
        enqueue(item);
        return;
      }
      const timer = setTimeout(() => {
        if (release(id, null)) enqueue({ id: `${id}c`, at: now(), closed: id });
      }, holdMaxMs);
      timer.unref?.();
      held.set(id, { res, timer });
      // Claude Code (or curl's own timeout) gave up on this hook: tell Clippy
      // so the card goes away instead of answering into nothing.
      res.on('close', () => {
        if (held.has(id) && !res.writableEnded) {
          held.delete(id);
          clearTimeout(timer);
          enqueue({ id: `${id}c`, at: now(), closed: id });
        }
      });
      enqueue(item);
    });
  }

  function onNext(req, res, url) {
    lastPollAt = now();
    // Passive events older than the TTL are stale news; held ones are still
    // waiting for an answer and always go through.
    queue = queue.filter((e) => e.hold || e.closed || now() - e.at < eventTtlMs);
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 30_000);
    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      lastPollAt = now();
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"events":[]}');
      }
    }, wait);
    waiter.timer.unref?.();
    res.on('close', () => {
      if (waiters.delete(waiter)) {
        clearTimeout(waiter.timer);
        lastPollAt = now();
      }
    });
    waiters.add(waiter);
    flush();
  }

  function onAnswer(req, res, url) {
    const id = url.pathname.slice('/answer/'.length);
    readBody(req, res, (body) => {
      let reply = null;
      try {
        reply = body ? JSON.parse(body) : null;
      } catch {
        reply = null;
      }
      const ok = release(id, reply);
      res.writeHead(ok ? 204 : 404).end();
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!fromLoopbackClient(req) || !sameKey(req.headers['x-clippy-relay-key'], key)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"forbidden"}');
      return;
    }
    if (req.method === 'POST' && /^\/hook\/[A-Za-z]+$/.test(url.pathname)) return onHook(req, res, url);
    if (req.method === 'GET' && url.pathname === '/next') return onNext(req, res, url);
    if (req.method === 'POST' && /^\/answer\/[A-Za-z0-9]+$/.test(url.pathname)) return onAnswer(req, res, url);
    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          relay: 'clippy',
          version: VERSION,
          host: os.hostname(),
          connected: present(),
          queued: queue.length,
          held: held.size,
        })
      );
      return;
    }
    res.writeHead(404).end();
  });

  /**
   * Clippy went away (laptop closed, VS Code disconnected) with prompts still
   * held: hand them back now rather than at the end of the hold, so the
   * normal prompt appears in seconds instead of two minutes.
   */
  function sweep() {
    if (present()) return 0;
    let n = 0;
    for (const id of [...held.keys()]) if (release(id, null)) n++;
    return n;
  }

  return {
    server,
    sweep,
    idleFor: () => now() - lastHookAt,
    busy: () => held.size > 0,
    present,
  };
}

/* ---------------- Commands ---------------- */

function readKey() {
  return fs.readFileSync(path.join(DIR, 'key'), 'utf8').trim();
}

function serve() {
  const relay = createRelay({ key: readKey() });
  relay.server.on('error', (err) => {
    // Another relay already has the port: that one is doing the job.
    if (err.code === 'EADDRINUSE') process.exit(0);
    console.error('clippy relay:', err.message);
    process.exit(1);
  });
  relay.server.listen(PORT, '127.0.0.1', () => {
    console.log(`${new Date().toISOString()} clippy relay listening on 127.0.0.1:${PORT}`);
  });
  setInterval(() => relay.sweep(), 2000).unref?.();
  setInterval(() => {
    if (relay.idleFor() > IDLE_EXIT_MS && !relay.busy()) {
      console.log(`${new Date().toISOString()} clippy relay idle — exiting`);
      process.exit(0);
    }
  }, 60_000).unref?.();
}

/** `post <url> <secs>`: hook.sh's fallback when the machine has no curl. */
function post(url, secs) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const headers = { 'Content-Type': 'application/json' };
    for (const [env, header] of [
      ['CLIPPY_H_KEY', 'X-Clippy-Relay-Key'],
      ['CLIPPY_H_ENTRY', 'X-Clippy-Entrypoint'],
      ['CLIPPY_H_TERM', 'X-Clippy-Term'],
      ['CLIPPY_H_REMOTE', 'X-Clippy-Remote'],
    ]) {
      if (process.env[env]) headers[header] = process.env[env];
    }
    headers['X-Clippy-Hook'] = '#clippy';
    const req = http.request(url, { method: 'POST', headers, timeout: Number(secs) * 1000 }, (res) => {
      res.pipe(process.stdout);
      res.on('end', () => process.exit(0));
    });
    // Exit code 7 is what curl says for "connection refused": hook.sh starts
    // the relay on it.
    req.on('error', (err) => process.exit(err.code === 'ECONNREFUSED' ? 7 : 0));
    req.on('timeout', () => {
      req.destroy();
      process.exit(0);
    });
    req.end(Buffer.concat(chunks));
  });
}

/**
 * Give the forwarded port a name in VS Code's Ports panel and skip the "your
 * application is running" toast. Written to the remote machine's own VS Code
 * settings; left alone if that file has comments we would lose.
 */
function vscodeSettings(home = os.homedir()) {
  const file = path.join(home, '.vscode-server', 'data', 'Machine', 'settings.json');
  let settings = {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    settings = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.log(`  (left ${file} alone: ${err.message})`);
      return false;
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const attrs = (settings['remote.portsAttributes'] ||= {});
  attrs[String(PORT)] = { label: 'Clippy relay', onAutoForward: 'silent' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  labelled port ${PORT} "Clippy relay" in ${file}`);
  return true;
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'serve') serve();
  else if (cmd === 'post') post(args[0], args[1] || '3');
  else if (cmd === 'vscode-settings') vscodeSettings();
  else {
    console.log('usage: clippy-relay.js <serve|post <url> <secs>|vscode-settings>');
    process.exit(cmd ? 1 : 0);
  }
}

module.exports = { createRelay, fromLoopbackClient, sameKey, forwardedHeaders, vscodeSettings, PORT };
