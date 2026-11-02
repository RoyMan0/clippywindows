#!/bin/sh
# Set up the Clippy relay on a remote machine (run it there, e.g. in VS Code's
# terminal while connected through a Remote Tunnel). Clippy's tray menu gives
# you this command with your key filled in:
#
#   curl -fsSL <repo>/relay/install.sh | sh -s -- <key>
#
# It puts three files in ~/.clippy-relay, stores the key (readable by you
# only), and adds Clippy's hooks to ~/.claude/settings.json. Nothing runs in
# the background until Claude Code's first hook starts the relay, and the relay
# stops itself after 30 idle minutes. Undo with:  sh ~/.clippy-relay/install.sh --uninstall

set -eu

BASE="${CLIPPY_RELAY_BASE:-https://raw.githubusercontent.com/RoyMan0/clippywindows/windows-support}"
DIR="$HOME/.clippy-relay"

find_node() {
  command -v node 2>/dev/null && return
  ls -t "$HOME"/.vscode-server/cli/servers/*/server/node "$HOME"/.vscode-server/bin/*/node 2>/dev/null | head -n 1
}

NODE=$(find_node)
if [ -z "$NODE" ]; then
  echo "Clippy relay: no Node.js found. Connect with VS Code first (it brings its own), or install node." >&2
  exit 1
fi

if [ "${1:-}" = --uninstall ]; then
  "$NODE" "$DIR/clippy-hooks.js" uninstall --agent claude || true
  pkill -f "$DIR/clippy-relay.js" 2>/dev/null || true
  rm -rf "$DIR"
  echo "Clippy relay removed."
  exit 0
fi

KEY="${1:-}"
case "$KEY" in
  ''|*[!A-Za-z0-9_-]*) echo "usage: install.sh <key from Clippy's tray menu>" >&2; exit 1 ;;
esac

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$BASE/$1" -o "$2"
  else wget -qO "$2" "$BASE/$1"; fi
}

mkdir -p "$DIR"
chmod 700 "$DIR"
fetch relay/clippy-relay.js "$DIR/clippy-relay.js"
fetch relay/hook.sh "$DIR/hook.sh"
fetch relay/install.sh "$DIR/install.sh"
fetch bin/clippy-hooks.js "$DIR/clippy-hooks.js"
(umask 077 && printf '%s\n' "$KEY" > "$DIR/key")

# A relay from an older install would still hold the old key.
pkill -f "$DIR/clippy-relay.js" 2>/dev/null || true

"$NODE" "$DIR/clippy-hooks.js" install --agent claude --style relay
"$NODE" "$DIR/clippy-relay.js" vscode-settings || true

echo
echo "Clippy relay is set up on $(hostname)."
echo "Reload the VS Code window (or restart Claude Code) so the hooks load."
