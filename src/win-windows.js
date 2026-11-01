'use strict';

/**
 * Finding, raising and measuring a session's window on Windows.
 *
 * The Mac build asks AppleScript and the process table. Windows has neither,
 * and the http hooks it uses carry no tty and no parent pid either — so a
 * window is found the way a person would find it: by the app it belongs to
 * and by its title, which in VS Code (and Cursor) names the open folder.
 *
 * The Win32 calls live in one long-running PowerShell process. Starting
 * PowerShell costs the better part of a second, and a perched buddy asks where
 * its window is every 700 ms, so the helper is started once, on first use, and
 * fed one command per line on stdin:
 *
 *     <id> list                → [{hwnd, pid, proc, title}]
 *     <id> bounds <hwnd>       → {x, y, width, height} | null (gone or minimised)
 *     <id> raise <hwnd>        → {raised, bounds}
 *     <id> front               → {hwnd, pid, proc, title} | null
 *     <id> type <base64>       → {ok}   (SendKeys syntax, already escaped)
 *
 * and answers `<id> <json>` on one line. Everything the decision needs — which
 * window is the session's, how to escape a keystroke — is plain JavaScript
 * below, so it is tested without Windows.
 *
 * Coordinates come back in physical pixels (the helper is per-monitor DPI
 * aware); the caller converts them to Electron's DIPs.
 */

const { spawn } = require('node:child_process');

const CALL_TIMEOUT_MS = 4000;
// Compiling the C# below is the slow part of the first call.
const FIRST_CALL_TIMEOUT_MS = 15000;

/** Process names (no .exe, lower case) that host each kind of session. */
const EDITOR_PROCESSES = ['code', 'code - insiders', 'cursor', 'windsurf', 'vscodium'];
const TERMINAL_PROCESSES = [
  'windowsterminal',
  'wezterm-gui',
  'alacritty',
  'conhost',
  'openconsole',
  'powershell',
  'pwsh',
  'cmd',
  'mintty',
  'tabby',
  'hyper',
];

const HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class ClippyWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

  static string Str(string s) {
    if (s == null) return "null";
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < 0x20) b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static string Title(IntPtr h) {
    int n = GetWindowTextLength(h);
    if (n <= 0) return "";
    var s = new StringBuilder(n + 1);
    GetWindowText(h, s, s.Capacity);
    return s.ToString();
  }

  static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }

  static string Proc(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  // A window on another virtual desktop, or a suspended UWP shell, is
  // "visible" but cloaked: there is nothing on screen to point at.
  static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }

  static string Describe(IntPtr h) {
    uint pid = Pid(h);
    return "{\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"proc\":" + Str(Proc(pid)) + ",\"title\":" + Str(Title(h)) + "}";
  }

  static string List() {
    var parts = new List<string>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && !Cloaked(h) && GetWindowTextLength(h) > 0)
        parts.Add(Describe(h));
      return true;
    }, IntPtr.Zero);
    return "[" + string.Join(",", parts) + "]";
  }

  static string Bounds(IntPtr h) {
    if (!IsWindow(h) || !IsWindowVisible(h) || IsIconic(h) || Cloaked(h)) return "null";
    RECT r;
    // The frame the user sees, without Windows 10/11's invisible resize border.
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(h, out r)) return "null";
    return "{\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"width\":" + (r.Right - r.Left) + ",\"height\":" + (r.Bottom - r.Top) + "}";
  }

  static string Raise(IntPtr h) {
    if (!IsWindow(h)) return "{\"raised\":false,\"bounds\":null}";
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    // Windows only lets the process that has the user's input take focus. We
    // don't — Clippy does, and this helper is its child — so borrow the input
    // queue of whoever is in front for the length of the call.
    IntPtr front = GetForegroundWindow();
    uint ignored;
    uint frontThread = GetWindowThreadProcessId(front, out ignored);
    uint me = GetCurrentThreadId();
    bool attached = frontThread != 0 && frontThread != me && AttachThreadInput(me, frontThread, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, frontThread, false);
    if (GetForegroundWindow() != h) SwitchToThisWindow(h, true);
    bool raised = GetForegroundWindow() == h;
    return "{\"raised\":" + (raised ? "true" : "false") + ",\"bounds\":" + Bounds(h) + "}";
  }

  static string Front() {
    IntPtr h = GetForegroundWindow();
    return h == IntPtr.Zero ? "null" : Describe(h);
  }

  static string TypeKeys(string base64) {
    string keys = Encoding.UTF8.GetString(Convert.FromBase64String(base64));
    System.Windows.Forms.SendKeys.SendWait(keys);
    return "{\"ok\":true}";
  }

  static string Run(string cmd, string arg) {
    switch (cmd) {
      case "list": return List();
      case "bounds": return Bounds(new IntPtr(long.Parse(arg)));
      case "raise": return Raise(new IntPtr(long.Parse(arg)));
      case "front": return Front();
      case "type": return TypeKeys(arg);
      case "ping": return "{\"ok\":true}";
      default: return "{\"error\":" + Str("unknown command " + cmd) + "}";
    }
  }

  public static void Serve() {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } // per-monitor v2 (Windows 10 1703+)
    var input = Console.In;
    string line;
    while ((line = input.ReadLine()) != null) {
      line = line.Trim();
      if (line.Length == 0) continue;
      string[] p = line.Split(new[] { ' ' }, 3);
      string id = p[0];
      string reply;
      try { reply = Run(p.Length > 1 ? p[1] : "", p.Length > 2 ? p[2] : ""); }
      catch (Exception e) { reply = "{\"error\":" + Str(e.Message) + "}"; }
      Console.Out.WriteLine(id + " " + reply);
      Console.Out.Flush();
    }
  }
}
`;

/** The PowerShell that compiles the helper and hands it stdin. */
function helperScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::InputEncoding = [Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$src = @'\n${HELPER_SOURCE}\n'@`,
    'Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms',
    '[ClippyWin]::Serve()',
  ].join('\n');
}

/** `-EncodedCommand` wants UTF-16LE base64: no quoting to get wrong. */
function encodedCommand(script = helperScript()) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/* ---------------- Pure decisions ---------------- */

const lower = (s) => String(s || '').toLowerCase();

/** Which processes could be hosting this session, from what its hook said. */
function hostProcessesFor(term = {}) {
  if (term.program === 'vscode') return EDITOR_PROCESSES;
  if (term.program === 'Windows Terminal') return ['windowsterminal', 'openconsole'];
  return [...EDITOR_PROCESSES, ...TERMINAL_PROCESSES];
}

/**
 * Pick this session's window out of every top-level window on screen.
 *
 * In order of confidence:
 *  1. the editor's own pid (VSCODE_PID, when the extension's environment had
 *     it) and the project folder in the title;
 *  2. the right kind of app with the folder in the title — VS Code titles a
 *     window "file — folder — Visual Studio Code";
 *  3. that pid alone, when the editor has exactly one window;
 *  4. the only window of the right kind on screen.
 * Anything vaguer is a guess, and a guess raises the wrong window: null.
 *
 * @param {Array<{hwnd:number,pid:number,proc:string,title:string}>} windows
 * @param {{program?:string, hostPid?:number}} term
 * @param {string} hint  the project folder's name
 */
function pickWindow(windows, term = {}, hint = '') {
  const list = Array.isArray(windows) ? windows : [];
  const hostPid = Number(term.hostPid) || 0;
  const procs = hostProcessesFor(term);
  const want = lower(hint).trim();
  const titled = (w) => want && titleNames(w.title, want);
  const ofKind = list.filter((w) => procs.includes(lower(w.proc)));
  const byPid = hostPid ? list.filter((w) => Number(w.pid) === hostPid) : [];

  const pick =
    byPid.find(titled) ||
    ofKind.find(titled) ||
    (byPid.length === 1 ? byPid[0] : null) ||
    (ofKind.length === 1 ? ofKind[0] : null);
  return pick || null;
}

