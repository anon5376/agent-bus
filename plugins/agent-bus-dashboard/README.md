# Agent Bus Dashboard

A local project register, agent roster, and conversation ledger for existing Agent Coordinator and AgentBus installations. Python 3.10 or newer, standard library only. No account, build step, or runtime packages. macOS is required only for opening harness sessions in Terminal.

## Start in one minute

Copy or clone this plugin directory anywhere you own. From its root:

```sh
python3 scripts/dashboard_server.py
```

On macOS you can also use `./scripts/run_dashboard.sh`. Open [127.0.0.1:8788](http://127.0.0.1:8788/). Choose **Local setup**, enter an existing projects folder such as `~/Projects`, and click **Save local setup**. Each immediate subfolder becomes a project; nested repositories with recognized project markers are included too. Saving refreshes discovery without restarting a supervisor.

Open a project, then **Agents** or **Conversations**. Empty projects are valid. Agents appear when your existing AgentBus supervisors use that exact project folder as their workdir. The dashboard does not install or launch a broker. Check **Local setup → Connections** to see whether the live broker is connected. If disconnected, start your existing AgentBus broker using its own installation instructions.

Success looks like: the projects register contains your folders; Local setup shows the sources you attached; Agents shows identities attached to the selected workdir; Conversations shows their messages. [Health](http://127.0.0.1:8788/health) reports the dashboard process and source summaries, not a guarantee that all optional services are online.

## Optional sources

The default live broker is `http://127.0.0.1:7717`. Local setup accepts:

- Coordinator SQLite database and optional `prototype` executable.
- AgentBus history SQLite database and optional `agent_comms_server.py`.
- AgentBus implementation folder, containing your existing `agents.json` and supervisor scripts.
- Optional AgentBus status folder.

Use your existing installation paths. Missing optional databases are omitted from the register; unavailable configured files can be corrected in Local setup. A readable but incompatible database is reported as unreadable. The dashboard does not create or migrate these stores.

## Configuration

Saved privately with mode `0600` in `~/.agent-bus/dashboard.json`. Choose another file with `--config /absolute/path/dashboard.json` or `AGENT_DASHBOARD_CONFIG`. Paths support `~`. Set an optional database, command, or status path to `null` to disable it; clearing that field in Local setup does the same. Clearing the implementation folder restores `~/.agent-bus`.

```json
{
  "projects_root": ["~/Projects"],
  "live_bus_url": "http://127.0.0.1:7717",
  "agent_bus_root": "~/.agent-bus"
}
```

Precedence: command-line flags → `AGENT_DASHBOARD_*` environment variables → JSON file → defaults. An explicit `--projects-root` replaces configured roots; repeat the flag for multiple roots. Environment roots use the platform path separator (`:` on macOS). A setup save cannot override a launch flag or environment variable.

| JSON key | Default |
| --- | --- |
| `projects_root` | `["~/Projects"]` |
| `coordinator_db` | `~/.agent-bus/coordinator.db` |
| `coordinator_cli` | `~/.agent-bus/bin/prototype` |
| `agent_bus_db` | `~/.agent-bus/agentcomms.db` |
| `agent_bus_cli` | `~/.agent-bus/agent_comms_server.py` |
| `status_dir` | `~/.agent-bus/status` |
| `agent_bus_root` | `~/.agent-bus` |
| `live_bus_url` | `http://127.0.0.1:7717` |
| `operator_token` | `~/.agent-bus/operator.token` (path only) |
| `audit_log` | `~/.agent-bus/bus.jsonl` |
| `dashboard_state` | `~/.agent-bus/dashboard-state.json` |
| `host`, `port` | `127.0.0.1`, `8788` |

For each key use a hyphenated CLI option or uppercase environment name, e.g. `--coordinator-db` / `AGENT_DASHBOARD_COORDINATOR_DB`. Never put token contents in the config. Invalid JSON or keys produce a configuration error at startup; fix the indicated file and restart the dashboard. Stop the foreground dashboard with Ctrl-C. Restart only the dashboard after server-code changes.

## Agent plugin integration

The dashboard runs independently of a plugin host. Add this directory through your host's local plugin workflow to use the included skill and optional MCP launchers. The manifest uses the host's `${CLAUDE_PLUGIN_ROOT}` substitution. For hosts that do not support that substitution, register `python3 /absolute/plugin/path/scripts/mcp_launcher.py coordinator` and `python3 /absolute/plugin/path/scripts/mcp_launcher.py bus` manually. Both launch your installed services with the same dashboard configuration; they add no coordination backend. Unconfigured launchers exit with setup guidance. Only enable the sources you actually use.

Set `AGENT_DASHBOARD_AGENT_ID` for each host's identity (default `codex`). Do not change another host's identity. Outbound agent messages require explicit authorization, a sender label, and a reply path.

## Daily use and boundaries

- Pin projects for repeat access. Search from the register or rail. `/` focuses search; `g p`, `g a`, and `g m` open projects, agents, and conversations. Tab and Enter operate controls.
- Light and Dark are monochrome; EVIL uses parchment and crimson. Theme and Hide/Show rail persist in the browser.
- Conversation roles are operator metadata. Expand **Add role** to edit. Archive, Move to Trash, and Restore remain visible beneath it. Both folders are reversible; Restore returns a conversation to Inbox.
- Pins, roles, and folder state live in `dashboard-state.json`. Archive and Trash never rewrite source databases or the audit log. Registered AgentBus role edits update only that identity's role in `agents.json`.
- Usage is for the current broker session. Equivalent cost is an estimate, not an added subscription charge. A disconnected broker retains last-known values marked stale.
- Start, stop, open session, and send are explicit actions. Reading a page never performs them. Open session is available only for an unambiguous resumable harness identity.
- This is an unauthenticated local control plane, not a hosted service. The default bind is loopback. Explicit `--host` can opt into another interface; do so only with your own access protections. Broker connections stay loopback-only.

## Verify

```sh
python3 scripts/dashboard_server.py --check
```

The checker renders available sources and validates isolated role persistence, CSRF, reversible folder state, configuration, first-run guidance, and unknown state-key preservation. Missing optional sources and an empty projects root are valid. Browser verification should use an isolated `--dashboard-state` file for reversible actions when preserving an operator's live folder state matters.
