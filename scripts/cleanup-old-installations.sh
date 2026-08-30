#!/usr/bin/env bash
set -euo pipefail

# Finds Qagent launchers across the current PATH and common macOS Node/package
# manager locations. Identified legacy launchers are replaced in place when a
# wrapper directory is supplied. Replacing instead of merely deleting matters:
# zsh/bash may have cached the old executable path in the parent shell.
# Persistent state under ~/.qagent or ~/.agent-bus is never touched.

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

is_qagent_launcher() {
  local path="$1"
  [[ -L "$path" || -f "$path" ]] || return 1
  local payload name expected
  payload="$(launcher_payload "$path")"
  name="$(basename "$path")"
  [[ "$payload" == *"# Qagent canonical launcher"* ]] && return 0
  [[ "$payload" == *"node_modules/agent-bus/"* || "$payload" == *"node_modules/qagent/"* ]] && return 0
  case "$name" in
    qagent|agent-bus) expected="dist/cli.js" ;;
    qagent-mcp|agent-bus-mcp) expected="dist/mcp-server.js" ;;
    qagent-openai-compatible|agent-bus-openai-compatible) expected="dist/openai-compatible-harness.js" ;;
    *) return 1 ;;
  esac
  # Checkout directory names are not stable. An old clone may be named
  # agent-bus-old, old-agent-bus, qagent, or anything else containing those ids.
  # The executable name plus the exact permanent dist entrypoint keeps this
  # narrow while still finding those installations.
  [[ "$payload" == *"agent-bus"*"$expected"* || "$payload" == *"qagent"*"$expected"* ]]
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

NAMES=(qagent qagent-mcp qagent-openai-compatible agent-bus agent-bus-mcp agent-bus-openai-compatible)
for dir in "${DIRS[@]}"; do
  for name in "${NAMES[@]}"; do
    path="$dir/$name"
    is_qagent_launcher "$path" || continue
    if [[ -n "$WRAPPER_DIR" && -f "$WRAPPER_DIR/$name" ]]; then
      echo "Canonicalizing stale launcher: $path"
      install_at "$WRAPPER_DIR/$name" "$path"
    else
      echo "Removing stale launcher: $path"
      if [[ -w "$dir" ]]; then rm -f "$path"; else sudo rm -f "$path"; fi
    fi
  done
done
