#!/usr/bin/env bash
set -euo pipefail

# Removes stale Agent Bus launchers only. Running processes are handled by the
# freshly built `agent-bus stop`, which can distinguish Agent Bus from unrelated
# listeners on port 7717. Persistent state under ~/.agent-bus is never touched.

KEEP_DIR="${1:-}"
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
  [[ "$(dirname "$path")" == "$KEEP_DIR" ]] && continue
  [[ "$seen" == *"|$path|"* ]] && continue
  seen+="|$path|"
  if [[ -L "$path" || -f "$path" ]]; then
    echo "Removing stale launcher: $path"
    if [[ -w "$(dirname "$path")" ]]; then
      rm -f "$path"
    elif command -v sudo >/dev/null 2>&1; then
      sudo rm -f "$path"
    fi
  fi
done
