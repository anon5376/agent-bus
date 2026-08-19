import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { classifyPortOwner } from "../src/process-management.js";
import { startBroker } from "../src/broker.js";
import { startProductServer } from "../src/product-server.js";
import { post, temporaryDirectory, testConfig } from "./helpers.js";

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

async function waitForTask(url: string, taskId: string, states: string[], timeoutMs = 10_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await post<any>(url, "/task/get", { taskId });
    if (states.includes(response.body.task?.state)) return response.body.task;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`task ${taskId} did not reach ${states.join(",")}`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("direct public supervise resolves the running broker config instead of conflicting project-local config", { timeout: 25_000 }, async () => {
  const root = temporaryDirectory("agent-bus-direct-supervise-");
  const home = join(root, "home");
  const project = join(root, "project");
  const localDir = join(project, ".agent-bus");
  mkdirSync(localDir, { recursive: true });
  const configAPath = join(root, "config-a.json");
  const configA = testConfig();
  for (const [id, agent] of Object.entries(configA.agents)) agent.enabled = id === "fake-small";
  configA.agents["fake-small"].harnessOptions = { mode: "success" };
  configA.constraints.maxRetries = 0;
  writeFileSync(configAPath, `${JSON.stringify(configA, null, 2)}\n`);
  const configB = structuredClone(configA);
  configB.agents["fake-small"].harnessOptions = { mode: "fail" };
  writeFileSync(join(localDir, "config.json"), `${JSON.stringify(configB, null, 2)}\n`);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const baseEnv = {
    ...process.env,
    AGENT_BUS_HOME: home,
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_URL: url,
  };
  const broker = spawn(process.execPath, ["dist/cli.js", "broker"], {
    env: { ...baseEnv, AGENT_BUS_CONFIG: configAPath },
    stdio: "ignore",
    detached: true,
  });
  let supervisor: ReturnType<typeof spawn> | null = null;
  try {
    await waitForHealth(url);
    const operator = readFileSync(join(home, "operator.token"), "utf8").trim();
    const provision = await post<any>(url, "/agent/provision", { token: operator, id: "fake-small" });
    assert.equal(provision.status, 200, JSON.stringify(provision.body));
    mkdirSync(join(home, "tokens"), { recursive: true });
    writeFileSync(join(home, "tokens", "fake-small.token"), `${provision.body.token}\n`, { mode: 0o600 });

    const superviseEnv = { ...baseEnv } as NodeJS.ProcessEnv;
    delete superviseEnv.AGENT_BUS_CONFIG;
    supervisor = spawn(process.execPath, ["dist/cli.js", "supervise", "fake-small", project], {
      env: superviseEnv,
      stdio: "ignore",
      detached: true,
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const roster = await post<any>(url, "/roster", {});
      if (roster.body.roster?.some((agent: any) => agent.id === "fake-small" && agent.status !== "offline")) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const created = await post<any>(url, "/task/create", {
      token: operator,
      assignee: "fake-small",
      title: "prove authoritative config",
      brief: "complete deterministically",
      role: "cheap-worker",
      complexity: 1,
      readOnly: true,
      reviewRequired: false,
      maxRetries: 0,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const task = await waitForTask(url, created.body.task.id, ["submitted", "failed"]);
    assert.equal(task.state, "submitted", "direct supervise must execute broker config A (success), not project-local config B (fail)");
  } finally {
    if (supervisor?.pid && alive(supervisor.pid)) { try { process.kill(-supervisor.pid, "SIGKILL"); } catch {} }
    if (broker.pid && alive(broker.pid)) { try { process.kill(-broker.pid, "SIGKILL"); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrading the merged PR5 target listener is positively identified", () => {
  const owner = classifyPortOwner(
    4242,
    "/opt/homebrew/bin/node /Users/me/code/agent-bus/dist/cli.js broker",
    {
      ok: true,
      pid: 4242,
      product: "agent-bus",
      productProtocol: 2,
      buildId: "pr5-build",
      dashboard: true,
      uiBuilt: true,
      durable: true,
      agents: 3,
      tasks: 1,
      runs: 1,
    },
    "pr6-build",
    false,
    { busHome: "/Users/me/.agent-bus", applicationRoot: "/Users/me/.agent-bus/app/current" },
  );
  assert.equal(owner.kind, "agent-bus");
});

test("integration guard compares candidate config against live broker state, not drifted disk", async (t) => {
  const root = temporaryDirectory("agent-bus-live-drift-");
  const configPath = join(root, "config.json");
  const staticRoot = join(root, "web");
  const operatorTokenPath = join(root, "operator.token");
  mkdirSync(staticRoot);
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><div id=root></div>");
  const live = testConfig();
  writeFileSync(configPath, `${JSON.stringify(live, null, 2)}\n`);
  const handle = await startProductServer({
    port: 0,
    configPath,
    staticRoot,
    statePath: join(root, "state.sqlite"),
    logPath: join(root, "bus.jsonl"),
    operatorTokenPath,
  });
  t.after(() => handle.close());
  const operator = readFileSync(operatorTokenPath, "utf8").trim();
  const ticketRes = await fetch(`${handle.url}/dashboard/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: operator }) });
  const ticket = (await ticketRes.json() as any).ticket;
  const sessionRes = await fetch(`${handle.url}/api/session`, { method: "POST", headers: { origin: handle.url, "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
  const cookie = (sessionRes.headers.get("set-cookie") ?? "").split(";")[0];
  (handle.service.supervisorMeta as any).set("fake-small", { pid: 424242, childPid: null, workdir: root, cli: "fake", startedAt: Date.now() });

  const drifted = structuredClone(live);
  drifted.agents["fake-small"].permissions.shell = !live.agents["fake-small"].permissions.shell;
  drifted.agents["fake-small"].harnessOptions = { mode: "fail" };
  writeFileSync(configPath, `${JSON.stringify(drifted, null, 2)}\n`);
  const diskBefore = readFileSync(configPath, "utf8");
  const liveBefore = structuredClone(handle.service.config);

  const response = await fetch(`${handle.url}/api/integrations`, {
    method: "POST",
    headers: { cookie, origin: handle.url, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "command",
      providerId: "unrelated-new-provider",
      harnessId: "unrelated-new-harness",
      modelId: "unrelated-new-model",
      agentId: "unrelated-new-agent",
      role: "cheap-worker",
      command: process.execPath,
    }),
  });
  assert.equal(response.status, 409, await response.text());
  assert.equal(readFileSync(configPath, "utf8"), diskBefore);
  assert.deepEqual(handle.service.config, liveBefore);
});

test("agent-supplied supervisor PID cannot make operator kill an unrelated process", { timeout: 10_000 }, async (t) => {
  const root = temporaryDirectory("agent-bus-pid-attack-");
  const handle = await startBroker({
    port: 0,
    config: testConfig(),
    statePath: join(root, "state.sqlite"),
    logPath: join(root, "bus.jsonl"),
    operatorTokenPath: join(root, "operator.token"),
  });
  t.after(() => handle.close());
  const operator = readFileSync(join(root, "operator.token"), "utf8").trim();
  const provision = await post<any>(handle.url, "/agent/provision", { token: operator, id: "fake-small" });
  const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
  try {
    assert.ok(victim.pid);
    const registered = await post<any>(handle.url, "/register", { token: provision.body.token, id: "fake-small", pid: victim.pid, workdir: root, cli: "fake" });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    await post(handle.url, "/kill", { token: operator, agentId: "fake-small" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(alive(victim.pid!), true, "valid agent token must not be able to nominate an unrelated PID for operator termination");
  } finally {
    if (victim.pid && alive(victim.pid)) { try { process.kill(-victim.pid, "SIGKILL"); } catch {} }
  }
});
