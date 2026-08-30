#!/usr/bin/env bash
# One-time wiring for the CLIs that read MCP servers from a persistent config
# file (kimi, gemini). Claude Code and Codex are configured per-launch by
# bin/agent-bus-launch and need nothing here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/dist/mcp-server.js"
NODE="$(command -v node)"

[[ -f "$SERVER" ]] || { echo "build first: (cd '$ROOT' && npm run build)" >&2; exit 1; }

# ---------------------------------------------------------------- kimi
# kimi-code reads MCP servers from mcp.json (NOT config.toml) with a camelCase
# `mcpServers` wrapper — the Claude-style format. They load at session start.
KIMI_HOME="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
KIMI_MCP="$KIMI_HOME/mcp.json"
if command -v kimi >/dev/null 2>&1; then
  mkdir -p "$KIMI_HOME"
  node -e '
    const fs = require("fs");
    const [path, node, server] = process.argv.slice(1);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers["qagent"] = cfg.mcpServers["agent-bus"] = {
      command: node,
      args: [server],
      env: {
        AGENT_ID: "kimi", AGENT_ROLE: "worker", AGENT_MODEL: "kimi-k3",
        AGENT_DESC: "Kimi K3 via kimi-code", AGENT_HARNESS: "kimi",
        AGENT_AUTH: "Kimi subscription",
      },
      enabled: true,
    };
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
  ' "$KIMI_MCP" "$NODE" "$SERVER"
  echo "kimi   · wrote agent-bus to $KIMI_MCP (mcpServers format)"
fi

# ---------------------------------------------------------------- gemini
if command -v gemini >/dev/null 2>&1; then
  gemini mcp remove agent-bus --scope user >/dev/null 2>&1 || true
  gemini mcp add agent-bus "$NODE" "$SERVER" \
    --scope user --transport stdio --timeout 300000 \
    -e AGENT_ID=gem -e AGENT_ROLE=worker -e AGENT_MODEL=gemini \
    -e "AGENT_DESC=Worker 3. Optional." >/dev/null
  echo "gemini · registered agent-bus (user scope)"
fi

echo
echo "Done. Claude Code and Codex are wired at launch time — nothing persistent to install."
echo "Start agents with:  $ROOT/bin/agent-bus-launch <fable5|gpt|kimi|gem> [workdir]"
