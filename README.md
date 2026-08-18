# agent-bus

A local-first control plane for heterogeneous autonomous coding and research agents.

Agent Bus keeps independent model CLIs behind one durable broker: SQLite persistence, task DAGs, routing, supervisors, MCP, path leases, authentication, retries, reviews, telemetry, and project runs remain the orchestration engine. The browser dashboard and CLI are interfaces over that same state.

## Quick start

Requires macOS and Node.js 22.5 or newer.

```bash
git clone https://github.com/anon5376/agent-bus.git
cd agent-bus
npm run install:global
agent-bus start
```

`npm run install:global` does the full local installation:

- stops previous Agent Bus broker/dashboard/supervisor processes from older checkouts
- removes stale `agent-bus`, `agent-bus-mcp`, and `agent-bus-openai-compatible` global launchers
- runs `npm install` and builds the TypeScript broker plus React/Vite dashboard
- installs stable launchers into `/usr/local/bin`, using `sudo` only when that directory requires it
- preserves `~/.agent-bus`, including operator/agent credentials, SQLite state, run history, logs, and configuration

After installation, `agent-bus` can be launched from any directory. Re-running the installer replaces the previous installation rather than stacking another one.

`agent-bus start` starts or reuses the current localhost product server and opens the dashboard at:

```text
http://127.0.0.1:7717
```

`agent-bus start` also detects and replaces an incompatible legacy broker/dashboard process before launching the current product server. Use `agent-bus stop` to terminate the broker/dashboard and supervised agents, and `agent-bus open` to open an already-running dashboard.

Directly visiting the dashboard URL does not grant operator privileges. The CLI issues a short-lived one-time browser login ticket derived from the private local operator credential.

Each real provider CLI must still be installed and authenticated through its own normal login flow. Finding a binary proves only that the executable exists. It does not prove subscription entitlement, login state, quota, or access to a particular model.

## Product surface

The React + TypeScript + Vite dashboard is served by the broker itself. There is no second orchestration backend and no separate dashboard port.

The dashboard exposes real SQLite-backed Agent Bus state for:

- local projects and previous runs
- run creation and run stop
- agents, roles, providers, harnesses, exact models and model families
- idle / working / waiting / failed / offline status
- task hierarchy, dependencies, submissions, reviews, retries and failures
- routing decisions and candidate explanations
- live events/messages over Server-Sent Events at `/api/events`
- token, turn, latency and reported cost telemetry
- start/stop agent and STOP ALL controls
- accept task, request changes and cancel task controls
- operator messages
- agent configuration without manually editing JSON

Ordinary agent configuration changes are validated, persisted to the configured JSON registry, and applied to the running broker. Provider status deliberately distinguishes configured integrations, executable discovery, authentication source, and live verification.

## CLI

```text
agent-bus start [--no-open]               start/reuse Agent Bus and open the dashboard
agent-bus open                            create a browser session and open the dashboard
agent-bus stop                            stop broker/dashboard and supervised agents
agent-bus run <project> --goal "..."      create a durable project run
agent-bus broker                          run the localhost product server in foreground
agent-bus provision <agent-id> [--rotate] provision/rotate an agent credential
agent-bus supervise <agent-id> [workdir]  run one persistent supervisor
agent-bus route <role> [options]          preview an inspectable routing decision
agent-bus models [--discover]             inspect configured/discovered models
agent-bus doctor                          probe harness executables only
agent-bus status                          one-shot state view
agent-bus watch                           terminal live view
agent-bus usage                           usage and latency totals
agent-bus send <to> <subject> [body]      send an operator message
```

The old broker/MCP HTTP routes remain available on the same localhost server, so existing supervisors, MCP clients and CLI commands operate on exactly the same state as the dashboard.

## Browser authentication

The browser never receives the raw operator token.

1. The broker keeps the operator credential in its private local token file and SQLite stores only its hash.
2. `agent-bus start` or `agent-bus open` authenticates locally and requests a random, short-lived one-time browser ticket.
3. The ticket is placed in the localhost URL and exchanged once for an HttpOnly `SameSite=Strict` session cookie.
4. The ticket is immediately invalidated and removed from browser history with `history.replaceState`.
5. Mutation APIs additionally require a matching same-origin `Origin` header.

Simply requesting `/` or `/api/*` from another localhost process does not mint operator authority.

## Projects and runs

Add a local project path in the dashboard or start directly from the CLI:

```bash
agent-bus run ~/code/project --goal "Implement X and validate it"
```

Runs, tasks, messages, routing decisions, path leases and telemetry are persisted in SQLite. Recent projects are derived from durable runs plus explicitly added project paths.

Stopping a run marks it cancelled and cancels every open task in that run through the broker's existing cancellation path.

## Agents and models

The repository registry preserves the existing hierarchy:

```text
Provider → Harness → Model → Family → Agent → Role
```

The dashboard agent editor covers normal configuration including model, exact model selector, model family, role, reasoning/effort controls, permissions, enabled state and auto-start. Saved changes update the JSON registry and live broker roster; agent credentials are never exposed to React.

Custom command and OpenAI-compatible endpoint integrations remain available through the config-driven integration layer. Raw text endpoints are intentionally not promoted to manager/reviewer agents because they lack the Agent Bus tool contract.

## Provider status

`agent-bus doctor` and the dashboard probe executables. They do **not** infer account entitlement from that result.

Status is intentionally separated into:

- configured/enabled
- CLI executable found or unavailable
- authentication source: subscription, API profile, or local runtime
- live verification unknown/not required
- safely discovered models where the harness exposes enumeration

Real provider verification remains dependent on the installed CLI version, authenticated account, quota and exact model access.

See [`docs/provider-support.md`](docs/provider-support.md) for the support matrix.

## Runtime architecture

```text
browser dashboard / CLI / MCP
             │
             ▼
127.0.0.1:7717
single Agent Bus HTTP server
             │
             ├── React production assets
             ├── /api/* + SSE /api/events
             └── existing broker protocol routes
                       │
                       ▼
          BrokerService / SQLite / router
                       │
                 supervisors
                       │
           normalized harness adapters
```

The browser does not own task, agent, run, routing or authorization state.

## Validation

```bash
npm test
```

Automated tests use deterministic fake harnesses and do not consume Claude/OpenAI/Gemini/Kimi/etc. usage. Coverage includes the original routing/orchestration tests plus SPA serving, dashboard authentication, one-time ticket replay prevention, same-origin mutation enforcement, projects/runs, run stop, SSE, live agent configuration and malformed requests.

CI is defined in [`.github/workflows/universal-harness-ci.yml`](.github/workflows/universal-harness-ci.yml).

## Security and limitations

Agent Bus binds to `127.0.0.1` by default. It does not silently bind to `0.0.0.0`.

Path leases coordinate writes but are not an OS sandbox. Powerful coding CLIs may have wider host permissions than their task contract, depending on harness settings.

Real provider subscriptions are not exercised by CI. Claude Code, Codex, Gemini, Kimi and OpenCode therefore remain live-unverified against your specific local accounts until tested on the target Mac.

See:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/provider-support.md`](docs/provider-support.md)
- [`docs/security.md`](docs/security.md)
