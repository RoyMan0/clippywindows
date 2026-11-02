#!/bin/sh
# Set up Clippy's hooks on a remote machine (run it there, e.g. in a VS Code
# terminal connected through a Remote Tunnel or Remote-SSH):
#
#   curl -fsSL <repo>/relay/install.sh | sh
#
# It puts two small files in ~/.clippy-relay, creates a private key there
# (readable by you only), and adds Clippy's hooks to ~/.claude/settings.json.
# The hooks talk to the Clippy Bridge VS Code extension, which only runs while
# a VS Code window is connected — nothing else runs on this machine.
#
# Undo:  sh ~/.clippy-relay/install.sh --uninstall

set -eu

BASE="${CLIPPY_RELAY_BASE:-https://raw.githubusercontent.com/RoyMan0/clippywindows/windows-support}"
DIR="$HOME/.clippy-relay"

find_node() {
  command -v node 2>/dev/null && return
  # The Node that VS Code's server brought along — newest first.
  ls -t "$HOME"/.vscode-server/cli/servers/*/server/node "$HOME"/.vscode-server/bin/*/node 2>/dev/null | head -n 1
}

NODE=$(find_node)
if [ -z "$NODE" ]; then
  echo "Clippy: no Node.js found. Run this from a VS Code terminal connected to this machine (VS Code brings its own)." >&2
  exit 1
fi

if [ "${1:-}" = --uninstall ]; then
  "$NODE" "$DIR/clippy-hooks.js" uninstall --agent claude || true
  rm -rf "$DIR"
  echo "Clippy hooks removed from this machine."
  exit 0
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$BASE/$1" -o "$2"
  else wget -qO "$2" "$BASE/$1"; fi
}

mkdir -p "$DIR"
chmod 700 "$DIR"

# An earlier version ran its own relay process on the bridge's port; retire it.
if [ -f "$DIR/clippy-relay.js" ]; then
  pkill -f "$DIR/clippy-relay.js" 2>/dev/null || true
  rm -f "$DIR/clippy-relay.js" "$DIR/relay.log"
fi
fetch relay/hook.sh "$DIR/hook.sh"
fetch relay/install.sh "$DIR/install.sh"
fetch bin/clippy-hooks.js "$DIR/clippy-hooks.js"

# The key keeps other accounts and containers on this machine from talking to
# the bridge. Kept across re-installs.
if [ ! -s "$DIR/key" ]; then
  (umask 077 && "$NODE" -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))" > "$DIR/key")
fi
chmod 600 "$DIR/key"

"$NODE" "$DIR/clippy-hooks.js" install --agent claude --style relay

echo
echo "Clippy hooks are set up on $(hostname)."
echo "Make sure both Clippy Bridge extensions are installed, then reload the VS Code window."
