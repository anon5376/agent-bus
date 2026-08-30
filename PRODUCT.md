# Product

<!-- impeccable:product-schema 1 -->

<!-- Inferred (unattended session; no interview round was answered). Facts below are labeled. -->

## Platform

web

## Users

**Inferred.** Primary user is the human operator of a local multi-agent coding/research setup, sitting at their own Mac, watching and steering independent model CLIs through one broker. Job: start a run, see what each agent is doing, review submissions, stop misbehaving supervisors.

## Product Purpose

Agent Bus is a local-first control plane for heterogeneous autonomous coding and research agents. Success is: the operator can see true broker state, assign work, review results, and stop agents without the dashboard lying about a foreign listener.

## Positioning

Independent model CLIs stay behind one durable local broker (SQLite, task DAG, supervisors, MCP). The browser dashboard, CLI, and operator MCP are interfaces over that same state. It binds to localhost; visiting the URL does not grant operator privileges.

## Operating Context

Night/desk use on the operator's machine. Commands: `agent-bus start`, `agent-bus open`, `agent-bus status`. Dashboard requires a one-time CLI ticket. Default listen address is `127.0.0.1:11511`.

## Capabilities and Constraints

Confirmed in this repo: dashboard SPA over `/api/*` + SSE; runs, tasks, agents, providers, projects; CSP `default-src 'self'` including `font-src 'self'` (no Google Fonts). Must preserve all existing operator actions (new run, stop all, start/stop agent, review task, message team, add project/agent).

## Brand Commitments

Name: Agent Bus. Mark: "AB". Voice in product copy is plain and operational, not marketing.

## Evidence on Hand

Live dashboard screenshots of the incumbent three-column admin shell. No customer quotes, pricing, or third-party testimonials exist; do not invent them.

## Product Principles

1. The dashboard is an instrument for a running broker, not a marketing site.
2. State on screen must match the broker contract.
3. Operator actions stay reachable without hunting.
4. Unrelated local processes on other ports are not this product.
