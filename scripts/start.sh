#!/usr/bin/env bash
# Bring the whole system up: broker, supervisors, desktop app.
#
#   scripts/start.sh <workdir> [agent ...]     default agents: gpt
#
# Everything runs in the background; use scripts/stop.sh to bring it down.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUS_HOME="${QAGENT_HOME:-${AGENT_BUS_HOME:-$HOME/.qagent}}"
LOGS="$BUS_HOME/logs"
mkdir -p "$LOGS"

WORKDIR="${1:-}"
if [[ -z "$WORKDIR" ]]; then
  echo "usage: scripts/start.sh <workdir> [agent ...]" >&2
  echo "       the workdir is the project your agents will actually work in" >&2
  exit 1
fi
shift
WORKDIR="$(cd "$WORKDIR" && pwd)"
AGENTS=("$@")
[[ ${#AGENTS[@]} -eq 0 ]] && AGENTS=(gpt)

[[ -f "$ROOT/dist/cli.js" ]] || { echo "build first: (cd '$ROOT' && npm run build)" >&2; exit 1; }

PORT="${QAGENT_PORT:-${AGENT_BUS_PORT:-11511}}"
HEALTH="http://127.0.0.1:${PORT}/health"

# 1. broker ------------------------------------------------------------------
if curl -s -m 2 "$HEALTH" >/dev/null 2>&1; then
  echo "broker    · already running"
else
  node "$ROOT/scripts/daemonize.js" "$BUS_HOME/broker.log" "$ROOT/dist/cli.js" broker >/dev/null
  sleep 1.2
  curl -s -m 2 "$HEALTH" >/dev/null 2>&1 \
    && echo "broker    · started" \
    || { echo "broker    ! failed to start, see $BUS_HOME/broker.log" >&2; exit 1; }
fi

# 2. teach the workdir the protocol ------------------------------------------
"$ROOT/scripts/init-workdir.sh" "$WORKDIR" >/dev/null
echo "protocol  · installed in $WORKDIR"

# 3. supervisors -------------------------------------------------------------
for agent in "${AGENTS[@]}"; do
  if pgrep -f "cli.js supervise $agent " >/dev/null 2>&1; then
    echo "$agent · supervisor already running"
    continue
  fi
  node "$ROOT/scripts/daemonize.js" "$LOGS/$agent.out" \
    "$ROOT/dist/cli.js" supervise "$agent" "$WORKDIR" >/dev/null
  sleep 0.6
  echo "$agent · supervised (log: $LOGS/$agent.out)"
done

# 4. desktop app -------------------------------------------------------------
if pgrep -f "MacOS/AgentBus" >/dev/null 2>&1; then
  echo "gui       · already open"
elif [[ -d "$ROOT/gui/AgentBus.app" ]]; then
  open "$ROOT/gui/AgentBus.app"
  echo "gui       · opened"
else
  echo "gui       · not built (run scripts/build-gui.sh)"
fi

sleep 1.5
echo
node "$ROOT/dist/cli.js" status
echo
echo "Give the agents work from the desktop app's bottom bar:"
echo "  · 'Assign task' mode, to = ${AGENTS[0]}, write the brief, hit Assign."
echo "  · The supervisor wakes the agent, it works, and reports back."
echo "  · Click the task in the right pane to accept it or request changes."
echo
echo "Stop everything with: scripts/stop.sh"
