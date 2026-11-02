'use strict';

/**
 * The remote half of the Clippy bridge, without VS Code in it (so it can be
 * tested on its own).
 *
 * Runs in the VS Code extension host on the *remote* machine. Claude Code's
 * hooks there (~/.clippy-relay/hook.sh) POST to 127.0.0.1:43118; each event is
 * handed to the local half of the bridge — a command running on your own
 * computer, reached over VS Code's existing connection — which passes it to
 * Clippy. Nothing is port-forwarded and nothing listens on the network.
 *
 * Interactive hooks (?hold=1) wait for Clippy's answer; everything else is
 * acknowledged at once and delivered in the background. If the local half
 * isn't installed or Clippy isn't running, the hook gets "no decision" and
 * Claude Code shows its normal prompt.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY = 1024 * 1024;
const HOLD_MAX_MS = 115_000; // under the hook's 120 s
const REWAKE_MAX_MS = 1_785_000; // under the rewake hook's 30 minutes
const NOTE_TTL_MS = 10 * 60_000;
const AFTER_TOOL = new Set(['PostToolUse', 'PostToolUseFailure']);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** No Origin header (web pages always send one) and a loopback Host. */
function fromLoopbackClient(req) {
  if (req.headers.origin) return false;
  const host = String(req.headers.host || '');
  if (!host) return true;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host);
  return Boolean(m) && LOOPBACK.has(m[1].toLowerCase());
}

function sameKey(given, key) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(key || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/** The X-Clippy-* headers a hook sent, minus the key. */
function forwardedHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.startsWith('x-clippy-') && k !== 'x-clippy-relay-key') out[k] = String(v);
  }
  return out;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} opts
 * @param {string} opts.key                       ~/.clippy-relay/key
 * @param {(ev:object) => Promise<{status:number, body:string}|null>} opts.deliver
 * @param {(id:string) => any} [opts.cancel]      the hook gave up on a held event
 * @param {(msg:string) => void} [opts.log]
 * @param {string} [opts.host]                     this machine's name, shown in Clippy
 */
function createBridgeServer({ key, deliver, cancel = () => {}, log = () => {}, host = '', holdMaxMs = HOLD_MAX_MS }) {
  if (!key) throw new Error('the bridge needs a key');
  let seq = 0;
  const prefix = crypto.randomBytes(4).toString('hex');
  // Notes typed on an approval card. Claude Code's "allow" can't carry words,
  // so Clippy hands them back beside its answer (`clippyNote`, stripped here
  // before the hook sees it) and they ride along with the tool's result, on
  // that session's next PostToolUse.
  const notes = new Map(); // session id -> { text, at }
  const stats = { delivered: 0, failed: 0, lastError: '' };

  return Object.assign(
    http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!fromLoopbackClient(req) || !sameKey(req.headers['x-clippy-relay-key'], key)) {
        res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"forbidden"}');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bridge: 'clippy', host, ...stats }));
        return;
      }
      const match = req.method === 'POST' && /^\/hook\/([A-Za-z]+)$/.exec(url.pathname);
      if (!match) {
        res.writeHead(404).end();
        return;
      }
      const hold = url.searchParams.get('hold') === '1';
      const rewake = url.searchParams.get('rewake') === '1';
      url.searchParams.delete('hold');
      url.searchParams.delete('rewake');

      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
      });
      req.on('end', () => {
        if (size > MAX_BODY) {
          res.writeHead(413).end();
          return;
        }
        const ev = {
          id: `${prefix}-${++seq}`,
          event: match[1],
          query: url.searchParams.toString(),
          headers: { ...forwardedHeaders(req.headers), 'x-clippy-hook': '#clippy', 'x-clippy-remote': host },
          body: Buffer.concat(chunks).toString('utf8'),
          ...(rewake ? { waitMs: REWAKE_MAX_MS + 5000 } : {}),
        };
        let sessionId = '';
        try {
          sessionId = String(JSON.parse(ev.body || '{}').session_id || '');
        } catch {}
        const sent = Promise.resolve()
          .then(() => deliver(ev))
          .then(
            (reply) => {
              stats.delivered++;
              return reply;
            },
            (err) => {
              stats.failed++;
              stats.lastError = String(err?.message || err);
              log(`could not reach Clippy on this computer: ${stats.lastError}`);
              return null;
            }
          );

        if (!hold) {
          const note = AFTER_TOOL.has(ev.event) && notes.get(sessionId);
          if (note) {
            notes.delete(sessionId);
            if (Date.now() - note.at < NOTE_TTL_MS) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(noteOutput(ev.event, note.text)));
              return;
            }
          }
          res.writeHead(204).end();
          return;
        }
        let answered = false;
        res.on('close', () => {
          if (!answered) {
            try {
              Promise.resolve(cancel(ev.id)).catch(() => {});
            } catch {}
          }
        });
        withTimeout(sent, rewake ? REWAKE_MAX_MS : holdMaxMs).then((reply) => {
          answered = true;
          if (res.writableEnded || res.destroyed) return;
          let body = reply && reply.status === 200 ? String(reply.body || '').trim() : '';
          let parsed = null;
          try {
            parsed = body.startsWith('{') ? JSON.parse(body) : null;
          } catch {}
          if (rewake) {
            // hook.sh prints this on stderr and exits 2: Claude wakes up to it.
            const text = parsed && typeof parsed.clippyRewake === 'string' ? parsed.clippyRewake.trim() : '';
            if (text) res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
            else res.writeHead(204).end();
            return;
          }
          if (parsed && typeof parsed.clippyNote === 'string') {
            if (sessionId && parsed.clippyNote.trim()) notes.set(sessionId, { text: parsed.clippyNote.trim(), at: Date.now() });
            delete parsed.clippyNote;
            body = JSON.stringify(parsed);
          }
          if (body.startsWith('{')) {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
          } else {
            res.writeHead(204).end();
          }
        });
      });
    }),
    { stats }
  );
}

/** What a PostToolUse hook answers to put the user's note beside the result. */
function noteOutput(event, text) {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: `When approving this tool call, the user added (via Clippy): ${text}`,
    },
  };
}

module.exports = { noteOutput, createBridgeServer, fromLoopbackClient, sameKey, forwardedHeaders, HOLD_MAX_MS };
