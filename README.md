# agent-bus

A local-first control plane for heterogeneous autonomous coding and research agents.

Agent Bus keeps independent model CLIs behind one durable broker: SQLite persistence, task DAGs, routing, supervisors, MCP, path leases, authentication, retries, reviews, telemetry, and project runs remain the orchestration engine. The browser dashboard and CLI are interfaces over that same state.

## Quick start

Requires Node.js 22.5 or newer.

```bash
git clone https://github.com/anon5376/agent-bus.git
cd agent-bus
npm install
npm run build
npm link
agent-bus start
```

`agent-bus start` starts or reuses the localhost broker and opens the dashboard at:

```text
http://127.0.0.1:7717
```

Use `agent-bus open` to open an already-running dashboard. Directly visiting the URL does not grant operator privileges; the CLI issues a short-lived one-time browser login ticket derived from the private local operator credential.

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
agent-bus run <project> --goal "..."      create a durable project run
agent-bus broker                          run the localhost product server in foreground
agent-bus provision <agent-id> [--rotate] provision/rotate an agent credential
agent-bus supervise <agent-id> [workdir]  run one persistent supervisor
agent-bus route <role> [options]          preview an inspectable routing decision
agent-bus models [--discover]             inspect registry/discovered models
agent-bus doctor                          probe harness executables
agent-bus status                          one-shot state view
agent-bus watch                           live terminal state view
agent-bus usage                           usage and latency totals
agent-bus send <to> <subject> [body]      send an operator message
```

Example:

```bash
agent-bus doctor
agent-bus models
agent-bus run ~/code/project --goal "Implement X and validate it"
agent-bus watch
```

## Architecture

```text
browser dashboard ─┐
CLI / MCP agents ──┼── 127.0.0.1:7717
                   │
                   ▼
              Agent Bus broker
                   │
        SQLite + JSONL audit state
                   │
   task DAG / routing / leases / telemetry
                   │
          independent supervisors
                   │
     normalized provider/harness adapters
```

The model is explicit:

`Provider → Harness → Model → Family → Agent → Role`

Routing is deterministic and inspectable. It considers role requirements, complexity, context size, configured capability profiles, permissions, availability, provider/family policy, subscription preference, cost class, observed success/failure/latency, and independent-family review requirements.

Capability values are configuration/heuristics, not benchmark truth. Runtime observations are stored separately rather than silently rewriting model profiles.

## Authentication and local security

The broker stores hashes for operator/agent bearer credentials; raw credentials live only in private local files. Existing agent IDs cannot be reclaimed through unauthenticated registration.

Browser authentication is separate from agent authentication:

1. `agent-bus open` or `agent-bus start` reads the private operator credential locally.
2. The CLI asks the broker for a short-lived, one-time browser ticket.
3. The browser exchanges that ticket for an HttpOnly, SameSite=Strict session.
4. Dashboard mutation APIs additionally require same-origin requests.
5. Simply loading `/` never authenticates the browser.

The service binds to `127.0.0.1` by default. It does not silently bind to `0.0.0.0`.

Path leases protect overlapping broker-scheduled write scopes, but they are not an OS sandbox. Coding CLIs may still have host permissions granted by their own invocation flags.

## Providers and models

The repository contains normalized integration paths for Claude Code, Codex CLI, Gemini CLI, Kimi Code and OpenCode, plus adapter/configuration surfaces for local/custom command harnesses, OpenAI-compatible endpoints, Hermes and disabled Grok/xAI paths.

Automated tests do not make real provider calls. The deterministic fake harness covers orchestration behavior without consuming subscription/API usage.

See [`docs/provider-support.md`](docs/provider-support.md) for the explicit support vocabulary: implemented/tested, implemented/live-unverified, adapter-ready, researched path and unsupported.

## Validation

```bash
npm run build
npm test
```

The test suite covers the existing broker/harness behavior plus the product server: static SPA serving, browser authorization, one-time ticket replay prevention, same-origin mutation checks, project/run persistence, run stop semantics, SSE delivery, live agent configuration, malformed requests, registration security, task lifecycle, path leases, retries/rerouting, routing, persistence and deterministic harness execution.

GitHub Actions runs Node 22 build and test verification. Real provider entitlement and macOS browser/process behavior remain local verification items.

## More documentation

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/provider-support.md`](docs/provider-support.md)
- [`docs/security.md`](docs/security.md)
- [`docs/prototype-report.md`](docs/prototype-report.md)
