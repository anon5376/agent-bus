#!/usr/bin/env bash
set -euo pipefail

# Stops previous Agent Bus service processes and removes stale global launchers.
# Persistent state under ~/.agent-bus is intentionally preserved.

if command -v ps >/dev/null 2>&1; then
  PIDS="$(ps -axo pid=,command= 2>/dev/null | awk '
    /\/agent-bus\// && /(dist\/cli\.js|cli\.js) (broker|dashboard|supervise)( |$)/ { print $1 }
  ' | sort -u)"
  if [[ -n "${PIDS}" ]]; then
    echo "Stopping previous Agent Bus processes: ${PIDS//$'\n'/ }"
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done <<< "$PIDS"
    sleep 0.6
  fi
fi

PREFIX="$(npm prefix -g 2>/dev/null || true)"
CANDIDATES=(
  "/usr/local/bin/agent-bus"
  "/usr/local/bin/agent-bus-mcp"
  "/usr/local/bin/agent-bus-openai-compatible"
  "/opt/homebrew/bin/agent-bus"
  "/opt/homebrew/bin/agent-bus-mcp"
  "/opt/homebrew/bin/agent-bus-openai-compatible"
  "$HOME/.local/bin/agent-bus"
  "$HOME/.local/bin/agent-bus-mcp"
  "$HOME/.local/bin/agent-bus-openai-compatible"
)
if [[ -n "$PREFIX" ]]; then
  CANDIDATES+=(
    "$PREFIX/bin/agent-bus"
    "$PREFIX/bin/agent-bus-mcp"
    "$PREFIX/bin/agent-bus-openai-compatible"
  )
fi

seen=""
for path in "${CANDIDATES[@]}"; do
  [[ -z "$path" ]] && continue
  [[ "$seen" == *"|$path|"* ]] && continue
  seen+="|$path|"
  if [[ -L "$path" || -f "$path" ]]; then
    echo "Removing old launcher: $path"
    if [[ -w "$(dirname "$path")" ]]; then
      rm -f "$path"
    elif command -v sudo >/dev/null 2>&1; then
      sudo rm -f "$path"
    fi
  fi
done
