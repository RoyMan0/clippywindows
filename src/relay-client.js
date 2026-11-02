'use strict';

/**
 * Clippy's end of the remote relay (see relay/clippy-relay.js).
 *
 * VS Code forwards the relay's port from the remote machine to this one, so
 * from here it is just another loopback address. This long-polls it for hook
 * events, hands each one to the same handler the local hook server uses, and
 * posts the answer back for the interactive ones. To the rest of the app a
 * relayed session looks exactly like a local one.
 */

const WAIT_MS = 25_000;
const RETRY_MS = 5_000;

/** `kind=idle_prompt&source=claude` → { kind, source } */
function parseQuery(query) {
  const params = new URLSearchParams(String(query || ''));
  return { kind: params.get('kind'), source: params.get('source') || 'claude' };
}

class RelayClient {
  /**
   * @param {object} opts
   * @param {() => {port:number, key:string}|null} opts.config  read on every poll, so settings changes apply
   * @param {(event:string, kind:string|null, payload:object, ctx:object) => any} opts.onEvent
   * @param {(connected:boolean) => void} [opts.onStatus]
   */
  constructor({ config, onEvent, onStatus = () => {}, fetchImpl = globalThis.fetch, log = console.warn, retryMs = RETRY_MS, waitMs = WAIT_MS }) {
    this.config = config;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.fetch = fetchImpl;
    this.log = log;
    this.retryMs = retryMs;
    this.waitMs = waitMs;
    this.running = false;
    this.connected = false;
    this.closers = new Map(); // relay id -> [fn]
    this.abort = null;
    this.lastError = '';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.abort?.abort();
    this.setConnected(false);
  }

  setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    try {
      this.onStatus(value);
    } catch {}
  }

  async loop() {
    while (this.running) {
      const cfg = this.config();
      if (!cfg || !cfg.key) {
        this.setConnected(false);
        await this.sleep(this.retryMs);
        continue;
      }
      try {
        this.abort = new AbortController();
        const timer = setTimeout(() => this.abort.abort(), this.waitMs + 10_000);
        timer.unref?.();
        const res = await this.fetch(`http://127.0.0.1:${cfg.port}/next?wait=${this.waitMs}`, {
          headers: { 'X-Clippy-Relay-Key': cfg.key },
          signal: this.abort.signal,
        });
        clearTimeout(timer);
        if (res.status === 403) throw new Error('the relay refused our key — run the setup command again');
        if (!res.ok) throw new Error(`relay answered ${res.status}`);
        const body = await res.json();
        this.setConnected(true);
        this.lastError = '';
        for (const ev of Array.isArray(body?.events) ? body.events : []) this.dispatch(ev, cfg);
      } catch (err) {
        if (!this.running) return;
        this.setConnected(false);
        // Not connected is the normal state whenever VS Code isn't: say so once.
        if (err.message !== this.lastError) {
          this.lastError = err.message;
          if (!/ECONNREFUSED|fetch failed|aborted/i.test(err.message)) this.log('clippy: relay:', err.message);
        }
        await this.sleep(this.retryMs);
      }
    }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  dispatch(ev, cfg) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.closed) {
      const fns = this.closers.get(ev.closed) || [];
      this.closers.delete(ev.closed);
      for (const fn of fns) {
        try {
          fn();
        } catch {}
      }
      return;
    }
    if (!/^[A-Za-z]+$/.test(String(ev.event || ''))) return;
    const { kind, source } = parseQuery(ev.query);
    let payload = {};
    try {
      payload = ev.body ? JSON.parse(ev.body) : {};
    } catch {
      // the same leniency as the local server
    }
    const headers = { ...(ev.headers || {}), 'x-clippy-hook': ev.headers?.['x-clippy-hook'] || '#clippy' };
    if (ev.hold) this.closers.set(ev.id, []);
    const ctx = {
      onClose: (fn) => this.closers.get(ev.id)?.push(fn),
      headers,
      source,
      remote: headers['x-clippy-remote'] || 'remote',
    };
    let result;
    try {
      result = this.onEvent(ev.event, kind, payload, ctx);
    } catch (err) {
      this.log('clippy: error handling relayed event', ev.event, err);
    }
    if (!ev.hold) return;
    Promise.resolve(result)
      .catch(() => undefined)
      .then((reply) => {
        this.closers.delete(ev.id);
        return this.fetch(`http://127.0.0.1:${cfg.port}/answer/${encodeURIComponent(ev.id)}`, {
          method: 'POST',
          headers: { 'X-Clippy-Relay-Key': cfg.key, 'Content-Type': 'application/json' },
          body: reply && typeof reply === 'object' ? JSON.stringify(reply) : '',
        });
      })
      .catch((err) => this.log('clippy: could not answer through the relay:', err.message));
  }
}

module.exports = { RelayClient, parseQuery };
