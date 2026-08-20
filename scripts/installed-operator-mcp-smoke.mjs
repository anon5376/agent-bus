#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function stringEnv(values) {
  return Object.fromEntries(Object.entries(values).filter((entry) => typeof entry[1] === "string"));
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text ?? `MCP ${name} failed`);
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content?.[0]?.text ?? "{}");
}

const generated = spawnSync("agent-bus", ["mcp-config"], {
  env: process.env,
  encoding: "utf8",
  timeout: 20_000,
});
assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
assert.doesNotMatch(generated.stdout, /operator\.token|AGENT_BUS_OPERATOR_TOKEN|bearer/i, "MCP config must not expose operator credentials");
const config = JSON.parse(generated.stdout);
const server = config.mcpServers?.["agent-bus"];
assert.ok(server, "mcp-config must define mcpServers.agent-bus");
assert.equal(typeof server.command, "string");
assert.deepEqual(server.args, ["operator-mcp"]);
assert.equal(String(server.command).includes("agent-bus"), true, "installed MCP must launch through the stable Agent Bus launcher");
if (process.env.GITHUB_WORKSPACE) {
  assert.equal(JSON.stringify(server).includes(process.env.GITHUB_WORKSPACE), false, "installed MCP config must not point into the checkout");
}

const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  env: stringEnv({ ...process.env, ...(server.env ?? {}) }),
  stderr: "pipe",
});
const client = new Client({ name: "agent-bus-installed-smoke", version: "1.0.0" });
await client.connect(transport);
try {
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const expected of [
    "agent_bus_status", "agent_bus_catalog", "agent_bus_start", "agent_bus_create_run", "agent_bus_execute",
    "agent_bus_delegate", "agent_bus_message", "agent_bus_task", "agent_bus_run", "agent_bus_wait",
    "agent_bus_review", "agent_bus_cancel", "agent_bus_artifacts", "agent_bus_agent_start", "agent_bus_agent_stop",
  ]) assert.equal(names.has(expected), true, `installed MCP missing ${expected}`);
  const status = await call(client, "agent_bus_status");
  assert.equal(status.running, true, "installed MCP must connect to the running installed broker");
  const catalog = await call(client, "agent_bus_catalog");
  assert.equal(catalog.ok, true);
  assert.ok(catalog.catalog?.agents, "installed MCP catalog must come from the broker");
  const start = await call(client, "agent_bus_start");
  assert.equal(start.reused, true, "agent_bus_start must reuse the exact installed instance");
} finally {
  await client.close();
}

process.stdout.write("installed operator MCP smoke passed\n");
