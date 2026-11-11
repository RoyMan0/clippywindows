# What this fork changed, and why

Every change this fork makes to [AI Socratic's Clippy](https://github.com/AISocratic/clippy),
grouped by what it fixed or added. Each entry gives the problem as it showed
up, the cause, the fix, and how it was checked. Base: upstream `main` at
`34a51f5`.

How to read "Checked": **tests** are automated tests in `test/` (run on Linux,
on GitHub's Mac runners — 569 tests, all passing on macOS — and the Windows
subset on GitHub's Windows runners); **app** means driven end to end in the real
Electron app; **you** means confirmed by hand on a real Windows PC or Mac.

---

## 1. Running on Windows

### The app couldn't be installed or run on Windows
- **Cause:** `package.json` declared `"os": ["darwin"]`, so `npm install`
  refused; the app assumed macOS tools (`osascript`, `lsappinfo`, `ps`,
  `tmux`, the DMG updater) throughout.
- **Fix:** Windows added to `os`. Mac-only features switched off on Windows
  with a plain explanation instead of a crash: auto-update (release feed is a
  Mac DMG), starting agents from Clippy (needs tmux), Codex hooks (untested).
  `app.setAppUserModelId` set so Windows notifications show at all.
- **Files:** `package.json`, `src/main.js`, `src/tmux.js`
- **Checked:** app launch on Linux as a non-Mac stand-in; you, on Windows.

### Hooks couldn't run reliably on Windows
- **Cause:** Clippy's hooks were `curl` shell lines using `$PPID`, `ps` and
  POSIX quoting. On Windows, Claude Code runs hook commands through Git Bash
  when installed, otherwise PowerShell — no single line works in both.
- **Fix:** on Windows Clippy installs Claude Code's own `http` hooks (a POST
  with no shell). They carry `TERM_PROGRAM`, `CLAUDE_CODE_ENTRYPOINT`,
  `VSCODE_PID` and `WT_SESSION` in headers (only those, via `allowedEnvVars`)
  so Clippy knows where the session lives. Acks to http hooks are an empty 204
  so Claude Code's schema check never sees `{"ok":true}`. Old/mismatched
  installs show "Hooks are out of date — update them now".
- **Files:** `bin/clippy-hooks.js`, `src/server.js`, `src/terminal.js`
- **Checked:** tests; app; you.

### No way to find or raise the session's window on Windows
- **Cause:** window finding used AppleScript and the macOS process table.
- **Fix:** `src/win-windows.js` — one long-lived PowerShell helper (compiled
  C#, Win32 calls) that lists, measures, raises and reports the foreground
  window, and types via SendKeys. The window is picked by app and by the
  project folder in the title (VS Code: "file - folder - Visual Studio Code"),
  never a vague guess. Coordinates are converted to Electron's DIPs, so
  perching works with display scaling. "Stay quiet when I'm already in that
  window" compares exact window handles. Typing is refused for VS Code (keys
  could land in an open file); allowed in Windows Terminal.
- **Files:** `src/win-windows.js`, `src/terminal.js`, `src/main.js`
- **Checked:** tests; a live helper smoke test on GitHub's Windows runner;
  you ("goes to the right session with multiple VS Code windows open").

### Windows installer
- **Fix:** `npm run package:win` builds an NSIS installer with electron-builder
  (dev dependency only), with an icon drawn from the same pixel art as the Mac
  icon. The *Windows installer* workflow builds it on every push. Unsigned, so
  SmartScreen warns on first run.
- **Files:** `scripts/package-win.js`, `.github/workflows/windows-installer.yml`
- **Checked:** CI; you.

### The window helper timed out on a slow first start
- **Cause:** compiling the PowerShell helper took longer than 15 s on one CI
  run; a slow PC could do the same on first launch.
- **Fix:** the first call may take 30 s; later calls keep 4 s.
- **Files:** `src/win-windows.js` · **Checked:** CI green again.

---

## 2. The VS Code extension, and remote machines (Remote Tunnel / SSH)

### Nothing happened for sessions in VS Code connected to a NAS
- **Symptom:** Clippy installed, hooks installed, `/hooks` in the extension
  showed none, `http://127.0.0.1:43117/status` showed no sessions.
- **Cause:** with a Remote Tunnel, the Claude Code extension runs **on the
  remote machine** and reads *that* machine's `~/.claude/settings.json`; and
  even with hooks there, `127.0.0.1` on the remote is the remote itself.
- **First attempt (replaced):** a relay process on the remote, reached through
  VS Code's port forwarding. It failed because Remote Tunnels forward ports as
  public `devtunnels.ms` web addresses, not to `localhost` — reachable only
  with a Microsoft/GitHub login, or by making the port public.
- **Fix:** two small VS Code extensions carry the events over VS Code's own
  connection, so nothing is forwarded or exposed:
  - **Clippy Bridge (remote)** runs in VS Code's extension host on the remote
    machine, listening on its loopback (`127.0.0.1:43118`) for the hooks.
  - **Clippy Bridge (local)** runs in VS Code on your computer and hands each
    event to Clippy's normal hook server. The remote half reaches it by
    calling a command, which VS Code routes across the connection.
  - `relay/install.sh` (one command on the remote) installs `hook.sh`, a
    private key (so other accounts/containers there can't talk to the bridge)
    and the hooks. With no VS Code window connected, hooks pass instantly.
- **Files:** `vscode/clippy-bridge-remote/`, `vscode/clippy-bridge-ui/`,
  `relay/hook.sh`, `relay/install.sh`, `bin/clippy-hooks.js` (`--style relay`)
- **Checked:** tests (the real `hook.sh` → both halves → Clippy's server);
  extensions loaded against a VS Code stand-in; you, over the tunnel.

### The stats panel showed nothing for remote sessions
- **Cause:** context used and the 5-hour/weekly allowance come from Claude
  Code's files (the transcript, `~/.claude.json`) on the machine it runs on —
  the remote one.
- **Fix:** the remote bridge runs Clippy's own `src/usage.js` there (copied
  in at packaging) and sends a `ClippyUsage` summary after the session's
  events: context, last reply, cached `/usage` allowance. Clippy uses it when
  the session's files aren't local; the account shows as "Claude Code (host)".
  End-of-turn cards fall back to the `last_assistant_message` Claude Code sends.
- **Files:** `vscode/clippy-bridge-remote/usage-push.js`, `src/main.js`,
  `scripts/prepare-bridge.js`
- **Checked:** tests; app.

---

## 3. Text typed on cards reaching Claude

### Text typed with **Allow** was dropped
- **Symptom:** yes/no worked, but extra detail never reached Claude.
- **Cause:** Claude Code's "allow" decision has no message field — only
  "deny" does — so Clippy discarded it.
- **Fix:** Clippy keeps the note and answers that session's next
  `PostToolUse` with it as `additionalContext`, which Claude reads beside the
  tool's result. Through the bridge, the note rides back as `clippyNote` and
  the remote half attaches it. On the Mac the `PostToolUse` curl hook now
  passes Clippy's answer through (empty unless there's a note).
- **Files:** `src/main.js`, `src/server.js`, `bin/clippy-hooks.js`,
  `vscode/clippy-bridge-remote/bridge-core.js`
- **Checked:** tests; app (Windows and Mac hook styles); you.

### Question cards had no way to give your own answer
- **Fix:** each question has a box under its options.
- **Follow-up fix:** picking "Yes" and typing replaced "Yes" with the text
  ("it changes it to an other"). Now the text is a note on the chosen answer
  — `Yes — but only to staging` — or the answer itself when nothing is picked.
- **Files:** `src/renderer/clippy.js`, `src/renderer/clippy.css`
- **Checked:** app (both cases); you.

### Replying on the finished card said "I can't type into VS Code safely"
- **Cause:** replies to a finished turn were typed into the session's
  terminal; the VS Code extension has none.
- **Fix:** a background Stop hook (Claude Code's `asyncRewake`, 30 minutes)
  waits after each turn. A reply on the card answers it and the hook exits 2
  with the words, which wakes Claude to act on them. Signing off, typing in the
  session, a new turn or the timeout end it quietly. Windows runs it in
  PowerShell, the Mac and remote machines in `sh`. Mac terminal sessions keep
  the typed reply, falling back to the wake.
- **Files:** `bin/clippy-hooks.js`, `src/main.js`, `src/server.js`,
  `relay/hook.sh`, bridge extensions
- **Checked:** tests (exit code 2 + text); app; you.

---

## 4. The buddy on screen

### Couldn't drag the buddy to another monitor
- **Cause (upstream bug):** dragging clamped to the display the buddy started
  on; placement measured a hand-placed buddy against the *primary* display.
- **Fix:** clamp to the display under the pointer; lay out a hand-placed buddy
  on its own display.
- **Files:** `src/main.js` · **Checked:** you.

### The next card popped up back in the top-right
- **Cause:** Clippy learned of a hand drag only from the window's `moved`
  event, which Electron fires for programmatic moves on macOS but not Windows —
  so on Windows the drag never counted. Separately, leaving a perch reset the
  hand-placed flag.
- **Fix:** the drag marks the buddy hand-placed itself; the spot sticks across
  cards (`keepSpot`) and across restarts (`handSpot` in settings, ignored if
  that monitor is gone). "Go to …" and Organize buddies go back to automatic.
- **Files:** `src/main.js` · **Checked:** app (drag → card → same spot;
  drag → restart → same spot); you.

### A Windows notification popped up with every buddy
- **Fix:** new setting *Also show a Windows/system notification* — off by
  default on Windows, on by default on the Mac (as upstream).
- **Checked:** you.

### "Pixel" under the buddy wasted space
- It is the buddy's pet name. New Quick setting *Show the name under the
  buddy*; off removes the plate and the window shrinks.
- **Checked:** app (23 px smaller); you.

### Clicking "Yes" on a Mac question card took two clicks
- **Cause:** cards appear without taking focus, and macOS uses the first click
  on an inactive window only to activate it. (Approval cards seemed fine
  because clicking the text box first used up that click.)
- **Fix:** `acceptFirstMouse` on buddy windows.
- **Files:** `src/main.js` · **Checked:** you.

---

## 5. Staying quiet when you're already in the session's window

### Mac: Clippy popped up over the VS Code window you were in
- **Cause:** the Mac matched the session's app by walking its process tree,
  which a remote session doesn't have locally.
- **Fix (first):** judge VS Code sessions like Windows — front app and the
  front window's title naming the folder.

### Mac: then it stayed quiet while you were in a *different* VS Code window
- **Cause (found via the new `focusChecks` on `/status`):** window titles
  need macOS Accessibility, and an unsigned test build loses that permission
  on every update, so the title came back empty and any VS Code window counted.
- **Fix:** the **Clippy Bridge (local)** extension (0.4.0) now reports, from
  every VS Code window, whether it has focus and which folders it has open.
  Clippy stays quiet only when the focused window has the session's folder
  open — no macOS permission needed. Window titles remain the fallback, and
  the tray offers the right settings pane when they can't be read. The check
  also uses the hook's own folder, so a session's first event is judged right.
- **Files:** `vscode/clippy-bridge-ui/focus-report.js`, `src/frontmost.js`,
  `src/main.js`
- **Checked:** tests; app (in `flight-clock-app` → NAS prompt pops up; in
  `gnarshare-working` → quiet); you.

### Mac: a local VS Code session still popped up over its own window
- **Cause:** windows were matched to sessions by folder *name* only — the last
  part of Claude's working directory against the last part of the folder each
  window has open. A session started in a subfolder of what VS Code has open
  (or a window opened on a parent folder) never matched.
- **Fix:** the local extension (0.5.0) also reports each folder's full path,
  and Clippy stays quiet when the session runs in or below a folder the
  focused window has open (Windows-style paths compare too). Older extensions
  still match by name.
- **Files:** `vscode/clippy-bridge-ui/focus-report.js`, `src/frontmost.js`,
  `src/main.js` · **Checked:** tests.

### Seeing why
- `http://127.0.0.1:43117/status` lists the last ten "stay quiet?" decisions
  (`focusChecks`): the session, whether it was recognised as VS Code, the
  folder, what was in front and the reason.

---

## 6. Mac-specific gaps and housekeeping

- **Mac hooks didn't say a session was the VS Code extension** — they now
  send `X-Clippy-Entrypoint`, so Clippy never types into the extension.
- **"Go to VS Code" couldn't find a remote session's window on the Mac** —
  it now finds the running VS Code-family app by bundle path and picks the
  window by folder title.
- **The Mac bundle left out `scripts/package-app.js`** (upstream bug), which
  the tray icon and custom buddies load.
- **Auto-update pointed at upstream's releases**, which would have replaced
  this fork with the original app. It now checks this fork's.
- **Builds:** *macOS build* (full test suite on a real Mac + unsigned DMG) and
  *Windows installer* workflows; both also package the bridge `.vsix` files.
- **Docs:** [WINDOWS.md](WINDOWS.md), [MAC.md](MAC.md), and the README's
  "About this fork".

---

## Known limits

- Builds are unsigned: SmartScreen warns on Windows; on the Mac each new build
  needs the quarantine command and, for the window-title fallback only,
  Accessibility re-granted.
- On the Mac, a note typed with Allow in a session whose hooks predate this
  fork is lost until the hooks are updated from the tray.
- Codex on Windows and starting agents from Clippy on Windows (tmux) are not
  supported.
