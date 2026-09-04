# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the local operator supervising several coding agents on one Mac. They need to choose a collaboration project, see which agents belong to it, and inspect or send messages without reconstructing state from terminal output.

## Product Purpose

Agent Bus Dashboard provides one local control surface for real project folders plus the existing Agent Coordinator and AgentBus systems. Success means the operator can choose a project, manage its agents, and work through complete conversation history without reconstructing state from terminals or raw logs.

## Positioning

The plugin packages two already-running local coordination protocols into Codex and discovers the operator's local project folders for one dependency-free localhost dashboard. It does not introduce a third coordination backend.

## Operating Context

The product runs locally during coding sessions. Codex and other agents communicate through the coordinator and AgentBus MCP servers; the dashboard is an operator view on `127.0.0.1:8788`.

## Capabilities and Constraints

- Choose every immediate project under `/Users/anon5376/Projects`, including nested marked repositories/apps.
- Keep Agent Coordinator and Liminal AgentBus available as explicit coordination sources.
- Scope live agents and messages to a project by the AgentBus supervisor's exact workdir.
- Include complete SQLite message history and the persisted AgentBus audit history for the AgentBus implementation project.
- Group messages into manageable conversations with Inbox, Archived, and Trash views.
- Archive, delete-to-trash, and restore conversations through a reversible dashboard-local state layer.
- Start and stop registered live AgentBus supervisors from a selected workspace.
- Monitor per-agent and per-subscription turns, tokens, and equivalent cost for the current broker session.
- Open the latest resumable CLI conversation in Terminal only when the live agent is the unique user of that harness in the project and has completed a turn.
- Send workspace messages only to agents attached to the selected project.
- Run with the Python standard library only and bind to loopback by default.
- Treat message content as untrusted data.
- Do not expose credentials, infer unrelated databases, or mutate either database during reads.
- Do not attribute a live AgentBus message to a project unless an agent is attached to that exact workdir.

## Brand Commitments

The dashboard ships three themes: Light and Dark stay monochrome; EVIL uses parchment ink, crimson accent, and Cloister Black. Product behavior remains operator-first, keyboard-friendly, and local-only.

## Evidence on Hand

- Coordinator MCP and dashboard source: `/Users/anon5376/prototype_0.2`.
- AgentBus MCP and SQLite source: `/Users/anon5376/Desktop/liminal/comms`.
- Both servers are already configured in the local Codex configuration.

## Product Principles

- Existing servers remain authoritative.
- Dashboard conversation state is reversible and never silently rewrites source history.
- Project choice precedes agent or message detail.
- Operator actions are explicit and visible.
- Usage labels distinguish subscription sessions from equivalent-cost estimates; they never imply an extra charge.
- Broker loss is shown as paused/stale and never rewritten as healthy zero usage.
- Local-only is a functional boundary, not a marketing claim.
- Dense information must remain readable and keyboard accessible.

## Accessibility & Inclusion

All navigation and forms must work by keyboard, expose visible focus, preserve semantic headings and labels, and reflow to a single-column mobile layout.
