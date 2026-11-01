# Clippy on Windows (work in progress)

This fork is adding Windows support alongside the existing Mac app. Mac
behaviour is unchanged.

## What works so far

- The app starts on Windows and sits in the system tray (📎).
- **Hooks.** On Windows, Clippy installs Claude Code's own `http` hooks instead
  of `curl` shell commands, so it does not matter whether Claude Code runs its
  hooks through Git Bash or PowerShell. They post to `127.0.0.1:43117`, the same
  local-only server the Mac app uses. If Clippy isn't running, Claude Code just
  carries on and shows its normal prompt.
- Buddies appear when a session needs you, and permission / plan / question
  cards can be answered from Clippy (needs testing — see below).
- Sessions started from the **VS Code Claude Code extension** report through the
  same hooks as terminal sessions.

## Not on Windows yet

- Bringing the session's window (VS Code) to the front, and "perching" the buddy
  on it. The buddy appears in its normal spot instead.
- Typing a follow-up into the session from the buddy.
- Starting agents from Clippy (needs tmux, which Windows doesn't have).
- Automatic updates and an installer. Run it from source for now.
- Codex hooks (a bare install on Windows sets up Claude Code only).

## Run it from source

You need [Node.js](https://nodejs.org) 18 or newer and Git.

```powershell
git clone https://github.com/RoyMan0/clippywindows
cd clippywindows
git checkout windows-support
npm install
npm start
```

Then click the 📎 in the system tray (it may be under the `^` overflow arrow)
and choose **Install hooks**. Restart any running Claude Code sessions (reload
the VS Code window for the extension) so they pick the hooks up.

To remove the hooks later: `node bin/clippy-hooks.js uninstall`.

## Test checklist

Please note what happens at each step:

1. `npm install` and `npm start` finish without errors, and a 📎 appears in the tray.
2. **Install hooks** from the tray menu. `%USERPROFILE%\.claude\settings.json`
   now has entries with `"type": "http"` pointing at `127.0.0.1:43117`.
3. In the VS Code extension, ask Claude to run a command that needs permission.
   - Does a buddy appear with an approval card?
   - Does **Allow** on the card let the command run? Does **Deny** stop it?
4. Let Claude finish a turn — does a "your turn" buddy appear?
5. Ask Claude something that makes it use a multiple-choice question
   (AskUserQuestion) — can you answer it from the card?
6. Repeat 3–4 in a Claude Code session in a terminal (Windows Terminal or the
   VS Code terminal).

If something fails, `npm start` prints Clippy's log in the terminal you ran it
from — copy the lines starting with `clippy:`.
