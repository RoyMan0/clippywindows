#!/bin/sh
# Clippy relay hook — installed in ~/.claude/settings.json on a remote machine.
#
#   sh "$HOME/.clippy-relay/hook.sh" '<Event>?<query>' [hold]
#
# Posts the hook's JSON (stdin) to the relay on this machine's loopback and
# prints the relay's answer, which Claude Code reads as the hook's decision.
# If the relay isn't running it is started in the background and this event
# passes with no decision: Clippy can't have been connected to a relay that
# didn't exist yet. Never fails the hook, never prints anything else.

DIR="${CLIPPY_RELAY_DIR:-$HOME/.clippy-relay}"
PORT="${CLIPPY_RELAY_PORT:-43118}"
KEY=$(cat "$DIR/key" 2>/dev/null) || exit 0

URL="http://127.0.0.1:$PORT/hook/$1"
MAX=3
if [ "${2:-}" = hold ]; then
  URL="$URL&hold=1"
  MAX=115
fi

find_node() {
  command -v node 2>/dev/null && return
  # The Node that VS Code's server brought along — newest first.
  ls -t "$HOME"/.vscode-server/cli/servers/*/server/node "$HOME"/.vscode-server/bin/*/node 2>/dev/null | head -n 1
}

start_relay() {
  NODE=$(find_node)
  [ -n "$NODE" ] || return 0
  # Fully detached, so Claude Code doesn't wait on the relay's output.
  nohup "$NODE" "$DIR/clippy-relay.js" serve >>"$DIR/relay.log" 2>&1 </dev/null &
}

HOST=$(hostname 2>/dev/null || echo remote)

if command -v curl >/dev/null 2>&1; then
  curl -s --connect-timeout 1 -m "$MAX" -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H "X-Clippy-Relay-Key: $KEY" \
    -H 'X-Clippy-Hook: #clippy' \
    -H "X-Clippy-Entrypoint: ${CLAUDE_CODE_ENTRYPOINT:-}" \
    -H "X-Clippy-Term: ${TERM_PROGRAM:-}" \
    -H "X-Clippy-Remote: $HOST" \
    --data-binary @- 2>/dev/null
  RC=$?
else
  NODE=$(find_node)
  [ -n "$NODE" ] || exit 0
  CLIPPY_H_KEY="$KEY" CLIPPY_H_ENTRY="${CLAUDE_CODE_ENTRYPOINT:-}" CLIPPY_H_TERM="${TERM_PROGRAM:-}" \
    CLIPPY_H_REMOTE="$HOST" "$NODE" "$DIR/clippy-relay.js" post "$URL" "$MAX" 2>/dev/null
  RC=$?
fi

# 7 = nothing listening: start the relay for the next event.
[ "$RC" = 7 ] && start_relay
exit 0
