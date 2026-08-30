# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user is a human operator of a local multi-agent coding setup. Other people may install the same product. Job: configure providers and a roster from scratch, then run work from the dashboard, CLI, or chat (`@agent-bus`).

## Product Purpose

Agent Bus is a local-first control plane for heterogeneous autonomous agents. Success is: a fresh install has no demo roster; the operator can autodetect installed CLIs, name agents, set who a manager may create, and delegate exact model+provider targets from chat.

## Positioning

Independent model CLIs (Anthropic, OpenAI, Cursor, xAI, Moonshot, and others) stay behind one durable local broker. Cursor is one provider among equals. The browser dashboard, CLI, and operator MCP are interfaces over the same SQLite state.

## Operating Context

Desk use on the operator's machine. Commands: `agent-bus start`, `agent-bus open`, `agent-bus status`. Dashboard requires a one-time CLI ticket. Default listen address is `127.0.0.1:11511`. Attach operator MCP with `agent-bus mcp-config` so a chat model can call `agent_bus_delegate`.

## Brand Commitments

Name: Agent Bus. Mark: "AB". Visual language follows Cursor-style dashboard chrome (dark panels, rounded rows, blue accent) without Cursor trademarks.

## Product Principles

1. Start empty. No fake agents and no stock opus/gpt roster in production config.
2. Autodetect installed CLIs; if a CLI is missing, show a login command and allow a manual binary path.
3. The operator configures hierarchy; managers get an explicit spawn list via drag-and-drop.
4. State on screen must match the broker contract.
5. Unrelated local processes on other ports are not this product.
