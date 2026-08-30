# Qagent

A local-first control plane for heterogeneous autonomous coding and research agents.

Qagent keeps independent model CLIs behind one durable broker: SQLite persistence, task DAGs, routing, supervisors, MCP, path leases, authentication, retries, reviews, telemetry, and project runs remain the orchestration engine. The browser dashboard, CLI, and operator MCP server are interfaces over that same state.

## Quick start

Requires macOS and Node.js 22.5 or newer.

```bash
git clone https://github.com/anon5376/agent-bus.git
cd agent-bus
npm run install:global
cd ~
qagent start
```

`agent-bus` remains an alias for `qagent`. `npm run install:global` performs a reproducible global installation:

- runs `npm ci`
- compiles the lifecycle code, safely stops any identifiable previous Qagent instance, then builds the production React/Vite dashboard
- refuses to kill an unrelated application merely because it owns port `11511`
- packages the completed runtime into an immutable release under `~/.qagent/app/releases/<artifact-id>` (existing `~/.agent-bus` homes are reused)
- atomically switches `~/.qagent/app/current` to that release, so a running broker can never observe a half-rebuilt frontend tree
- finds positively identified stale `qagent` / `agent-bus` launchers throughout the current `PATH` and common Homebrew/npm/nvm/pnpm/yarn locations
- replaces stale launchers at their exact existing paths, including earlier `PATH` entries that a parent shell may already have cached
- installs stable canonical launchers into an existing executable directory already on `PATH`
- preserves `~/.qagent` (or a pre-existing `~/.agent-bus`) credentials, SQLite state, run history, logs, and configuration

The canonical launchers resolve the active Node executable at invocation time, with the installer’s Node path as a fallback. They point to `~/.qagent/app/current` (or the reused `~/.agent-bus` home), not to the clone, so the checkout can be moved or deleted after installation. Re-running the installer atomically replaces the installed release rather than stacking another mutable checkout.

`qagent start` starts or reuses the exact installed localhost product and opens:

```text
http://127.0.0.1:11511
```

Before opening the browser, the CLI verifies the running product identity, application root, static root, build ID, MIME types, and SHA-256 hashes of the served HTML/JS/CSS against the installed release. A different or legacy Qagent instance is replaced safely. An unrelated port owner is preserved and reported.

Use these diagnostics to inspect the exact installed and running product:

```bash
qagent __launcher-info
qagent runtime --json
```

The runtime report includes the resolved launcher, immutable application release, PID, process entrypoint, working directory, Node binary/version, build ID, static root, and exact HTML/JS/CSS URLs, sizes, and SHA-256 hashes.

Directly visiting the dashboard URL does not grant operator privileges. `qagent start` and `qagent open` issue a short-lived one-time browser ticket derived from the private local operator credential.

The first authenticated visit opens `/setup`. Installed provider CLIs are scanned and can be added automatically. Missing CLIs can still be wired with a binary path and the provider's login command. You name agents yourself and drag workers onto a manager to choose who that manager may create. **Appearance** on the Settings page lets you pick a color preset or any hex color for page, panels, text, and accents; the dashboard updates immediately and the theme is stored in the local config. After **Open dashboard**, later visits go to the run view. **Settings** in the header returns to configuration. Existing buses that already have runs are not forced through setup again.

Each real provider CLI must still be installed and authenticated through its own login flow (`claude auth login`, `codex login`, `agent login`, `grok login`, and so on). Finding a binary proves only executable availability.

To delegate from another chat (for example GPT 5.6 asking Qagent to send work to Claude via Anthropic or Grok via Cursor), attach the operator MCP from `qagent mcp-config` and call `qagent_delegate` with `agent` / `exactModel` / `provider` / `harness`.

## Product surface

The React + TypeScript + Vite dashboard is served by the broker itself. There is no second orchestration backend and no separate dashboard port.

The dashboard exposes real SQLite-backed Qagent state for:

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

Ordinary agent configuration changes are validated, persisted to the configured JSON registry, and applied to the running broker. Provider status deliberately distinguishes configured integrations, executable discovery, authentication source, authentication/entitlement uncertainty, live verification, and safely discovered models.

## CLI

