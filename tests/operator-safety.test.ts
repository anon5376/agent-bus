import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
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

async function connectOperator(env: NodeJS.ProcessEnv): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js", "operator-mcp"],
    env: stringEnv(env),
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-bus-operator-safety-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args }) as any;
  if (result.isError) throw new Error(result.content?.[0]?.text ?? `MCP ${name} failed`);
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content?.[0]?.text ?? "{}");
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  }
  throw new Error(`timed out waiting for ${url}/health`);
}

function runCli(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], { env, encoding: "utf8", timeout: 20_000 });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  assert.equal(alive(pid), false, `PID ${pid} did not exit`);
}

async function postJson(url: string, path: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${path} -> ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function dashboardSession(url: string, operatorToken: string): Promise<string> {
  const login = await postJson(url, "/dashboard/login", { token: operatorToken });
  const session = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ ticket: login.ticket }),
  });
  const text = await session.text();
  assert.equal(session.ok, true, text);
  return (session.headers.get("set-cookie") ?? "").split(";")[0];
}

async function waitForRosterPid(client: Client, agentId: string, pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await call(client, "agent_bus_status");
    const row = (status.roster ?? []).find((entry: any) => entry.id === agentId);
    if (Number(row?.supervisorPid) === pid) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  }
  throw new Error(`${agentId} did not register supervisor PID ${pid}`);
}

test("agent_bus_status never sends the operator credential to an unrelated listener", {
  skip: process.platform === "win32",
  timeout: 20_000,
}, async () => {
  const root = temporaryDirectory("agent-bus-status-isolation-");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const secret = "operator-secret-must-never-leave-agent-bus";
  writeFileSync(join(home, "operator.token"), `${secret}\n`, { mode: 0o600 });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const requests: Array<{ path: string; body: string }> = [];
  const fake = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/health" ? JSON.stringify({ ok: true }) : JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    fake.once("error", reject);
    fake.listen(port, "127.0.0.1", () => resolveListen());
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BUS_HOME: home,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_URL: url,
    AGENT_BUS_CONFIG: join(root, "unused-config.json"),
  };
  const client = await connectOperator(env);
  try {
    const status = await call(client, "agent_bus_status");
    assert.equal(status.running, false);
    assert.equal(status.occupied, true);
    assert.match(String(status.reason), /unrelated listener/i);
    assert.equal(requests.some((request) => request.path === "/state"), false, "status must not authenticate to an unverified listener");
    assert.equal(JSON.stringify(requests).includes(secret), false, "operator credential leaked to unrelated listener");
  } finally {
    await client.close().catch(() => {});
    await new Promise<void>((resolveClose) => fake.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale supervisors self-heal and agent_bus_wait wakes for operator questions", {
  skip: process.platform === "win32",
  timeout: 70_000,
}, async () => {
  const root = temporaryDirectory("agent-bus-operator-recovery-");
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
  const broker = spawn(process.execPath, ["dist/cli.js", "broker"], { env, stdio: "ignore", detached: true });
  let client: Client | null = null;
  try {
    await waitForHealth(url);
    client = await connectOperator(env);
    assert.equal((await call(client, "agent_bus_start")).reused, true);

    const first = await call(client, "agent_bus_agent_start", { agentId: "fake-small", projectRoot: project });
    assert.equal(first.started, true);
    const firstPid = Number(first.pid);
    assert.ok(firstPid > 0);
    try { process.kill(-firstPid, "SIGKILL"); } catch { process.kill(firstPid, "SIGKILL"); }
    await waitForExit(firstPid);

    const staleStatus = await call(client, "agent_bus_status");
    const staleRow = (staleStatus.roster ?? []).find((entry: any) => entry.id === "fake-small");
    assert.equal(staleRow?.supervisorPid ?? null, null, "status must prune a dead supervisor immediately");
    assert.equal(staleRow?.status, "offline", "status must report the agent offline immediately after supervisor death");

    const operatorToken = readFileSync(join(home, "operator.token"), "utf8").trim();
    const cookie = await dashboardSession(url, operatorToken);
    const dashboardStart = await fetch(`${url}/api/agents/fake-small/start`, {
      method: "POST",
      headers: { cookie, origin: url, "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: project }),
    });
    const dashboardText = await dashboardStart.text();
    assert.equal(dashboardStart.status, 200, dashboardText);
    const dashboardResult = JSON.parse(dashboardText);
    assert.equal(dashboardResult.started, true, "dashboard must discard stale supervisor metadata and relaunch");
    const secondPid = Number(dashboardResult.pid);
    assert.ok(secondPid > 0 && secondPid !== firstPid);
    await waitForRosterPid(client, "fake-small", secondPid);
    try { process.kill(-secondPid, "SIGKILL"); } catch { process.kill(secondPid, "SIGKILL"); }
    await waitForExit(secondPid);

    const recovered = await call(client, "agent_bus_agent_start", { agentId: "fake-small", projectRoot: project });
    assert.equal(recovered.started, true, "operator MCP must discard stale supervisor metadata and relaunch");
    const thirdPid = Number(recovered.pid);
    assert.ok(thirdPid > 0 && thirdPid !== secondPid);
    await call(client, "agent_bus_agent_stop", { agentId: "fake-small" });

    const created = await call(client, "agent_bus_create_run", {
      projectRoot: project,
      goal: "Wait for explicit operator input",
      startSupervisor: false,
    });
    const workerToken = readFileSync(join(home, "tokens", "fake-small.token"), "utf8").trim();
    const waiting = call(client, "agent_bus_wait", { taskId: created.rootTaskId, timeoutMs: 10_000 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    await postJson(url, "/send", {
      token: workerToken,
      to: "operator",
      type: "question",
      subject: "Need operator input",
      body: "Choose option A or option B before I continue.",
      taskId: created.rootTaskId,
    });
    const attention = await waiting;
    assert.equal(attention.attentionRequired, true);
    assert.equal(attention.terminal, false);
    assert.equal(attention.messages?.some((message: any) => message.type === "question" && message.subject === "Need operator input"), true);
    await call(client, "agent_bus_cancel", { runId: created.runId, reason: "attention wakeup regression complete" });
  } finally {
    if (client) await client.close().catch(() => {});
    runCli(env, "stop");
    if (broker.pid && alive(broker.pid)) {
      try { process.kill(-broker.pid, "SIGKILL"); } catch { try { process.kill(broker.pid, "SIGKILL"); } catch {} }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
