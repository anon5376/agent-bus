#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The global installer currently targets macOS. Use npm ci && npm run build on other platforms." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.5+ is required before installing Agent Bus." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "Agent Bus requires Node.js 22.5+; found $(node --version) at $NODE_BIN" >&2
  exit 1
fi

choose_target_dir() {
  if [[ -n "${AGENT_BUS_INSTALL_DIR:-}" ]]; then
    printf '%s\n' "$AGENT_BUS_INSTALL_DIR"
    return
  fi

  local npm_bin=""
  local npm_prefix=""
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  [[ -n "$npm_prefix" ]] && npm_bin="$npm_prefix/bin"

  local dir
  IFS=':' read -r -a path_entries <<< "$PATH"
  for dir in "${path_entries[@]}"; do
    case "$dir" in
      /opt/homebrew/bin|/usr/local/bin|"$HOME"/.local/bin|"$HOME"/.nvm/versions/node/*/bin|"$npm_bin")
        [[ -n "$dir" && -d "$dir" ]] && { printf '%s\n' "$dir"; return; }
        ;;
    esac
  done

  for dir in /opt/homebrew/bin /usr/local/bin "$npm_bin" "$HOME/.local/bin"; do
    [[ -n "$dir" && -d "$dir" && ":$PATH:" == *":$dir:"* ]] && { printf '%s\n' "$dir"; return; }
  done

  echo "No safe global executable directory was found in your current PATH." >&2
  echo "Expected one of /opt/homebrew/bin, /usr/local/bin, an npm global bin, ~/.local/bin, or the active nvm bin." >&2
  exit 1
}

TARGET_DIR="$(choose_target_dir)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

printf 'Installing Agent Bus from %s\n' "$ROOT"
printf 'Global launcher directory: %s\n' "$TARGET_DIR"

npm ci
npm run build

# Use the newly built lifecycle code to stop previous versions safely. This preserves ~/.agent-bus.
node "$ROOT/dist/cli.js" stop || true
bash "$ROOT/scripts/cleanup-old-installations.sh" "$TARGET_DIR"

make_wrapper() {
  local name="$1"
  local target="$2"
  cat > "$TMP_DIR/$name" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$ROOT/$target" "\$@"
EOF
  chmod 0755 "$TMP_DIR/$name"
}

make_wrapper "agent-bus" "dist/cli.js"
make_wrapper "agent-bus-mcp" "dist/mcp-server.js"
make_wrapper "agent-bus-openai-compatible" "dist/openai-compatible-harness.js"

if [[ ! -d "$TARGET_DIR" ]]; then
  mkdir -p "$TARGET_DIR" 2>/dev/null || sudo mkdir -p "$TARGET_DIR"
fi

install_one() {
  local name="$1"
  if [[ -w "$TARGET_DIR" ]]; then
    install -m 0755 "$TMP_DIR/$name" "$TARGET_DIR/$name"
  else
    sudo install -m 0755 "$TMP_DIR/$name" "$TARGET_DIR/$name"
  fi
}

install_one agent-bus
install_one agent-bus-mcp
install_one agent-bus-openai-compatible

"$TARGET_DIR/agent-bus" models >/dev/null
hash -r 2>/dev/null || true

printf '\nAgent Bus installed globally:\n'
printf '  %s/agent-bus\n' "$TARGET_DIR"
printf '  %s/agent-bus-mcp\n' "$TARGET_DIR"
printf '  %s/agent-bus-openai-compatible\n' "$TARGET_DIR"
printf '\nPersistent state preserved at: %s/.agent-bus\n' "$HOME"
printf 'Run from any directory: agent-bus start\n'
