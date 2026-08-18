#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer currently targets macOS. Use npm install && npm run build on other platforms." >&2
  exit 1
fi

bash "$ROOT/scripts/cleanup-old-installations.sh"

npm install
npm run build

NODE_BIN="$(command -v node)"
TARGET_DIR="/usr/local/bin"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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
  sudo mkdir -p "$TARGET_DIR"
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

hash -r 2>/dev/null || true

echo
echo "Agent Bus installed globally:"
echo "  $TARGET_DIR/agent-bus"
echo "  $TARGET_DIR/agent-bus-mcp"
echo "  $TARGET_DIR/agent-bus-openai-compatible"
echo
echo "Persistent state preserved at: $HOME/.agent-bus"
echo "Run from any directory: agent-bus start"

case ":$PATH:" in
  *":$TARGET_DIR:"*) ;;
  *)
    echo
    echo "Your current PATH does not include $TARGET_DIR. Add this once:"
    echo "  echo 'export PATH=\"/usr/local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
    ;;
esac
