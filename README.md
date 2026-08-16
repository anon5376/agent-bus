# agent-bus

A local-first control plane and universal harness for heterogeneous autonomous coding and research agents.

`agent-bus` keeps the strongest part of the original project: independent CLI agents sleep on blocking broker waits, wake only when work arrives, operate inside the selected project, report concise structured results, and go back to sleep. The prototype adds a durable task graph, inspectable model routing, provider/harness/model separation, secure credentials, path ownership, telemetry, and a normalized adapter layer.

> **Prototype status:** the control plane, fake-harness simulations, persistence, routing, authentication, task lifecycle, and adapter normalization are implemented. Real provider CLIs still require their normal local installation and login, and the repository does not claim that every configured model is available to every account.

## What is implemented

- Explicit `Provider → Harness → Model → Family → Agent → Role` configuration.
- Subscription-first adapters for Claude Code, Codex CLI, Gemini CLI, Kimi Code and OpenCode.
- Additional adapter surfaces for Hermes and Grok, plus local-model routes through OpenCode or Codex `--oss`.
- Deterministic routing by role, complexity, context size, permissions, family/provider policy, configured capability profile, availability, subscription preference, cost class and observed task history.
- SQLite persistence for identities, mail, agents, runs, graph tasks, routing decisions, path leases, usage and model telemetry.
- Parent/child tasks, dependencies, retries, fallback routing, independent review, cancellation and escalation.
- Cooperative path leases that prevent the broker from concurrently assigning overlapping write scopes.
- Scoped briefs, file/artifact references and structured results instead of raw transcript forwarding.
- Operator, manager and worker authority levels with operator-issued credentials.
- A deterministic fake provider/harness for integration tests without consuming subscription usage.

## Quick start

Requires Node.js 22.5 or newer.

```bash
npm ci
npm run build

# Check configured CLI binaries. This does not infer account entitlement.
node dist/cli.js doctor

# Inspect the registry and optionally ask supported harnesses for model discovery.
node dist/cli.js models
node dist/cli.js models --discover

# Start a project run. Enabled agents marked autoStart are provisioned and supervised.
node dist/cli.js run ~/code/project --goal "Implement X and validate it"

# Observe agents, runs, graph tasks, leases and routing reasons.
node dist/cli.js watch
```

Each official CLI must be installed and authenticated through its own normal login flow. `agent-bus` does not bypass authentication, quotas, provider restrictions or terms.

## Configuration model

The repository-level [`agent-bus.config.json`](agent-bus.config.json) is the prototype registry.

- **Provider** identifies the account/authentication source, such as an Anthropic subscription, ChatGPT/Codex login, Google account, Moonshot account, API profile or local runtime.
- **Harness** identifies the executable integration, such as Claude Code, Codex CLI, Gemini CLI, Kimi Code, OpenCode or Hermes.
- **Model** identifies the exact selector, model family, context profile, cost class and configurable capability estimates.
- **Agent** instantiates one model through one harness with a role set and permissions.
- **Role** defines routing requirements and capability weights such as manager, planner, implementation, research, reviewer, tester or cheap worker.

Capability values are explicitly labelled as user configuration, heuristic defaults or observed telemetry. They are not treated as objective benchmark truth, and observed history does not silently overwrite user configuration.

A role policy can constrain exact models, families or providers and can require subscription-backed authentication, write access, shell access, network access or independent-family review. Use the router directly to inspect a decision:

```bash
node dist/cli.js route implementation --complexity 2 --write --families gpt,claude
node dist/cli.js route reviewer --complexity 5 --implementation-family gpt
```

The output includes the selected agent and every candidate's score or rejection reason.

## Runtime architecture

```text
operator / GUI / CLI
        │
        ▼
local HTTP broker ─── SQLite state + append-only JSONL audit
        │
        ├── task graph / dependencies / retries / path leases
        ├── deterministic router / telemetry / route explanations
        └── durable mailboxes / blocking waiters
                 │
        independent supervisors
                 │
      normalized harness adapters
                 │
 Claude Code · Codex · Gemini · Kimi · OpenCode · Hermes · fake
```

`agent-bus run <project> --goal ...` creates a durable run and routes a root manager task. The manager inspects the project, creates scoped child tasks through MCP, declares dependencies and path scopes, and sleeps while workers execute. Workers receive only the brief, project root, permission boundary, validation contract and context references required for their task. Results return as summaries, changed paths, artifact references and validation observations.

## Authentication and authority

The original unauthenticated `/register` bootstrap could be used to re-register an existing agent ID and obtain its bearer token. That path is removed.

The new flow is:

1. The broker creates or validates a private operator token.
2. The operator explicitly provisions a configured agent with `agent-bus provision <id>`.
3. The raw credential is written mode `0600`; SQLite stores only its hash.
4. `/register` verifies that token against the already provisioned identity and never returns it.
5. Message sender identity, authority and permissions come from the verified token, never from message fields.

Managers may delegate only within configured depth. Workers cannot delegate unless explicitly allowed. Reviews, cancellations, provisioning, token rotation and process kills are separately authorized. See [`docs/security.md`](docs/security.md).

## Concurrency and project safety

The prototype uses broker-enforced **path leases**, not a pile of implicit shared writes. Two write tasks with overlapping scopes are not dispatched concurrently. A task without an explicit scope receives the configured default scope, normally the project root, which serializes writes conservatively. Read-only tasks do not acquire write leases.

This is a scheduling boundary, not an operating-system sandbox. A powerful coding CLI may still have broader host access than its task contract. Run agents only inside trusted project directories and review each harness's effective permission flags.

## Commands

```text
agent-bus run <project> --goal "..."      create a durable run and route a manager
agent-bus broker                           start the local broker
agent-bus provision <agent-id> [--rotate] provision or deliberately rotate a credential
agent-bus supervise <agent-id> [workdir]  run a persistent supervisor
agent-bus route <role> [options]          preview an inspectable routing decision
agent-bus models [--discover]             inspect configured/discovered models
agent-bus doctor                          probe configured harness executables
agent-bus status                          one-shot state view
agent-bus watch                           live state view
agent-bus usage                           usage and latency totals
agent-bus send <to> <subject> [body]      send an operator message
```

Agents receive MCP tools for identity, messaging, blocking waits, route previews, graph-task creation, structured submissions, review, cancellation, task detail and project knowledge.

## Validation

```bash
npm test
```

The suite builds production TypeScript, compiles tests and runs fake-harness and broker simulations covering registration/authentication, impersonation, message delivery, task creation, dependencies, path conflicts, submit/review/revise cycles, persistence/restart recovery, routing, adapter normalization, malformed output, retries, fallback, cancellation and model telemetry.

CI is defined in [`.github/workflows/universal-harness-ci.yml`](.github/workflows/universal-harness-ci.yml).

## Provider status and limitations

The prototype deliberately distinguishes implemented code from live-provider verification. Claude Code and Codex are the strongest existing integrations; Gemini, Kimi and OpenCode are implemented but depend on installed CLI versions and local account state; Hermes is adapter-ready; Grok is disabled until a defensible official CLI/account path is configured; Ollama and LM Studio are reached through compatible harnesses rather than fake first-class support.

See:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/provider-support.md`](docs/provider-support.md)
- [`docs/security.md`](docs/security.md)
- [`docs/prototype-report.md`](docs/prototype-report.md)

The prototype does not yet provide OS-level per-task isolation, transactional git worktree integration, automatic quota discovery for providers that do not expose it, or benchmark-trained adaptive routing. Those are explicit next steps, not hidden claims.
