# Provider and harness support

This document separates implemented code from live account verification. A configured entry is not a claim that a provider grants a particular model to the current user.

## Status vocabulary

- **Implemented and tested:** adapter/control-plane behaviour is covered by automated tests without consuming external usage.
- **Implemented, live unverified:** command construction and normalization exist, but this branch did not spend a real subscription call in CI.
- **Adapter-ready:** the normalized interface exists and configuration is present, but invocation needs local validation.
- **Researched path:** an official or realistic compatible route exists, but no first-class adapter is claimed.
- **Unsupported:** no defensible integration is enabled.

## Matrix

| Provider / route | Harness | Authentication source | Prototype status | Notes |
|---|---|---|---|---|
| Anthropic | Claude Code | Normal Claude Code login / subscription | Implemented, live unverified in this PR | Headless `-p`, model selection, JSON output, resume, MCP injection, permission allow-list and usage parsing are normalized. The original project had manually exercised Claude Code; CI uses the fake harness. |
| OpenAI | Codex CLI | Normal Codex login, including eligible ChatGPT plans, or explicit API auth | Implemented, live unverified in this PR | `codex exec`, resume, model/reasoning controls, MCP config and token parsing are normalized. Some Codex versions require unsandboxed execution for noninteractive MCP; the adapter makes this visible rather than hiding it. |
| Google | Gemini CLI | Normal Google/Gemini CLI login | Implemented, live unverified | Headless prompt and model selection are normalized. Headless MCP behaviour has varied by CLI version, so this integration must be validated against the installed version before relying on native broker calls. |
| Moonshot AI | Kimi Code CLI | Normal Kimi Code login/provider configuration | Implemented, live unverified | Prompt, session resume and model selection are normalized. Current Kimi releases also expose stream-JSON output; parser hardening against all versions remains follow-up work. |
| OpenCode ecosystem | OpenCode | Provider accounts configured through OpenCode | Implemented, live unverified | Project-local MCP config, `run`, session/model/variant selection, JSON events and `opencode models` discovery are supported. |
| Local models | Codex `--oss` / OpenCode | Local Ollama or compatible endpoint | Researched path and adapter configuration | Local inference is intentionally reached through a real coding harness rather than pretending the broker itself is an agent. Exact model availability comes from the local runtime. |
| Ollama | Codex `--oss` or OpenCode | Local runtime or configured Ollama account | Researched path | Official Ollama documentation describes Codex `--oss`; no separate fake Ollama coding-agent adapter is added. |
| LM Studio | OpenCode or OpenAI-compatible endpoint | Local LM Studio runtime | Researched path | LM Studio exposes local model listing and OpenAI-compatible APIs. A dedicated `lms` discovery adapter is not yet wired. |
| Hermes | Hermes-compatible CLI | Local/provider profile | Adapter-ready | Invocation, resume and output normalization exist, but no live profile was validated in this PR. |
| Cursor | Cursor CLI (`cursor-agent` / `agent`) | Cursor account / `agent login` / `CURSOR_API_KEY` | Implemented, live unverified | Same lane as other coding CLIs: print mode, model selection, resume, MCP injection. Models available through Cursor (including Grok or Claude slugs) are selected with `--model`, not a special Cursor-only path. |
| xAI / Grok | Grok CLI | `grok login` | Implemented, live unverified | Headless `-p`, JSON output, resume and model selection are normalized. |
| Deterministic fake | Fake harness | None | Implemented and tested | Used for routing, task graph, retry, failure, cancellation and supervisor simulations without external calls. |
| Other providers | Generic normalized adapter contract | Subscription, API or local | Interface-ready | Adding a provider means adding account metadata, a harness adapter if command semantics differ, model entries and agents. The routing core remains unchanged. |

## Model discovery

The prototype supports discovery only where a CLI safely exposes it:

- OpenCode: `opencode models` through adapter discovery.
- Other official CLIs: registry configuration unless a stable enumeration command is available.
- Ollama/LM Studio: documented external discovery paths, not silently scraped by the broker.

`agent-bus doctor` scans the known provider catalog (PATH plus well-known install locations) and reports login commands for missing CLIs. It also probes enabled harnesses. It does not infer login state, subscription entitlement, remaining quota or model access from the presence of a binary.

## Primary references inspected

- Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Claude Code MCP: https://docs.anthropic.com/en/docs/claude-code/mcp
- OpenAI Codex CLI: https://developers.openai.com/codex/cli/reference
- OpenAI Codex repository/authentication: https://github.com/openai/codex
- Gemini CLI: https://github.com/google-gemini/gemini-cli
- Kimi Code CLI: https://github.com/MoonshotAI/kimi-cli
- OpenCode CLI: https://opencode.ai/docs/cli/
- Ollama Codex integration: https://docs.ollama.com/integrations/codex
- LM Studio CLI and APIs: https://lmstudio.ai/docs/cli
- Node.js SQLite: https://nodejs.org/api/sqlite.html

Provider interfaces change. The adapter configuration is the source of truth for this prototype; claims above are intentionally narrow.
