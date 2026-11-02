'use strict';

/**
 * Usage numbers for sessions on this (remote) machine.
 *
 * Clippy's stats panel reads Claude Code's own files: the session's transcript
 * for how full its context is, and ~/.claude.json for the 5-hour and weekly
 * allowance. For a session on a remote machine those files are here, not on
 * the computer Clippy runs on — so this reads them here, with the very same
 * code Clippy uses (a copy of src/usage.js is packaged in lib/), and sends the
 * result along as a `ClippyUsage` event after the session's own events.
 *
 * Cheap by design: one send per session at most every couple of seconds; the
 * allowance file is re-read at most every 30 s, and the slow sweep of every
 * recent transcript (only needed when Claude Code has never cached /usage)
 * at most every 5 minutes.
 */

const os = require('node:os');
const path = require('node:path');

function createUsagePusher({
  usage,
  deliver,
  host = os.hostname(),
  projectsDir = path.join(os.homedir(), '.claude', 'projects'),
  claudeJson = path.join(os.homedir(), '.claude.json'),
  now = Date.now,
  debounceMs = 2000,
  officialEveryMs = 30_000,
  windowsEveryMs = 5 * 60_000,
  log = () => {},
}) {
  const timers = new Map(); // session id -> timer
  let official = { at: -Infinity, value: null };
  let windows = { at: -Infinity, value: null };
  let seq = 0;

  async function account() {
    if (now() - official.at > officialEveryMs) {
      official = { at: now(), value: await usage.readOfficialUsage(claudeJson).catch(() => null) };
    }
    if (!official.value && now() - windows.at > windowsEveryMs) {
      windows = { at: now(), value: await usage.usageWindows(projectsDir, now()).catch(() => null) };
    }
    return { official: official.value, windows: official.value ? null : windows.value };
  }

  async function push(sessionId, transcriptPath) {
    const [session, recap, acct] = await Promise.all([
      usage.sessionUsage(transcriptPath).catch(() => null),
      usage.lastAssistantText(transcriptPath, { maxChars: 200 }).catch(() => ''),
      account(),
    ]);
    const body = { session_id: sessionId, session, recap, ...acct, host, at: now() };
    return deliver({
      id: `usage-${++seq}`,
      event: 'ClippyUsage',
      query: 'source=claude',
      headers: { 'x-clippy-hook': '#clippy', 'x-clippy-remote': host },
      body: JSON.stringify(body),
    });
  }

  /** A hook event went by: refresh that session's numbers shortly after. */
  function note(ev) {
    if (!ev || ev.event === 'ClippyUsage') return;
    let payload;
    try {
      payload = JSON.parse(ev.body || '{}');
    } catch {
      return;
    }
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
    const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    if (!sessionId || !transcriptPath) return;
    clearTimeout(timers.get(sessionId));
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      push(sessionId, transcriptPath).catch((err) => log(`usage not sent: ${err.message}`));
    }, debounceMs);
    timer.unref?.();
    timers.set(sessionId, timer);
  }

  function stop() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return { note, push, stop };
}

module.exports = { createUsagePusher };
