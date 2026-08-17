# Security model

## Threat boundary

`agent-bus` is a local control plane for powerful coding agents. The broker binds to localhost, but localhost is not authorization. Any local process may attempt to call its HTTP routes, and some supervised CLIs may execute shell commands with the user's privileges. The design therefore separates broker identity/authority from model instructions and treats host-level isolation as a distinct problem.

## Fixed registration vulnerability

The original bootstrap accepted an agent ID at `/register` without proof of possession. Re-registering an existing ID could return that identity's stable bearer token. An untrusted local process could therefore take over a manager or worker identity.

The prototype replaces this with operator provisioning:

1. The broker creates a random operator credential and stores it in a mode-`0600` file.
2. SQLite stores only the SHA-256 token hash and bound authority/permissions.
3. The operator provisions a configured agent with `/agent/provision` or `agent-bus provision <id>`.
4. The raw agent credential is written to a private mode-`0600` file.
5. `/register` requires that existing credential, verifies its hash and confirms the token belongs to the requested ID.
6. Registration never returns the credential.
7. Rotation is an explicit operator action and invalidates the old token.

Regression tests cover missing tokens, wrong-identity tokens, valid re-registration, non-reissuance and persistence across broker restart.

## Identity and message integrity

A caller's identity is derived from the bearer token lookup. `from`, role, model, provider, harness, authority and permission fields supplied by a message are not trusted. The broker writes the authenticated identity into every delivered message and audit event.

Messages are coordination data, not authorization. A worker cannot gain manager rights because another agent tells it to act as a manager.

## Authority levels

### Operator

The human/local control plane may provision or rotate identities, create root runs, cancel tasks, review any task and terminate recorded supervisor processes.

### Manager

A manager may create child tasks only when its provisioned permissions allow delegation and only within the global and identity-specific depth limits. It may review work where task ownership permits.

### Worker

A worker receives only its configured authority. Delegation and review are denied unless explicitly enabled. Submission and task-start routes verify the current assignee.

## Task capability contract

Tasks record read-only/write intent, path scopes, shell/network requirements, delegation depth, retry policy and review requirements. Routing rejects agents whose configured permissions do not satisfy the task. The broker also refuses overlapping write leases.

This is capability-aware broker authorization, not complete host isolation. The task contract constrains scheduling and agent selection; the selected CLI's own sandbox/permission system determines actual process access.

## Harness-specific risk

- Claude Code uses explicit permission mode and an allow-list including broker MCP tools.
- Codex noninteractive MCP has historically failed under some sandbox modes. The adapter may use dangerous full access for write-capable agents so MCP reporting works. That is visible configuration, not a security guarantee.
- Gemini/Kimi/OpenCode/Hermes permissions depend on installed CLI versions and provider configuration.
- API keys are not fabricated or extracted by the broker. Subscription-backed CLIs retain their normal login state.

Do not point unsandboxed agents at untrusted directories. Use a dedicated user/account or VM where stronger host isolation is required.

## Project path leases

Write scopes are resolved inside the selected project root and stored as leases. Overlapping paths cannot be dispatched concurrently. This prevents accidental multi-agent races created by the broker.

Path leases do not stop a malicious or confused process from writing outside its declared scope. Future hardening should combine leases with worktrees, per-task filesystem sandboxes and patch-only integration.

## Persistence and secrets

- SQLite is the authoritative durable state.
- Raw operator/agent tokens exist only in private credential files and process environments.
- Token hashes, authority and permissions persist in SQLite.
- Pending messages and tasks survive restarts.
- The JSONL audit is append-only evidence, not the source of truth.
- Logs and transcripts may contain project-sensitive content and must be protected accordingly.

## Residual risks

- A process running as the same OS user may be able to read credential files despite mode `0600`; Unix permissions protect against other users, not a compromised account.
- The local HTTP API is not encrypted. It is intentionally bound to localhost and must not be exposed.
- GUI/read-only endpoints remain local observability surfaces; operators should not treat them as a multi-user security boundary.
- Provider CLIs can change flags, sandbox semantics and session formats.
- Cancellation first requests process termination; filesystem side effects already made by a child process are not rolled back.
- No cryptographic signing of task artifacts or commits exists yet.

The next security milestone should be worktree isolation plus patch review/merge under operator authority, followed by per-task OS sandboxing where the host permits it.
