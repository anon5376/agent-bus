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
const server = config.mcpServers?.qagent ?? config.mcpServers?.["agent-bus"];
assert.ok(server, "mcp-config must define mcpServers.qagent");
assert.equal(typeof server.command, "string");
assert.deepEqual(server.args, ["operator-mcp"]);
assert.equal(String(server.command).includes("agent-bus") || String(server.command).includes("qagent"), true, "installed MCP must launch through the stable Qagent launcher");
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
    "qagent_status", "qagent_catalog", "qagent_start", "qagent_create_run", "qagent_execute",
    "qagent_delegate", "qagent_message", "qagent_task", "qagent_run", "qagent_wait",
    "qagent_review", "qagent_cancel", "qagent_artifacts", "qagent_agent_start", "qagent_agent_stop",
  ]) assert.equal(names.has(expected), true, `installed MCP missing ${expected}`);
  const status = await call(client, "qagent_status");
  assert.equal(status.running, true, "installed MCP must connect to the running installed broker");
  const catalog = await call(client, "qagent_catalog");
  assert.equal(catalog.ok, true);
  assert.ok(catalog.catalog?.agents, "installed MCP catalog must come from the broker");
  const agentIds = Object.keys(catalog.catalog.agents ?? {});
  const agentId = agentIds.includes("fake-small") ? "fake-small" : agentIds.find((id) => id.startsWith("fake-"));
  assert.ok(agentId, `installed MCP smoke needs a fake test agent in AGENT_BUS_HOME; configured agents: ${agentIds.join(", ") || "(none)"}`);
  const start = await call(client, "qagent_start");
  assert.equal(start.reused, true, "qagent_start must reuse the exact installed instance");

  const projectRoot = process.env.RUNNER_TEMP || process.cwd();
  const agentStart = await call(client, "qagent_agent_start", { agentId, projectRoot });
  assert.equal(agentStart.ok, true);
  assert.ok(Number(agentStart.pid) > 0, "installed operator MCP must start a verified supervisor");
  const agentStop = await call(client, "qagent_agent_stop", { agentId });
  assert.equal(agentStop.ok, true);
  assert.equal(agentStop.agentId, agentId);
} finally {
  await client.close();
}

process.stdout.write("installed operator MCP smoke passed\n");