```text
qagent start [--no-open]               start/reuse Qagent and open the dashboard
qagent open                            create a browser session and open the dashboard
qagent stop                            stop broker/dashboard and supervised agents
qagent runtime [--json]                show exact installed/running runtime identity and asset hashes
qagent run <project> --goal "..."      create a durable project run
qagent broker                          run the localhost product server in foreground
qagent provision <agent-id> [--rotate] provision/rotate an agent credential
qagent supervise <agent-id> [workdir]  run one persistent supervisor
qagent operator-mcp                    run the local operator MCP server over stdio
qagent mcp-config                      print stable local MCP client configuration
qagent route <role> [options]          preview an inspectable routing decision
qagent models [--discover]             inspect configured/discovered models
qagent doctor                          probe harness executables only
qagent status                          one-shot state view
qagent watch                           terminal live view
qagent usage                           usage and latency totals
qagent send <to> <subject> [body]      send an operator message
```

The existing broker routes remain available on the same localhost server, so supervisors, MCP clients and CLI commands operate on exactly the same state as the dashboard.

## ChatGPT and local MCP assistants

The dashboard is optional. A compatible local MCP client can operate the same Qagent instance directly:

```bash
qagent mcp-config
```

Add the emitted `mcpServers.qagent` entry to the MCP-capable desktop/local assistant client. The generated command uses the installed canonical `qagent` launcher (or the `agent-bus` alias) and the persistent Qagent home/config, so it survives checkout movement or deletion and immutable release switches. It never contains the operator token.

The operator MCP exposes these high-level tools:

```text
qagent_status          inspect the configured instance without starting it
qagent_catalog         inspect agents, roles, providers, harnesses and models
qagent_start           safely start or reuse the exact configured instance
qagent_create_run      create a durable routed project run
qagent_execute         create a run, start its routed supervisor and wait for progress
qagent_delegate        create a routed child task in the normal task DAG
qagent_message         send an operator message
qagent_task            inspect one task, routing, history and result
qagent_run             inspect a run and its complete task graph
qagent_wait            block on broker state revisions instead of busy-polling
qagent_review          accept work or request a revision
qagent_cancel          cancel a task or run
qagent_artifacts       retrieve concise artifact/change/validation references
qagent_agent_start     start a verified supervisor
qagent_agent_stop      stop a fingerprint-verified supervisor
```

For example, a local assistant can receive “Use Qagent to fix the failing tests in `~/code/foo`”, call `qagent_execute`, let the existing router select the manager/worker, wait on broker state notifications, inspect/review the result, and report back without opening the dashboard. Opening the dashboard later shows the exact same run IDs, tasks, agents, events and SQLite-backed state. Dashboard actions and MCP actions affect each other because there is only one `BrokerService`.

`qagent operator-mcp` is an operator client. It reads the private operator credential from local storage and never returns it. The separate `qagent-mcp` worker server still requires an individual agent credential and exposes only worker-authorized `bus_*` tools; supervised models do not receive operator tools.

This is a local stdio integration. A purely cloud-hosted ChatGPT session cannot directly reach arbitrary localhost services. Use an MCP-capable desktop/local connector environment. Remote exposure requires an explicit authenticated bridge or tunnel selected and secured by the user; Qagent does not bind publicly or create one automatically.

## Browser authentication and boot diagnostics

The browser never receives the raw operator token.

1. The broker keeps the operator credential in its private local token file and SQLite stores only its hash.
2. `qagent start` or `qagent open` authenticates locally and requests a random, short-lived one-time browser ticket.
3. The ticket is placed in the localhost URL and exchanged directly for an HttpOnly `SameSite=Strict` session cookie.
4. The ticket is invalidated and removed from browser history whether exchange succeeds or fails.
5. Mutation APIs additionally require a matching same-origin `Origin` header.

The production HTML has a browser-independent boot screen and ten explicit checkpoints:

```text
1  index HTML loaded
2  entry module loaded
3  app module imported
4  React runtime loaded
5  createRoot returned
6  render returned
7  first React component executed
8  ticket/session request started
9  ticket/session request completed
10 dashboard mounted
```

The classic boot monitor loads before the ES module. It records resource failures, JavaScript exceptions, unhandled promise rejections, CSP violations, bfcache restores, Cache Storage, service-worker control, runtime identity, and a boot timeout. The React error boundary covers component failures. Any failed stage produces an on-page diagnostic containing the last completed checkpoint and runtime metadata instead of a silent empty root.

