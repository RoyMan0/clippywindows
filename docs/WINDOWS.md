# Clippy on Windows (work in progress)

This fork is adding Windows support alongside the existing Mac app. Mac
behaviour is unchanged.

## What works so far

- The app runs on Windows and sits in the system tray (📎).
- **Hooks.** On Windows, Clippy installs Claude Code's own `http` hooks instead
  of `curl` shell commands, so it does not matter whether Claude Code runs its
  hooks through Git Bash or PowerShell. They post to `127.0.0.1:43117`, the same
  local-only server the Mac app uses. If Clippy isn't running, Claude Code just
  carries on and shows its normal prompt.
- Sessions started from the **VS Code Claude Code extension** report through the
  same hooks as terminal sessions.
- Buddies appear when a session needs you, and permission / plan / question
  cards can be answered from Clippy.
- **Go to VS Code ↗** brings the session's VS Code window to the front — the
  one whose title names the project folder, if you have several open — and the
  buddy can perch on it and follow it around.
- **Stay quiet when I'm already in that window** compares the exact window, so
  being in another project's VS Code window doesn't silence this one.
- **Typing a follow-up** from the buddy works for sessions in Windows Terminal.
  It is switched off for VS Code (the extension's chat box can't be typed into
  from outside, and in VS Code's terminal the keys could land in an open file).
- A Windows **installer** (unsigned for now).

## Remote machines (VS Code Remote Tunnel / Remote-SSH)

When VS Code is connected to another machine (a NAS through a Remote Tunnel,
say), the Claude Code extension runs **on that machine**, so its hooks can't
reach Clippy on your computer. A small relay bridges the gap, through the
tunnel you are already using, from home or anywhere else:

```
Claude Code (remote) ─▶ hook.sh ─▶ relay on the remote's 127.0.0.1:43118
                                        │ VS Code forwards port 43118
Clippy (your computer) ◀── long-poll ───┘
```

- Nothing listens on the network at either end — both are loopback-only, and
  VS Code's port forwarding (inside the tunnel, private to you) joins them.
- Every request carries a private key that Clippy generates; other accounts or
  containers on the remote machine can't inject events or answer prompts.
- The relay is started by Claude Code's first hook and **stops itself after 30
  idle minutes**, so it only runs while you're using Claude there.
- When Clippy isn't connected (VS Code closed, PC asleep), hooks get no
  decision straight away and VS Code shows its normal prompt.

### Set it up (once per remote machine)

1. Clippy tray menu → **🌐 Use with a remote machine…** → **Copy setup command**.
2. In VS Code, connected to the remote machine, open a terminal and paste/run
   it. It downloads three small files from this repo into `~/.clippy-relay`
   (read them first if you like: `relay/install.sh`, `relay/hook.sh`,
   `relay/clippy-relay.js`), stores the key, and adds Clippy's hooks to that
   machine's `~/.claude/settings.json`. It uses the Node.js VS Code already
   installed there.
3. Reload the VS Code window.
4. Use Claude once. The relay starts, VS Code forwards port 43118 (check the
   **Ports** panel; if it isn't there, **Forward a Port → 43118**), and the
   tray shows **🌐 Remote relay: connected** within a few seconds.

The very first prompt after connecting may still appear in VS Code: the relay
starts on that hook, and Clippy connects a moment later.

To remove it from the remote machine: `sh ~/.clippy-relay/install.sh --uninstall`.
To turn it off in Clippy: the same tray item → **Turn off**.

Limits: Clippy can't read Claude's conversation files on the other machine, so
the context meter is empty for remote sessions and the end-of-turn card uses
the summary Claude Code sends with the event. If VS Code forwards to a local
port other than 43118 (because 43118 was taken), Clippy won't find it yet.
On a Mac the relay works too, but "go to VS Code" can't pick the window for a
remote session yet.

## Not on Windows yet

- Starting agents from Clippy (needs tmux, which Windows doesn't have).
- Automatic updates.
- Codex hooks (a bare install on Windows sets up Claude Code only).
- A signed installer — until then SmartScreen warns on first run.

## How window-finding works

Windows hooks can't report a terminal or process the way the Mac's do, so the
hooks pass along a few environment variables instead: `CLAUDE_CODE_ENTRYPOINT`
(is this the VS Code extension?), `VSCODE_PID` (which VS Code), `WT_SESSION`
(Windows Terminal) and `TERM_PROGRAM`. Only those listed variables are ever
sent, and only to Clippy on `127.0.0.1`.

Clippy then looks through the open windows with a small PowerShell helper it
starts once (`src/win-windows.js`) and picks the window of the right app whose
title names the project folder. If it can't tell which window is the right one,
it doesn't guess.

## Install

### Option A: the installer

1. In your fork on GitHub, open the **Actions** tab and enable workflows
   (GitHub turns them off on new forks).
2. Open the **Windows installer** workflow → the latest run on
   `windows-support` → **Artifacts** → download `clippy-windows-installer`.
   (Or press **Run workflow** to build one.)
3. Unzip it and run `Clippy-for-Claude-Code-Setup-<version>.exe`. SmartScreen
   will say "Windows protected your PC": click **More info → Run anyway**.

### Option B: from source

You need [Node.js](https://nodejs.org) 18 or newer and Git.

```powershell
git clone https://github.com/RoyMan0/clippywindows
cd clippywindows
git checkout windows-support
npm install
npm start
```

To build the installer yourself on Windows: `npm run package:win` (output in `dist\`).

### Then

Click the 📎 in the system tray (it may be under the `^` overflow arrow) and
choose **Install hooks**. Restart any running Claude Code sessions (reload the
VS Code window for the extension) so they pick the hooks up.

If you installed an earlier build of this branch, the tray menu will say the
hooks are out of date — click it to update them.

To remove the hooks later: `node bin/clippy-hooks.js uninstall` from a source
checkout, or delete the entries containing `#clippy` from
`%USERPROFILE%\.claude\settings.json`.

## Test checklist

Please note what happens at each step:

1. The app starts and a 📎 appears in the tray.
2. **Install hooks** from the tray menu. `%USERPROFILE%\.claude\settings.json`
   now has entries with `"type": "http"` pointing at `127.0.0.1:43117`.
3. In the VS Code extension, ask Claude to run a command that needs permission.
   - Does a buddy appear with an approval card?
   - Does **Allow** on the card let the command run? Does **Deny** stop it?
4. Click **Go to VS Code ↗** on a card while another app is in front. Does the
   right VS Code window come forward? With two VS Code windows open on
   different folders, does it pick the right one?
5. Let Claude finish a turn — does a "your turn" buddy appear? With VS Code in
   front on that project, does Clippy stay quiet instead?
6. Ask Claude something that makes it use a multiple-choice question
   (AskUserQuestion) — can you answer it from the card?
7. Run `claude` in **Windows Terminal** and repeat 3–5; also try typing a
   follow-up to it from the buddy.
8. On a display with scaling above 100%, does a perched buddy sit on the
   window's corner (not offset from it)?

If something fails, run Clippy from source with `npm start` and copy the lines
starting with `clippy:` from that terminal. `node scripts/win-helper-smoke.js`
checks the window helper on its own.
