# Universal harness architecture

## Design judgment

The original `agent-bus` already had the correct execution primitive: independent agent processes, a local broker, blocking waits, durable-enough mail semantics, supervisor wakeups and native CLI sessions. Replacing those with one monolithic chat loop would have destroyed the project's main advantage. The prototype therefore keeps the broker/supervisor/MCP shape and replaces the assumptions that fail at larger scale: flat tasks, in-memory authority, hard-coded harness branching, implicit model rankings and shared-write races.

## Layers

### 1. Provider and account source

A provider records where authentication and billing entitlement come from. It does not imply a CLI, model or role. Examples include an Anthropic subscription, ChatGPT/Codex login, Google account, Moonshot account, API profile or local runtime.

### 2. Harness adapter

A harness is the executable integration. `src/adapters.ts` normalizes:

- command construction and model-selection syntax;
- headless invocation;
- session resume;
- MCP injection where supported;
- environment and authentication preservation;
- streaming or structured-output parsing;
- token/cost extraction where exposed;
- timeout and process-tree termination;
- binary probes and model discovery.

Provider-specific details remain inside adapters. The broker does not know Claude, Codex or Kimi command syntax.

### 3. Model and family

A model definition carries the provider, harness, exact selector, family, context estimate, cost class and capability profile. Profiles are tagged as user-configured, heuristic or observed. Family is separate because routing and review policies often require diversity even when exact models change.

### 4. Agent instance

An agent binds one model to one harness, role set, authority and permission envelope. Multiple agents may use the same family or provider with different roles, reasoning controls or permissions.

### 5. Role and routing policy

Roles describe the work, not the vendor. The router evaluates configured capability weights, complexity, context size, permissions, family/provider constraints, subscription preference, cost class, availability and observed outcomes. It records the full candidate table and final explanation with each task.

## Control plane

`src/broker.ts` owns:

- verified identities and authority;
- durable mailboxes and blocking waiters;
- runs and graph tasks;
- dependency release;
- retry, fallback and escalation;
- independent review routing;
- path-lease scheduling;
- usage and telemetry ingestion;
- process presence and operator kill requests;
- inspectable snapshots for CLI/GUI surfaces.

`src/store.ts` persists the control plane in SQLite. JSON payloads keep the schema understandable while indexed columns support task, run, mailbox and lease queries. The append-only JSONL file remains an audit trail; SQLite is authoritative state.

## Run and task graph

A run binds an objective to one resolved project root. Its root task is routed to a manager. Tasks contain:

- parent and child links;
- dependencies;
- role, complexity and context estimate;
- exact-model/family/provider policy through the routing decision;
- assignee, implementation family and reviewer;
- read-only flag and write path scopes;
- context references and validation requirements;
- result artifacts, changed paths and observations;
- retry, reroute, review and cancellation history;
- per-task usage and route explanations.

The broker dispatches only when dependencies are accepted, concurrency capacity exists, the assignee is free and write scopes do not conflict. Completion releases leases and may unblock dependent work.

## Routing algorithm

`src/router.ts` is deterministic and configurable. It performs hard eligibility checks first:

- enabled provider, harness, model and agent;
- exact agent/model requirements;
- permitted family/provider lists;
- context capacity;
- write, shell and network permissions;
- independent-family review;
- global project constraints.

Eligible candidates are scored using role-weighted capabilities, complexity-adjusted speed/token-efficiency preferences, reliability, subscription preference, cost class, current load and observed success/latency. The selected candidate and rejected alternatives are persisted. Fallback roles are explicit configuration rather than scattered conditionals.

No score is presented as scientific truth. Capability profiles are editable priors; telemetry is separate evidence.

## Token-efficient context flow

The manager does not receive worker transcripts by default. A task carries a concise brief, optional parent summary, project root, context references, path scope and validation contract. Workers inspect files on demand. Results return as:

- concise summary and details;
- changed-file list;
- artifact/file/commit/URL references;
- validation observations;
- token, cost and latency metrics where available.

Project knowledge records persist reusable summaries without copying large artifacts through every message. Cheap-worker roles can be used for lookup or compaction before expensive planning.

## Supervisors and native CLI behaviour

Each agent keeps its own native CLI session. The supervisor blocks on broker mail, wakes the CLI with a scoped prompt, captures output, reports usage and returns to waiting. An optional `resumeSessionId` pins the agent to an existing native chat; otherwise the supervisor stores the exact session ID returned by the first turn and resumes it on later mail. A pinned ID is never replaced, and a harness that reports a different ID fails the turn instead of silently forking the conversation.

Resume syntax is owned by the harness adapter because model providers and coding harnesses are separate layers. Claude Code, Cursor and Hermes accept `--resume`; OpenCode uses `--session`; Kimi Code uses `--session`; Grok Build uses `--resume`; Gemini accepts its saved-session selector. Codex uses `queue --thread` for a pinned original Desktop/TUI task and `exec resume <id>` for a managed headless session. Custom command adapters can provide a dedicated `resumeArgs` template with `{session}`.

MCP-capable agents call broker tools directly. The fake harness and adapters configured for automatic reporting allow orchestration tests without provider calls.

This preserves native coding-agent strengths instead of reimplementing file, shell and repository tools inside the broker.

## Concurrency model

The prototype uses cooperative path leases:

- write scopes are normalized inside the selected project root;
- overlapping scopes cannot be held by concurrent tasks;
- read-only tasks acquire no write lease;
- missing scopes default conservatively to the configured project scope;
- leases are released on acceptance, failure or cancellation.

This prevents obvious broker-created races while remaining maintainable by one developer. Worktrees/branches are the logical next isolation layer for high-risk parallel edits, but they are not pretended to exist in this prototype.

## Persistence and restart

SQLite stores tokens hashes, agents, messages, tasks, runs, routing decisions, usage, telemetry, knowledge and leases. Broker restart reconstructs the roster and graph, keeps pending mail, and accepts previously provisioned credentials. Long-poll waiters are process-local and reconnect normally after restart.

## Observability

The CLI state view exposes provider, family, model, harness, role, status, current task, graph state, dependencies, leases, usage and routing reasons. The broker snapshot additionally exposes recent messages, runs, telemetry and supervisor process metadata. This backend is intentionally richer than the current SwiftUI view so the GUI can evolve without another broker redesign.

## Explicit prototype boundaries

- Path leases are scheduling controls, not OS-level filesystem confinement.
- Provider quota/remaining-usage discovery is used only when a harness exposes defensible data; no scraping or auth bypass exists.
- Live provider CLIs are not invoked by CI.
- Capability defaults are heuristics.
- Adaptive routing currently consumes simple success, rejection, latency and token telemetry; it does not train an opaque model.
- Git worktree/patch integration and transactional merge review remain future work.
