#!/usr/bin/env bash
set -euo pipefail

# Finds Agent Bus launchers across the current PATH and common macOS Node/package
# manager locations. Identified legacy launchers are replaced in place when a
# wrapper directory is supplied. Replacing instead of merely deleting matters:
# zsh/bash may have cached the old executable path in the parent shell.
# Persistent state under ~/.agent-bus (or AGENT_BUS_HOME) is never touched.

PRIMARY_DIR="${1:-}"
WRAPPER_DIR="${2:-}"
PREFIX="$(npm prefix -g 2>/dev/null || true)"

DIRS=()
add_dir() {
  local candidate="$1"
  [[ -z "$candidate" || ! -d "$candidate" ]] && return
  local existing
  for existing in "${DIRS[@]:-}"; do
    [[ "$existing" == "$candidate" ]] && return
  done
  DIRS+=("$candidate")
}

IFS=':' read -r -a PATH_ENTRIES <<< "${PATH:-}"
for dir in "${PATH_ENTRIES[@]}"; do add_dir "$dir"; done
add_dir "$PRIMARY_DIR"
add_dir "/usr/local/bin"
add_dir "/opt/homebrew/bin"
add_dir "$HOME/.local/bin"
add_dir "$HOME/.npm-global/bin"
add_dir "$HOME/Library/pnpm"
add_dir "$HOME/.yarn/bin"
add_dir "$HOME/.bun/bin"
[[ -n "$PREFIX" ]] && add_dir "$PREFIX/bin"
for dir in "$HOME"/.nvm/versions/node/*/bin; do add_dir "$dir"; done

launcher_payload() {
  local path="$1"
  if [[ -L "$path" ]]; then
    readlink "$path" 2>/dev/null || true
  elif [[ -f "$path" ]]; then
    head -c 16384 "$path" 2>/dev/null || true
  fi
}

is_agent_bus_launcher() {
  local path="$1"
  [[ -L "$path" || -f "$path" ]] || return 1
  local payload
  payload="$(launcher_payload "$path")"
  [[ "$payload" == *"# Agent Bus canonical launcher"* ]] && return 0
  [[ "$payload" == *"node_modules/agent-bus/"* ]] && return 0
  [[ "$payload" == *"/agent-bus/"*"dist/cli.js"* ]] && return 0
  [[ "$payload" == *"/agent-bus/"*"dist/mcp-server.js"* ]] && return 0
  [[ "$payload" == *"/agent-bus/"*"dist/openai-compatible-harness.js"* ]] && return 0
  [[ "$payload" == *"/agent-bus-"*"dist/cli.js"* ]] && return 0
  [[ "$payload" == *"/agent-bus-"*"dist/mcp-server.js"* ]] && return 0
  [[ "$payload" == *"/agent-bus-"*"dist/openai-compatible-harness.js"* ]] && return 0
  return 1
}

install_at() {
  local source="$1"
  local destination="$2"
  local parent
  parent="$(dirname "$destination")"
  if [[ -w "$parent" ]]; then
    rm -f "$destination"
    install -m 0755 "$source" "$destination"
  else
    sudo rm -f "$destination"
    sudo install -m 0755 "$source" "$destination"
  fi
}

NAMES=(agent-bus agent-bus-mcp agent-bus-openai-compatible)
for dir in "${DIRS[@]}"; do
  for name in "${NAMES[@]}"; do
    path="$dir/$name"
    is_agent_bus_launcher "$path" || continue
    if [[ -n "$WRAPPER_DIR" && -f "$WRAPPER_DIR/$name" ]]; then
      echo "Canonicalizing stale launcher: $path"
      install_at "$WRAPPER_DIR/$name" "$path"
    else
      echo "Removing stale launcher: $path"
      if [[ -w "$dir" ]]; then rm -f "$path"; else sudo rm -f "$path"; fi
    fi
  done
done
