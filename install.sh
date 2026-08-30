#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The global installer currently targets macOS. Use npm ci && npm run build on other platforms." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.5+ is required before installing Qagent." >&2
  exit 1
fi

FALLBACK_NODE_BIN="$(command -v node)"
if ! "$FALLBACK_NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)'; then
  echo "Qagent requires Node.js 22.5+; found $("$FALLBACK_NODE_BIN" --version 2>/dev/null || echo unknown) at $FALLBACK_NODE_BIN" >&2
  exit 1
fi

choose_target_dir() {
  if [[ -n "${QAGENT_INSTALL_DIR:-${AGENT_BUS_INSTALL_DIR:-}}" ]]; then
    printf '%s\n' "${QAGENT_INSTALL_DIR:-$AGENT_BUS_INSTALL_DIR}"
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

resolve_home() {
  if [[ -n "${QAGENT_HOME:-}" ]]; then
    printf '%s\n' "$QAGENT_HOME"
    return
  fi
  if [[ -n "${AGENT_BUS_HOME:-}" ]]; then
    printf '%s\n' "$AGENT_BUS_HOME"
    return
  fi
  if [[ -d "$HOME/.qagent" ]] || [[ ! -d "$HOME/.agent-bus" ]]; then
    printf '%s\n' "$HOME/.qagent"
    return
  fi
  printf '%s\n' "$HOME/.agent-bus"
}

TARGET_DIR="$(choose_target_dir)"
BUS_HOME="$(resolve_home)"
APP_ROOT="$BUS_HOME/app"
RELEASES_DIR="$APP_ROOT/releases"
PERSISTENT_CONFIG="$BUS_HOME/config.json"
TMP_DIR="$(mktemp -d)"
STAGE_DIR=""
CURRENT_LINK_NEXT=""
trap 'rm -rf "$TMP_DIR"; [[ -n "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"; [[ -n "$CURRENT_LINK_NEXT" ]] && rm -f "$CURRENT_LINK_NEXT"' EXIT

printf 'Installing Qagent from %s\n' "$ROOT"
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

CURRENT_LINK_NEXT="$APP_ROOT/.current.next.$$"
rm -f "$CURRENT_LINK_NEXT"
ln -s "$RELEASE_DIR" "$CURRENT_LINK_NEXT"
# rename(2) replaces the old symlink atomically on the same filesystem.
"$FALLBACK_NODE_BIN" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$CURRENT_LINK_NEXT" "$APP_ROOT/current"
CURRENT_LINK_NEXT=""

make_wrapper() {
  local name="$1"
  local target="$2"
  cat > "$TMP_DIR/$name" <<EOF
#!/bin/sh
# Qagent canonical launcher
if [ -n "\${QAGENT_HOME:-}" ]; then
  BUS_HOME="\$QAGENT_HOME"
elif [ -n "\${AGENT_BUS_HOME:-}" ]; then
  BUS_HOME="\$AGENT_BUS_HOME"
elif [ -d "\$HOME/.qagent" ] || [ ! -d "\$HOME/.agent-bus" ]; then
  BUS_HOME="\$HOME/.qagent"
else
  BUS_HOME="\$HOME/.agent-bus"
fi
APP_CURRENT="\$BUS_HOME/app/current"
if [ "\${1:-}" = "__launcher-info" ]; then
  printf 'launcher=%s\napplication=%s\nentrypoint=%s\n' "\$0" "\$APP_CURRENT" "\$APP_CURRENT/$target"
  exit 0
fi
node_supported() {
  "\$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)' >/dev/null 2>&1
}
NODE_BIN="\${QAGENT_NODE_BIN:-\${AGENT_BUS_NODE_BIN:-}}"
if [ -n "\$NODE_BIN" ]; then
  if [ ! -x "\$NODE_BIN" ] || ! node_supported "\$NODE_BIN"; then
    echo "Qagent requires Node.js 22.5+; QAGENT_NODE_BIN/AGENT_BUS_NODE_BIN is unsupported: \$NODE_BIN" >&2
    exit 1
  fi
else
  NODE_BIN="\$(command -v node 2>/dev/null || true)"
  if [ -z "\$NODE_BIN" ] || [ ! -x "\$NODE_BIN" ] || ! node_supported "\$NODE_BIN"; then
    NODE_BIN="$FALLBACK_NODE_BIN"
  fi
  if [ ! -x "\$NODE_BIN" ] || ! node_supported "\$NODE_BIN"; then
    echo "Qagent requires Node.js 22.5+; no supported Node binary was found." >&2
    exit 1
  fi
fi
export QAGENT_LAUNCHER_PATH="\$0"
export AGENT_BUS_LAUNCHER_PATH="\$0"
export QAGENT_INSTALL_ROOT="\$APP_CURRENT"
export AGENT_BUS_INSTALL_ROOT="\$APP_CURRENT"
if [ -z "\${QAGENT_CONFIG:-}" ] && [ -z "\${AGENT_BUS_CONFIG:-}" ]; then
  export QAGENT_CONFIG="\$BUS_HOME/config.json"
  export AGENT_BUS_CONFIG="\$BUS_HOME/config.json"
elif [ -z "\${QAGENT_CONFIG:-}" ]; then
  export QAGENT_CONFIG="\$AGENT_BUS_CONFIG"
elif [ -z "\${AGENT_BUS_CONFIG:-}" ]; then
  export AGENT_BUS_CONFIG="\$QAGENT_CONFIG"
fi
exec "\$NODE_BIN" "\$APP_CURRENT/$target" "\$@"
EOF
  chmod 0755 "$TMP_DIR/$name"
}

make_wrapper "qagent" "dist/cli.js"
make_wrapper "qagent-mcp" "dist/mcp-server.js"
make_wrapper "qagent-openai-compatible" "dist/openai-compatible-harness.js"
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

install_one qagent
install_one qagent-mcp
install_one qagent-openai-compatible
install_one agent-bus
install_one agent-bus-mcp
install_one agent-bus-openai-compatible

RESOLVED_AGENT_BUS="$(command -v qagent 2>/dev/null || command -v agent-bus 2>/dev/null || true)"
if [[ -z "$RESOLVED_AGENT_BUS" ]]; then
  echo "Installation completed, but this shell cannot resolve qagent from PATH." >&2
  exit 1
fi
if ! grep -q '# Qagent canonical launcher' "$RESOLVED_AGENT_BUS" 2>/dev/null; then
  echo "A non-Qagent executable shadows the new launcher: $RESOLVED_AGENT_BUS" >&2
  echo "The installer did not overwrite it because it could not safely identify it as Qagent." >&2
  exit 1
fi
LAUNCHER_INFO="$($RESOLVED_AGENT_BUS __launcher-info)"
if [[ "$LAUNCHER_INFO" != *"application=$APP_ROOT/current"* ]]; then
  echo "The resolved launcher does not point to the canonical Qagent installation:" >&2
  printf '%s\n' "$LAUNCHER_INFO" >&2
  exit 1
fi

"$RESOLVED_AGENT_BUS" models >/dev/null

# Retain the active release plus one previous valid immutable release. Unknown,
# malformed, or symlinked entries are deliberately left untouched.
previous_kept=""
while IFS= read -r release_name; do
  [[ "$release_name" == "$ARTIFACT_ID" ]] && continue
  [[ "$release_name" =~ ^[0-9a-f]{20}$ ]] || continue
  release_path="$RELEASES_DIR/$release_name"
  [[ -d "$release_path" && ! -L "$release_path" && -f "$release_path/ARTIFACT_ID" ]] || continue
  [[ "$(cat "$release_path/ARTIFACT_ID" 2>/dev/null || true)" == "$release_name" ]] || continue
  if [[ -z "$previous_kept" ]]; then
    previous_kept="$release_name"
    continue
  fi
  rm -rf -- "$release_path"
done < <(ls -1t "$RELEASES_DIR" 2>/dev/null || true)

printf '\nQagent installed globally:\n'
printf '  resolved launcher: %s\n' "$RESOLVED_AGENT_BUS"
printf '  canonical app:    %s\n' "$APP_ROOT/current"
printf '  artifact:         %s\n' "$ARTIFACT_ID"
printf '\nPersistent state preserved at: %s\n' "$BUS_HOME"
printf 'Run from any directory: qagent start\n'
