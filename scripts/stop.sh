#!/usr/bin/env bash
# Bring the system down. Leaves ~/.agent-bus logs in place.
set -uo pipefail

stopped=0
for pat in "cli.js supervise" "cli.js broker"; do
  if pgrep -f "$pat" >/dev/null 2>&1; then
    pkill -f "$pat" && echo "stopped   · $pat"
    stopped=1
  fi
done

if [[ "${1:-}" == "--all" ]]; then
  pkill -f "MacOS/AgentBus" 2>/dev/null && echo "stopped   · desktop app"
fi

[[ $stopped -eq 0 ]] && echo "nothing was running"
echo "(desktop app left open; use --all to close it too)"
