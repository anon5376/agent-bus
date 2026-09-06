#!/usr/bin/env python3
"""Launch an installed coordination server using the dashboard's portable config."""
import os
import sys
from dashboard_server import parse_settings


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"coordinator", "bus"}:
        raise SystemExit("Usage: mcp_launcher.py coordinator|bus")
    try:
        settings = parse_settings([])
    except ValueError as error:
        raise SystemExit(str(error)) from error
    identity = os.environ.get("AGENT_DASHBOARD_AGENT_ID", "codex")
    if sys.argv[1] == "coordinator":
        command = settings.coordinator_cli
        args = [str(command), "--db", str(settings.coordinator_db), "mcp", "--agent-id", identity]
        os.environ["COORD_AGENT_ID"] = identity
        if settings.coordinator_db is None:
            raise SystemExit("Coordinator database not configured. Open Local setup.")
        workdir = settings.coordinator_db.parent
    else:
        if settings.agent_bus_db is None:
            raise SystemExit("AgentBus history database not configured. Open Local setup.")
        command = settings.agent_bus_cli
        args = [sys.executable, str(command)]
        os.environ["AGENT_COMMS_DB"] = str(settings.agent_bus_db)
        os.environ["AGENT_COMMS_ID"] = identity
        workdir = command.parent if command else None
    if command is None or not command.is_file():
        raise SystemExit("Source not configured. Open the dashboard's Local setup or edit ~/.agent-bus/dashboard.json.")
    os.chdir(workdir)
    os.execv(args[0], args)


if __name__ == "__main__":
    main()
