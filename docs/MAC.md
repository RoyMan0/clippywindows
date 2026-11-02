# This fork on the Mac

The Mac app is the same code as the Windows one. Everything below is what
this fork changes on the Mac compared with the original Clippy, and how to try
it.

## What's different from the original

- **VS Code extension sessions.** Hooks now say when a session is the Claude
  Code VS Code extension. Clippy never types into it (keys could land in an
  open file); replies reach Claude another way (below).
- **Text on cards reaches Claude:**
  - *Approval card:* words typed with **Deny** are Claude's reason, as
    before; words typed with **Allow** now come back to Claude with the
    tool's result.
  - *Question card:* each question has an **Other…** box for your own answer.
  - *Finished card:* a reply to a VS Code session wakes Claude with it, via a
    background Stop hook (Claude Code's `asyncRewake`) that waits up to 30
    minutes after each turn and ends quietly if you click *looks good* or type
    in the session yourself. Terminal sessions (Terminal, iTerm, Ghostty…)
    still get the reply typed in, as before.
- **Remote machines** (VS Code Remote Tunnel / Remote-SSH): the two Clippy
  Bridge extensions carry hooks from the remote machine, and the stats panel
  shows that machine's usage. "Go to VS Code ↗" finds the right VS Code window
  by its folder name. Setup: [WINDOWS.md → Remote machines](WINDOWS.md#remote-machines-vs-code-remote-tunnel--remote-ssh).
- **The buddy stays where you put it**, across cards and restarts, on any
  monitor (dragging between monitors works). "Go to …" or Organize buddies
  puts it back on automatic.
- **Quick settings → Show the name under the buddy** hides the name plate.
- **Updates** come from this fork's GitHub releases, never from the original
  app's (which would replace this fork with the original).

## Install the test build

1. In the fork's **Actions** tab → **macOS build** → the latest run →
   **Artifacts** → download `clippy-mac-build`. It contains
   `Clippy-for-Claude-Code.dmg` and the two bridge `.vsix` files.
   It's an Apple-silicon build (M1 or later).
2. Quit any Clippy already running (📎 menu → Quit). If you have the original
   installed, this one replaces it in Applications — same app name.
3. Open the DMG and drag the app to Applications.
4. This build isn't signed or notarized by Apple, so macOS quarantines it.
   Clear that once:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Clippy for Claude Code.app"
   ```

5. Open it. From the 📎 menu choose **Install hooks** (or **Hooks are out of
   date — update them now**), then restart Claude Code sessions / reload VS
   Code windows so they pick the new hooks up.
6. For VS Code tunnels: install both `.vsix` files in VS Code (Extensions →
   ⋯ → Install from VSIX…) while connected to the remote machine.

## Test checklist

1. A Claude Code session in **Terminal / iTerm**: permission card → Allow and
   Deny work; a reply on the finished card is typed into the terminal as
   before.
2. The **VS Code extension** (a local folder): permission card appears;
   **Allow with a note** — does Claude mention the note after the tool runs?
   **Reply on the finished card** — does Claude wake up and act on it? Clippy
   must never type into VS Code.
3. A **question** with your own text in **Other…**.
4. **Go to VS Code ↗** with two VS Code windows open — the right one comes
   forward (needs Accessibility, as before).
5. Drag the buddy to the other monitor, answer the card, trigger another —
   it appears where you left it; quit and reopen Clippy — still there.
6. A **VS Code tunnel** session (with the bridge extensions): cards, stats
   panel numbers, and "Go to VS Code ↗".
