# Agent Bus Dashboard

A small local web page for an existing AgentBus or Agent Coordinator install. It lists your projects, shows which agents are attached to each one and what they are doing, and lets you read and send their messages. One Python file, standard library only, no build step, no accounts. Python 3.9 or newer. macOS is only needed for the "open session in Terminal" button.

It does not start a broker or an agent. If nothing is running, it says so.

## Run it

```sh
python3 scripts/dashboard_server.py
```

Open http://127.0.0.1:8788, go to **Local setup**, enter the folder your projects live in (say `~/Projects`), and save. Every folder directly under it becomes a project, plus any nested git repositories. Open a project to see its agents and conversations.

Agents show up on a project when an AgentBus supervisor is running with that project's folder as its workdir. The setup page shows whether the broker is reachable. If it is not, start the broker the way you normally do.

## Where things come from

- **Live broker**, `http://127.0.0.1:7717` by default. Roster, status, usage, and tasks.
- **Coordinator database**, optional. Agents, tasks, and messages from a `prototype` install.
- **AgentBus history database**, optional. Old messages from `agentcomms.db`.
- **AgentBus folder**, default `~/.agent-bus`. Where `agents.json` and the supervisor scripts are.

All of these are read in place. The dashboard never creates, migrates, or rewrites them. The one exception: editing a registered agent's role writes that one field back to `agents.json`, because the supervisor reads it there.

Do not point the broker URL at the dashboard's own port. It refuses to save that, and if an old config still has it, it shows a warning instead of looping.

## Configuration

Setup saves to `~/.agent-bus/dashboard.json` with mode 0600. Pick another file with `--config` or `AGENT_DASHBOARD_CONFIG`. Every key also works as a `--kebab-case` flag or an `AGENT_DASHBOARD_UPPER_CASE` environment variable, and those win over the file. `~` expands. Set an optional path to `null`, or clear it in setup, to turn it off.

```json
{
  "projects_root": ["~/Projects"],
  "live_bus_url": "http://127.0.0.1:7717",
  "agent_bus_root": "~/.agent-bus"
}
```

| Key | Default |
| --- | --- |
| `projects_root` | `["~/Projects"]` |
| `live_bus_url` | `http://127.0.0.1:7717` |
| `agent_bus_root` | `~/.agent-bus` |
| `coordinator_db` | `~/.agent-bus/coordinator.db` |
| `coordinator_cli` | `~/.agent-bus/bin/prototype` |
| `agent_bus_db` | `~/.agent-bus/agentcomms.db` |
| `agent_bus_cli` | `~/.agent-bus/agent_comms_server.py` |
| `status_dir` | `~/.agent-bus/status` |
| `operator_token` | `~/.agent-bus/operator.token` |
| `audit_log` | `~/.agent-bus/bus.jsonl` |
| `dashboard_state` | `~/.agent-bus/dashboard-state.json` |
| `host`, `port` | `127.0.0.1`, `8788` |

Pins, hidden projects, roles, and archived or trashed conversations are kept in `dashboard-state.json`. Archiving or trashing a conversation only changes that file; the source databases are untouched and Restore brings it back.

Restart the server after editing the Python. CSS and JS changes show up on reload.

## Using it

- **Projects.** Pin the ones you use, hide the rest. Both apply to the register and the dock. `/` focuses search. `g p`, `g o`, `g a`, `g m` jump to projects, overview, agents, and messages.
- **Agents.** Each row is titled by the agent's role and shows its model and reasoning effort, status, current activity, token usage, and controls. Raw ids are under the Identifiers toggle. Start, Stop, and Open latest session only happen when you click them.
- **Conversations.** Inbox, Archived, Trash. Roles on conversations are notes for you and nothing else reads them.
- **Themes.** Light, Dark, and Evil. Evil uses the bundled Cloister Black face and the painted cat.
- **Usage** covers the current broker session and resets when the broker does. The cost column is an estimate, not a bill.

The server binds to loopback and has no login. If you pass `--host` to bind elsewhere, put your own access control in front of it.

## As a plugin

The folder is also a Claude Code plugin. Install it through the normal local-plugin flow and you get the skill plus two MCP launchers, `mcp_launcher.py coordinator` and `mcp_launcher.py bus`, which start your installed coordinator or bus server with the same configuration as the dashboard. They do not add a server of their own. Set `AGENT_DASHBOARD_AGENT_ID` to give each host its own identity on the bus.

## Check

```sh
python3 scripts/dashboard_server.py --check
```

Renders every configured source and runs the role, CSRF, folder-state, configuration, and broker-loopback tests against a throwaway server. Use `--dashboard-state` with a scratch file when you try things in the browser and do not want to disturb your real pins and folders.
