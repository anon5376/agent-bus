import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function stringEnv(values: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args }) as any;
  if (result.isError) throw new Error(result.content?.[0]?.text ?? `MCP ${name} failed`);
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content?.[0]?.text ?? "{}");
}

function runCli(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], { env, encoding: "utf8", timeout: 20_000 });
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timed out waiting for ${url}/health`);
}

async function dashboardState(url: string, token: string): Promise<any> {
  const ticketResponse = await fetch(`${url}/dashboard/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const ticketText = await ticketResponse.text();
  assert.equal(ticketResponse.status, 200, ticketText);
  const ticket = JSON.parse(ticketText).ticket;
  const session = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  const sessionText = await session.text();
  assert.equal(session.status, 200, sessionText);
  const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0];
  const state = await fetch(`${url}/api/state`, { headers: { cookie } });
  const stateText = await state.text();
  assert.equal(state.status, 200, stateText);
  return JSON.parse(stateText);
}

test("mcp-config uses the stable installed launcher and never exposes the operator credential", () => {
  const root = temporaryDirectory("agent-bus-mcp-config-");
  const home = join(root, "home");
  const configPath = join(home, "config.json");
  const launcher = join(root, "bin", "agent-bus");
  const secret = "operator-secret-that-must-not-leak";
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "operator.token"), `${secret}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BUS_HOME: home,
    AGENT_BUS_CONFIG: configPath,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: "17717",
    AGENT_BUS_URL: "http://127.0.0.1:17717",
    AGENT_BUS_LAUNCHER_PATH: launcher,
  };
  try {
    const result = runCli(env, "mcp-config");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.includes(secret), false, "operator token must never appear in MCP configuration");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.mcpServers?.qagent.command, launcher);
    assert.deepEqual(parsed.mcpServers?.qagent.args, ["operator-mcp"]);
    const server = parsed.mcpServers?.qagent ?? parsed.mcpServers?.["agent-bus"];
    assert.equal(server.command, launcher);
    assert.deepEqual(server.args, ["operator-mcp"]);
    assert.equal(server.env.QAGENT_HOME, home);
    assert.equal(server.env.QAGENT_CONFIG, configPath);
    assert.equal(server.env.QAGENT_PORT, "17717");
    assert.equal(server.env.QAGENT_URL, "http://127.0.0.1:17717");
    assert.equal(server.env.AGENT_BUS_HOME, home);
    assert.equal(server.env.AGENT_BUS_CONFIG, configPath);
    assert.equal(server.env.AGENT_BUS_PORT, "17717");
    assert.equal(server.env.AGENT_BUS_URL, "http://127.0.0.1:17717");
    assert.equal(Object.keys(server.env).some((key) => /token/i.test(key)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator MCP drives the same broker state as the dashboard and remains separate from worker MCP", { timeout: 90_000 }, async () => {
  const root = temporaryDirectory("qagent-operator-mcp-");
  const home = join(root, "home");
  const project = join(root, "project");
  const configPath = join(root, "config.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const config = testConfig();
  for (const agent of Object.values(config.agents)) agent.autoStart = false;
  config.constraints.maxRetries = 0;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BUS_HOME: home,
    AGENT_BUS_CONFIG: configPath,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_URL: url,
  };
  const peerHome = join(root, "peer-home");
  const peerConfigPath = join(root, "peer-config.json");
  writeFileSync(peerConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  const peerPort = await freePort();
  const peerUrl = `http://127.0.0.1:${peerPort}`;
  const peerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BUS_HOME: peerHome,
    AGENT_BUS_CONFIG: peerConfigPath,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(peerPort),
    AGENT_BUS_URL: peerUrl,
  };
  const peerStart = runCli(peerEnv, "start", "--no-open");
  assert.equal(peerStart.status, 0, `${peerStart.stdout}\n${peerStart.stderr}`);
  const peerHealth = await waitForHealth(peerUrl);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js", "operator-mcp"],
    env: stringEnv(env),
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-bus-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const expected of [
      "qagent_status", "qagent_catalog", "qagent_start", "qagent_create_run", "qagent_execute",
      "qagent_delegate", "qagent_message", "qagent_task", "qagent_run", "qagent_wait", "qagent_review",
      "qagent_cancel", "qagent_artifacts", "qagent_agent_start", "qagent_agent_stop",
    ]) assert.equal(names.has(expected), true, `missing ${expected}`);

    const before = await call(client, "qagent_status");
    assert.equal(before.running, false, "status must not start the broker as a side effect");
    await call(client, "qagent_start");
    const running = await call(client, "qagent_status");
    assert.equal(running.running, true);

    const created = await call(client, "qagent_create_run", {
      projectRoot: project,
      goal: "Coordinate a deterministic fake project run",
      startSupervisor: false,
    });
    assert.ok(created.runId);
    assert.ok(created.rootTaskId);

    const delegated = await call(client, "qagent_delegate", {
      runId: created.runId,
      parentTaskId: created.rootTaskId,
      title: "Implement deterministic child",
      description: "Complete the fake child task and submit a result.",
      role: "cheap-worker",
      complexity: 1,
      writeAccess: false,
      reviewRequired: false,
    });
    assert.equal(delegated.assignee, "fake-small", "delegation without exact agent must use the real router");
    const childWait = await call(client, "qagent_wait", { taskId: delegated.taskId, timeoutMs: 20_000 });
    assert.equal(childWait.task.state, "submitted");
    await call(client, "qagent_review", { taskId: delegated.taskId, decision: "accept", feedback: "Child accepted." });
    await call(client, "qagent_cancel", { runId: created.runId, reason: "First run only exercised delegation." });

    const execution = await call(client, "qagent_execute", {
      projectRoot: project,
      goal: "Complete a second deterministic objective through the manager",
      timeoutMs: 20_000,
    });
    assert.ok(execution.runId);
    assert.equal(execution.execution.task.state, "submitted");
    await call(client, "qagent_review", { taskId: execution.rootTaskId, decision: "accept", feedback: "Objective accepted." });
    const finalRun = await call(client, "qagent_run", { runId: execution.runId });
    assert.equal(finalRun.run.status, "completed");
    const artifacts = await call(client, "qagent_artifacts", { runId: execution.runId });
    assert.equal(artifacts.runId, execution.runId);

    const operatorToken = readFileSync(join(home, "operator.token"), "utf8").trim();
    const state = await dashboardState(url, operatorToken);
    assert.equal(state.runs.some((run: any) => run.id === execution.runId), true, "dashboard must show MCP-created run id");
    assert.equal(state.tasks.some((task: any) => task.id === execution.rootTaskId), true, "dashboard must show MCP-created task id");

    const workerToken = readFileSync(join(home, "tokens", "fake-small.token"), "utf8").trim();
    const workerTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/mcp-server.js"],
      env: stringEnv({ ...env, AGENT_ID: "fake-small", AGENT_TOKEN: workerToken, AGENT_ROLE: "cheap-worker", AGENT_MODEL: "fake-small" }),
      stderr: "pipe",
    });
    const workerClient = new Client({ name: "agent-bus-worker-test", version: "1.0.0" });
    await workerClient.connect(workerTransport);
    try {
      const workerTools = await workerClient.listTools();
      assert.equal(workerTools.tools.some((tool) => tool.name.startsWith("qagent_")), false, "worker MCP must never expose operator tools");
      assert.equal(workerTools.tools.some((tool) => tool.name.startsWith("bus_")), true);
    } finally {
      await workerClient.close();
    }

    const stop = runCli(env, "stop");
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
    const peerAfterStop = await waitForHealth(peerUrl);
    assert.equal(peerAfterStop.pid, peerHealth.pid, "MCP/CLI operations for instance A must not stop instance B");
    const stopped = await call(client, "qagent_status");
    assert.equal(stopped.running, false, "existing MCP client must observe broker stop");
    await call(client, "qagent_start");
    assert.equal((await call(client, "qagent_status")).running, true, "existing MCP client must reconnect after broker restart");
  } finally {
    runCli(env, "stop");
    runCli(peerEnv, "stop");
    await client.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
