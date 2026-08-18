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

FALLBACK_NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "Agent Bus requires Node.js 22.5+; found $(node --version) at $FALLBACK_NODE_BIN" >&2
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
BUS_HOME="${AGENT_BUS_HOME:-$HOME/.agent-bus}"
APP_ROOT="$BUS_HOME/app"
RELEASES_DIR="$APP_ROOT/releases"
PERSISTENT_CONFIG="$BUS_HOME/config.json"
TMP_DIR="$(mktemp -d)"
STAGE_DIR=""
trap 'rm -rf "$TMP_DIR"; [[ -n "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"' EXIT

printf 'Installing Agent Bus from %s\n' "$ROOT"
printf 'Canonical application directory: %s\n' "$APP_ROOT/current"
printf 'Global launcher directory: %s\n' "$TARGET_DIR"

# Compile lifecycle code first, stop the old product, and only then rewrite the
# Vite output. This prevents an old broker from serving a half-rebuilt dist/web.
npm ci
npm run build:core
node "$ROOT/dist/cli.js" stop || true
npm run build:web

ARTIFACT_ID="$(node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const inputs = ['dist', 'cli.js', 'package.json', 'package-lock.json'];
const files = [];
function walk(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) walk(join(path, name));
  } else if (stat.isFile()) {
    files.push(path);
  }
}
for (const input of inputs) walk(input);
const hash = createHash('sha256');
for (const path of files.sort()) {
  hash.update(path);
  hash.update('\0');
  hash.update(readFileSync(path));
  hash.update('\0');
}
process.stdout.write(hash.digest('hex').slice(0, 20));
NODE
)"

mkdir -p "$BUS_HOME" "$RELEASES_DIR"
if [[ ! -f "$PERSISTENT_CONFIG" ]]; then
  install -m 0600 "$ROOT/agent-bus.config.json" "$PERSISTENT_CONFIG"
fi

RELEASE_DIR="$RELEASES_DIR/$ARTIFACT_ID"
if [[ ! -d "$RELEASE_DIR" ]]; then
  STAGE_DIR="$(mktemp -d "$APP_ROOT/.stage.XXXXXX")"
  cp -R "$ROOT/dist" "$STAGE_DIR/dist"
  cp -R "$ROOT/node_modules" "$STAGE_DIR/node_modules"
  install -m 0755 "$ROOT/cli.js" "$STAGE_DIR/cli.js"
  install -m 0644 "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/agent-bus.config.json" "$STAGE_DIR/"
  printf '%s\n' "$ARTIFACT_ID" > "$STAGE_DIR/ARTIFACT_ID"
  mv "$STAGE_DIR" "$RELEASE_DIR"
  STAGE_DIR=""
fi

rm -f "$APP_ROOT/current.next"
ln -s "$RELEASE_DIR" "$APP_ROOT/current.next"
rm -f "$APP_ROOT/current"
mv "$APP_ROOT/current.next" "$APP_ROOT/current"

make_wrapper() {
  local name="$1"
  local target="$2"
  cat > "$TMP_DIR/$name" <<EOF
#!/bin/sh
# Agent Bus canonical launcher
BUS_HOME="\${AGENT_BUS_HOME:-\$HOME/.agent-bus}"
APP_CURRENT="\$BUS_HOME/app/current"
if [ "\${1:-}" = "__launcher-info" ]; then
  printf 'launcher=%s\napplication=%s\nentrypoint=%s\n' "\$0" "\$APP_CURRENT" "\$APP_CURRENT/$target"
  exit 0
fi
NODE_BIN="\${AGENT_BUS_NODE_BIN:-\$(command -v node 2>/dev/null || true)}"
if [ -z "\$NODE_BIN" ] || [ ! -x "\$NODE_BIN" ]; then
  NODE_BIN="$FALLBACK_NODE_BIN"
fi
if [ ! -x "\$NODE_BIN" ]; then
  echo "Agent Bus requires Node.js 22.5+; no executable Node binary was found." >&2
  exit 1
fi
export AGENT_BUS_LAUNCHER_PATH="\$0"
export AGENT_BUS_INSTALL_ROOT="\$APP_CURRENT"
if [ -z "\${AGENT_BUS_CONFIG:-}" ]; then
  export AGENT_BUS_CONFIG="\$BUS_HOME/config.json"
fi
exec "\$NODE_BIN" "\$APP_CURRENT/$target" "\$@"
EOF
  chmod 0755 "$TMP_DIR/$name"
}

make_wrapper "agent-bus" "dist/cli.js"
make_wrapper "agent-bus-mcp" "dist/mcp-server.js"
make_wrapper "agent-bus-openai-compatible" "dist/openai-compatible-harness.js"

if [[ ! -d "$TARGET_DIR" ]]; then
  mkdir -p "$TARGET_DIR" 2>/dev/null || sudo mkdir -p "$TARGET_DIR"
fi

# Replace every positively identified old launcher in place. This includes
# launchers earlier in PATH and old nvm/npm/pnpm/yarn locations, so a cached
# command path cannot restart an obsolete checkout after reinstall.
bash "$ROOT/scripts/cleanup-old-installations.sh" "$TARGET_DIR" "$TMP_DIR"

install_one() {
  local name="$1"
  local destination="$TARGET_DIR/$name"
  if [[ -w "$TARGET_DIR" ]]; then
    rm -f "$destination"
    install -m 0755 "$TMP_DIR/$name" "$destination"
  else
    sudo rm -f "$destination"
    sudo install -m 0755 "$TMP_DIR/$name" "$destination"
  fi
}

install_one agent-bus
install_one agent-bus-mcp
install_one agent-bus-openai-compatible

RESOLVED_AGENT_BUS="$(command -v agent-bus 2>/dev/null || true)"
if [[ -z "$RESOLVED_AGENT_BUS" ]]; then
  echo "Installation completed, but this shell cannot resolve agent-bus from PATH." >&2
  exit 1
fi
if ! grep -q '# Agent Bus canonical launcher' "$RESOLVED_AGENT_BUS" 2>/dev/null; then
  echo "A non-Agent-Bus executable shadows the new launcher: $RESOLVED_AGENT_BUS" >&2
  echo "The installer did not overwrite it because it could not safely identify it as Agent Bus." >&2
  exit 1
fi
LAUNCHER_INFO="$($RESOLVED_AGENT_BUS __launcher-info)"
if [[ "$LAUNCHER_INFO" != *"application=$APP_ROOT/current"* ]]; then
  echo "The resolved launcher does not point to the canonical Agent Bus installation:" >&2
  printf '%s\n' "$LAUNCHER_INFO" >&2
  exit 1
fi

"$RESOLVED_AGENT_BUS" models >/dev/null

printf '\nAgent Bus installed globally:\n'
printf '  resolved launcher: %s\n' "$RESOLVED_AGENT_BUS"
printf '  canonical app:    %s\n' "$APP_ROOT/current"
printf '  artifact:         %s\n' "$ARTIFACT_ID"
printf '\nPersistent state preserved at: %s\n' "$BUS_HOME"
printf 'Run from any directory: agent-bus start\n'