/**
 * Does a window title name this folder? As a whole segment, not a substring:
 * "app" must not match "my-app — Visual Studio Code".
 */
function titleNames(title, folder) {
  const want = lower(folder).trim();
  if (!want) return false;
  return lower(title)
    .split(/\s+[—–-]\s+|\s*\|\s*|[\\/:]/)
    .map((part) => part.replace(/^[●•*]\s*/, '').trim())
    .some((part) => part === want || part === `${want} [wsl]` || part.startsWith(`${want} [`));
}

/**
 * Text as SendKeys keystrokes. `+ ^ % ~ ( ) { } [ ]` are its syntax, so each
 * is wrapped in braces to be typed literally; newlines are flattened because
 * Return submits a CLI prompt; `{ENTER}` goes last to send it.
 */
function sendKeysText(text) {
  const oneLine = String(text).replace(/\s*\r?\n+\s*/g, ' ').trim();
  return oneLine.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`) + '{ENTER}';
}

/* ---------------- The helper process ---------------- */

/**
 * One PowerShell helper, started on first use and restarted if it dies.
 * Calls are answered strictly by id, so a slow one never gets another's reply.
 */
class WinWindows {
  constructor({ spawnImpl = spawn, platform = process.platform, log = console.warn } = {}) {
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.log = log;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.ready = false;
  }

  start() {
    if (this.child) return this.child;
    const child = this.spawnImpl(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand()],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    this.child = child;
    this.ready = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.log('clippy: window helper:', String(chunk).trim()));
    const gone = (why) => {
      if (this.child !== child) return;
      this.child = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`window helper ${why}`));
      }
      this.pending.clear();
    };
    child.on('error', (err) => gone(`could not start: ${err.message}`));
    child.on('exit', (code) => gone(`exited (${code})`));
    child.stdin.on('error', () => {}); // a write racing the exit; 'exit' reports it
    return child;
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      const space = line.indexOf(' ');
      if (space === -1) continue;
      const waiting = this.pending.get(line.slice(0, space));
      if (!waiting) continue; // a call that already timed out
      this.pending.delete(line.slice(0, space));
      clearTimeout(waiting.timer);
      this.ready = true;
      let value;
      try {
        value = JSON.parse(line.slice(space + 1));
      } catch (err) {
        waiting.reject(new Error(`window helper sent nonsense: ${err.message}`));
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && value.error) {
        waiting.reject(new Error(String(value.error)));
      } else {
        waiting.resolve(value);
      }
    }
  }

  call(cmd, arg = '') {
    if (this.platform !== 'win32') return Promise.reject(new Error('the window helper is Windows-only'));
    const child = this.start();
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timeout = this.ready ? CALL_TIMEOUT_MS : FIRST_CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`window helper did not answer "${cmd}"`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${id} ${cmd}${arg === '' ? '' : ` ${arg}`}\n`);
    });
  }

  list() {
    return this.call('list').then((v) => (Array.isArray(v) ? v : []));
  }

  bounds(hwnd) {
    return this.call('bounds', String(Number(hwnd)));
  }

  raise(hwnd) {
    return this.call('raise', String(Number(hwnd)));
  }

  front() {
    return this.call('front');
  }

  type(text) {
    return this.call('type', Buffer.from(sendKeysText(text), 'utf8').toString('base64'));
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin.end();
        child.kill();
      } catch {}
    }
  }
}

let shared = null;
/** The one helper the app uses. */
function winWindows() {
  shared ||= new WinWindows();
  return shared;
}

module.exports = {
  WinWindows,
  winWindows,
  pickWindow,
  titleNames,
  hostProcessesFor,
  sendKeysText,
  helperScript,
  encodedCommand,
  EDITOR_PROCESSES,
  TERMINAL_PROCESSES,
};
