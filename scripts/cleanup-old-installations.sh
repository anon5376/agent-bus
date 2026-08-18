#!/usr/bin/env bash
set -euo pipefail

# Stops previous Agent Bus service processes and removes stale global launchers.
# Persistent state under ~/.agent-bus is intentionally preserved.

collect_agent_bus_pids() {
  {
    if command -v ps >/dev/null 2>&1; then
      ps -axo pid=,command= 2>/dev/null | awk '
        /\/agent-bus\// && /((dist\/cli\.js|cli\.js) (broker|dashboard|supervise)( |$)|dist\/broker\.js( |$)|src\/broker\.(ts|js)( |$))/ { print $1 }
      '
    fi

    if command -v lsof >/dev/null 2>&1; then
      lsof -nP -t -iTCP:7717 -sTCP:LISTEN 2>/dev/null || true
    fi
  } | awk 'NF' | sort -u
}

PIDS="$(collect_agent_bus_pids)"
if [[ -n "${PIDS}" ]]; then
  SAFE_PIDS=""
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command_line" == *"agent-bus"* || "$command_line" == *"dist/broker.js"* ]]; then
      SAFE_PIDS+="${SAFE_PIDS:+$'\n'}$pid"
    fi
  done <<< "$PIDS"

  if [[ -n "$SAFE_PIDS" ]]; then
    echo "Stopping previous Agent Bus processes: ${SAFE_PIDS//$'\n'/ }"
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done <<< "$SAFE_PIDS"
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
