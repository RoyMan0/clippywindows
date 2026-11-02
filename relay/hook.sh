#!/bin/sh
# Clippy hook for a remote machine — installed in ~/.claude/settings.json by
# relay/install.sh.
#
#   sh "$HOME/.clippy-relay/hook.sh" '<Event>?<query>' [hold]
#
# Posts the hook's JSON (stdin) to the Clippy Bridge VS Code extension, which
# listens on this machine's loopback while a VS Code window is connected here,
# and prints its answer — Claude Code reads that as the hook's decision.
# With no VS Code connected nothing is listening, and the hook passes quietly
# with no decision. Never fails the hook, never prints anything else.

DIR="${CLIPPY_RELAY_DIR:-$HOME/.clippy-relay}"
PORT="${CLIPPY_RELAY_PORT:-43118}"
KEY=$(cat "$DIR/key" 2>/dev/null) || exit 0

URL="http://127.0.0.1:$PORT/hook/$1"
MAX=3
if [ "${2:-}" = hold ]; then
  URL="$URL&hold=1"
  MAX=115
fi

if command -v curl >/dev/null 2>&1; then
  curl -s --connect-timeout 1 -m "$MAX" -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H "X-Clippy-Relay-Key: $KEY" \
    -H "X-Clippy-Entrypoint: ${CLAUDE_CODE_ENTRYPOINT:-}" \
    -H "X-Clippy-Term: ${TERM_PROGRAM:-}" \
    --data-binary @- 2>/dev/null
elif command -v wget >/dev/null 2>&1; then
  BODY=$(cat)
  wget -qO- -T "$MAX" -t 1 \
    --header='Content-Type: application/json' \
    --header="X-Clippy-Relay-Key: $KEY" \
    --header="X-Clippy-Entrypoint: ${CLAUDE_CODE_ENTRYPOINT:-}" \
    --header="X-Clippy-Term: ${TERM_PROGRAM:-}" \
    --post-data="$BODY" "$URL" 2>/dev/null
fi
exit 0
