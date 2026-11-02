'use strict';

/**
 * The local half of the Clippy bridge, without VS Code in it.
 *
 * Runs in VS Code's extension host on *your* computer. The remote half calls
 * the `clippyBridge.deliver` command with each hook event; this posts it to
 * Clippy's ordinary hook server on 127.0.0.1 and returns Clippy's answer.
 * `cancel` drops a held request, which Clippy sees as the hook giving up.
 */

const http = require('node:http');

const TIMEOUT_MS = 118_000;

function createDeliverer({ port = 43117, request = http.request, timeoutMs = TIMEOUT_MS } = {}) {
  const inflight = new Map();

  function deliver(ev) {
    return new Promise((resolve, reject) => {
      if (!ev || !/^[A-Za-z]+$/.test(String(ev.event || ''))) {
        reject(new Error('not a hook event'));
        return;
      }
      const headers = { 'Content-Type': 'application/json' };
      for (const [k, v] of Object.entries(ev.headers || {})) {
        if (/^x-clippy-[a-z-]+$/.test(k)) headers[k] = String(v);
      }
      const query = String(ev.query || '');
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/hook/${ev.event}${query ? `?${query}` : ''}`,
          headers,
          // The rewake wait is held for up to half an hour, by design.
          timeout: Number(ev.waitMs) > 0 ? Math.min(Number(ev.waitMs), 1_800_000) : timeoutMs,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            inflight.delete(ev.id);
            resolve({ status: res.statusCode, body });
          });
        }
      );
      inflight.set(ev.id, req);
      req.on('timeout', () => req.destroy(new Error('Clippy did not answer in time')));
      req.on('error', (err) => {
        inflight.delete(ev.id);
        reject(err);
      });
      req.end(String(ev.body || ''));
    });
  }

  function cancel(id) {
    const req = inflight.get(id);
    inflight.delete(id);
    if (req) req.destroy();
    return Boolean(req);
  }

  /** Is Clippy answering on this computer? */
  function ping() {
    return new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/status', timeout: 2000 }, (res) => {
        res.resume();
        resolve({ clippy: res.statusCode === 200 });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve({ clippy: false }));
      req.end();
    });
  }

  return { deliver, cancel, ping };
}

module.exports = { createDeliverer };