Qagent does not register a service worker. The boot monitor removes stale registrations and Cache Storage left by any older localhost build before continuing.

## Projects and runs

Add a local project path in the dashboard or start directly from the CLI:

```bash
qagent run ~/code/project --goal "Implement X and validate it"
```

Runs, tasks, messages, routing decisions, path leases and telemetry are persisted in SQLite. Recent projects are derived from durable runs plus explicitly added project paths.

Stopping a run marks it cancelled and cancels every open task in that run through the broker’s existing cancellation path.

## Agents and models

The repository registry preserves the existing hierarchy:

```text
Provider → Harness → Model → Family → Agent → Role
```

The dashboard agent editor covers normal configuration including model, exact model selector, model family, role, reasoning/effort controls, permissions, enabled state and auto-start. Saved changes update the JSON registry and live broker roster; agent credentials are never exposed to React.

Custom command and OpenAI-compatible endpoint integrations remain available through the config-driven integration layer. Raw text endpoints are intentionally not promoted to manager/reviewer agents because they lack the Qagent tool contract.

## Provider status

`qagent doctor` and the dashboard probe executables. They do **not** infer account entitlement from that result.

Status is intentionally separated into:

- configured/enabled
- CLI executable found or unavailable
- authentication source: subscription, API profile, or local runtime
- authentication/entitlement unknown until proven by the provider
- live verification unknown/not required
- safely discovered models where the harness exposes enumeration

Real provider verification remains dependent on the installed CLI version, authenticated account, quota and exact model access.

See [`docs/provider-support.md`](docs/provider-support.md) for the support matrix.

## Runtime architecture

```text
browser dashboard / CLI / MCP
             │
             ▼
127.0.0.1:11511
single Qagent HTTP server
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

## Static asset and cache contract

- `index.html` is always `no-store`.
- Vite hashed assets under `/assets/` are immutable and cacheable long-term.
- non-hashed boot assets are revalidated.
- missing assets and paths with file extensions return `404`; they never fall back to SPA HTML.
- `/api` and `/api/*` never fall back to frontend HTML.
- the CSP allows only the same-origin scripts, styles and network operations required by the production dashboard.
- startup validates the bytes served by the broker against the installed release manifest before opening a browser ticket.

## Validation

```bash
npm ci
npm audit --audit-level=high
npm test
```

Automated tests use deterministic fake harnesses and do not consume Claude/OpenAI/Gemini/Kimi/etc. usage. Coverage includes:

- TypeScript and Vite production builds
- production bundle structure and React boot instrumentation
- static routing, MIME types, CSP and cache behavior
- ticket exchange/removal, HttpOnly sessions, replay and expiry handling
- all ten boot checkpoints in real Chromium
- visible diagnostics for blocked JavaScript, failed modules, unhandled rejections and CSP violations
- browser-received JavaScript SHA-256 matching the installed runtime manifest
- SSE, mutation authentication, malformed requests, routing, persistence and task lifecycle
- direct-supervise broker config authority, live-vs-disk config transition guards, PR5 target-listener migration, PID spoof/reuse protection
- operator MCP tool contracts, worker/operator privilege separation, blocking state revision waits, and dashboard/MCP shared run IDs
- exact-build reuse, legacy replacement, unrelated-port protection, repeated start, stop and surfaced startup failures
- macOS global installation from a stale earlier `PATH` launcher
- launch from outside the checkout, reinstall over a running instance and persistent-state preservation
- the globally installed dashboard mounting in both Google Chrome and real Safari/WebKit before and after reinstall
- installed `qagent mcp-config` and `qagent operator-mcp` before and after reinstall

The committed lockfile is the source of dependency resolution. CI uses `npm ci`; it does not mutate dependencies during validation.

CI is defined in [`.github/workflows/universal-harness-ci.yml`](.github/workflows/universal-harness-ci.yml).

## Security and limitations

Qagent binds to `127.0.0.1` by default. It does not silently bind to `0.0.0.0`.

Path leases coordinate writes but are not an OS sandbox. Powerful coding CLIs may have wider host permissions than their task contract, depending on harness settings.

Real provider subscriptions are not exercised by CI. Claude Code, Codex, Gemini, Kimi and OpenCode therefore remain live-unverified against a specific local account until tested on the target Mac.

See:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/provider-support.md`](docs/provider-support.md)
- [`docs/security.md`](docs/security.md)
