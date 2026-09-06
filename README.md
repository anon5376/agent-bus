# Qagent

Qagent runs several coding-agent CLIs (Claude Code, Codex, Cursor, Gemini, Kimi, Grok, OpenCode, Hermes) as a team on one machine. A broker keeps their tasks, messages, and state in SQLite. Supervisors keep each agent alive and feed it work. A dashboard, a CLI, and an MCP server let you watch and steer. `agent-bus` is the old name and still works as an alias.

Everything runs on localhost. Nothing is sent anywhere except through the provider CLIs you have already logged in to.

## Install

macOS, Node 22.5 or newer.

```bash
git clone https://github.com/anon5376/agent-bus.git
cd agent-bus
npm run install:global
```

The installer builds the project, puts a release under `~/.qagent/app/releases`, points `~/.qagent/app/current` at it, and installs `qagent` (and `agent-bus`) somewhere on your `PATH`. You can delete the clone afterwards. Re-running it swaps in a new release and keeps your config, credentials, logs, and database. If you already had `~/.agent-bus`, it keeps using that.

## Start

```bash
qagent start
```

This starts the broker if it is not running and opens the dashboard at `http://127.0.0.1:11511`. The URL alone does not log you in: `qagent start` and `qagent open` mint a one-time ticket that becomes a session cookie, so the operator token never reaches the browser.

The first visit lands on **Setup**. It scans for installed provider CLIs, lets you add the ones it found, and lets you point at a binary by hand for the ones it did not. Then name your agents and drag workers onto a manager to say who may create work for whom. Each provider still has to be logged in through its own CLI (`claude auth login`, `codex login`, and so on). Finding the binary only proves it exists.

Give the team something to do:

```bash
qagent run ~/code/project --goal "Implement X and validate it"
```

or add the project in the dashboard and start a run from there. Runs, tasks, messages, routing decisions, and telemetry all land in SQLite, so the dashboard shows the same thing after a restart.

## What the dashboard shows

Projects and past runs, the agents with their status and model, the task tree with dependencies and reviews, why the router picked whom, live events over SSE, and token, turn, latency, and cost figures. From it you can start and stop agents, accept work or send it back, cancel tasks, message an agent, and edit agent configuration. The dashboard is served by the broker itself. There is no second server and no second port.

**Appearance** under Settings lets you pick colours for the page, panels, text, and accents.

## CLI

```text
qagent start [--no-open]        start or reuse the broker and open the dashboard
qagent open                     open the dashboard in a new session
qagent stop                     stop the broker and every supervised agent
qagent run <project> --goal ... create a run
qagent status                   one-shot view of agents and tasks
qagent watch                    live terminal view
qagent usage                    token, turn, and latency totals
qagent send <to> <subject>      message an agent as the operator
qagent supervise <agent> [dir]  run one supervisor in the foreground
qagent provision <agent>        create or rotate an agent credential
qagent route <role>             preview a routing decision
qagent models [--discover]      list configured and discovered models
qagent doctor                   check which harness binaries exist
qagent runtime [--json]         show what is installed and running
qagent broker                   run the broker in the foreground
qagent mcp-config               print MCP client configuration
qagent operator-mcp             run the operator MCP server over stdio
```

## Driving it from another assistant

Any local MCP client can operate Qagent without the dashboard. Print the config and paste it into the client:

```bash
qagent mcp-config
```

The `qagent_*` tools cover the same ground as the dashboard: inspect the catalog, start the instance, create or execute a run, delegate a task, wait for state changes, review, cancel, and fetch artifacts. So a chat in one assistant can say "use Qagent to fix the failing tests in `~/code/foo`", and the router picks a manager and workers from your configured agents. The operator MCP reads the operator credential from disk and never returns it. Supervised agents get a separate, smaller tool set and no operator powers.

This is stdio only. A hosted chat service cannot reach your localhost. If you want that, you set up and secure the tunnel yourself. Qagent never binds to anything but `127.0.0.1` unless told to.

## Agents, models, and sessions

The registry is a JSON file organised as provider, harness, model, family, agent, role. The dashboard editor covers all of it, including exact model, reasoning effort, permissions, auto-start, and the session to resume. Saving updates the file and the running broker.

By default a supervisor starts a fresh session on the first turn, records the session id the harness created, and resumes that exact session afterwards. Set `resumeSessionId` on an agent if bus mail should instead wake a chat you already have open. Each adapter knows its own resume syntax:

| Harness | Resume |
|---|---|
| Codex | `codex queue --thread <id>` for a pinned Desktop or TUI thread, `codex exec resume <id>` for managed runs |
| Claude Code | `claude --resume <id>` |
| Cursor | `agent --resume <chat-id>` |
| OpenCode (including Z.AI and GLM) | `opencode run --session <id>` |
| Hermes | `hermes chat --resume <id>` |
| Grok | `grok --resume <id>` |
| Kimi | `kimi --session <id>` |
| Gemini CLI | `gemini --resume <latest-or-index>` |

If a harness opens a different session than the one pinned, the turn fails and the binding is left alone. Codex runs with sandboxing off because sandboxed Codex kills stdio MCP calls before the broker can apply the agent's bus permissions.

For a CLI that has no adapter, use `adapter: "command"` and give both forms:

```json
{
  "harnessOptions": {
    "args": ["run", "--prompt", "{prompt}"],
    "resumeArgs": ["run", "--resume", "{session}", "--prompt", "{prompt}"]
  }
}
```

Provider status in the dashboard and in `qagent doctor` separates "binary found" from "logged in" from "model actually available". Finding a binary proves nothing about your account. See [`docs/provider-support.md`](docs/provider-support.md).

## How it fits together

```text
browser / CLI / MCP client
          │
          ▼
127.0.0.1:11511  one HTTP server
          ├── dashboard assets
          ├── /api/*  and  /api/events (SSE)
          └── broker routes used by supervisors and agents
                      │
                      ▼
        BrokerService · SQLite · router
                      │
                 supervisors
                      │
              harness adapters
```

The browser holds no state of its own. `index.html` is never cached, hashed assets are cached forever, and `/api` paths never fall back to HTML. At startup the CLI checks the served HTML, JS, and CSS against the installed release before opening a browser ticket, and replaces a stale Qagent on the port while leaving an unrelated process alone.

## Development

```bash
npm ci
npm audit --audit-level=high
npm test
```

`npm test` builds, checks that `dist` matches the source, then runs unit, browser, and lifecycle tests. The tests use fake harnesses and do not spend any provider quota. CI is in [`.github/workflows/universal-harness-ci.yml`](.github/workflows/universal-harness-ci.yml). The lockfile is authoritative; CI runs `npm ci` and never changes dependencies.

There is also a standalone Python dashboard plugin for older Agent Coordinator and AgentBus installs under [`plugins/agent-bus-dashboard`](plugins/agent-bus-dashboard/README.md).

## Limits

Path leases stop two agents writing the same files at once. They are not a sandbox: a coding CLI has whatever access its own settings give it. Real provider accounts are not exercised in CI, so a given CLI is only known to work once you have tried it on your machine.

More in [`docs/architecture.md`](docs/architecture.md) and [`docs/security.md`](docs/security.md).
