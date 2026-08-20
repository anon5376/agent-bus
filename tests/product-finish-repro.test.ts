import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

function runCli(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], { env, encoding: "utf8", timeout: 20_000 });
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

test("upgrading the merged PR5 checkout broker replaces only the requested target listener", { timeout: 30_000 }, async () => {
  const root = temporaryDirectory("agent-bus-pr5-upgrade-");
  const homeA = join(root, "home-a");
  const homeB = join(root, "home-b");
  const configAPath = join(root, "config-a.json");
  const configBPath = join(root, "config-b.json");
  writeFileSync(configAPath, `${JSON.stringify(testConfig(), null, 2)}\n`);
  writeFileSync(configBPath, `${JSON.stringify(testConfig(), null, 2)}\n`);
  const portA = await freePort();
  const portB = await freePort();
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;
  const envA: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BUS_HOME: homeA,
    AGENT_BUS_CONFIG: configAPath,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(portA),
    AGENT_BUS_URL: urlA,
  };
  const envB: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BUS_HOME: homeB,
    AGENT_BUS_CONFIG: configBPath,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(portB),
    AGENT_BUS_URL: urlB,
  };
  const pr5Path = join(root, "pr5-checkout", "dist", "cli.js");
  mkdirSync(join(root, "pr5-checkout", "dist"), { recursive: true });
  writeFileSync(pr5Path, `
    const http = require("node:http");
    const port = Number(process.env.AGENT_BUS_PORT);
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({
          ok: true, pid: process.pid, product: "agent-bus", productProtocol: 1,
          buildId: "merged-pr5-checkout", dashboard: true, uiBuilt: true,
          durable: true, agents: 2, tasks: 1, runs: 1
        }));
        return;
      }
      if (req.url === "/state" && req.method === "POST") { res.end(JSON.stringify({ roster: [] })); return; }
      res.statusCode = 404; res.end("{}");
    });
    server.listen(port, "127.0.0.1");
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `);
  const pr5 = spawn(process.execPath, [pr5Path, "broker"], { env: envA, stdio: "ignore", detached: true });
  const peer = spawn(process.execPath, ["dist/cli.js", "broker"], { env: envB, stdio: "ignore", detached: true });
  try {
    const pr5Health = await waitForHealth(urlA);
    assert.equal(pr5Health.product, "agent-bus");
    assert.equal(pr5Health.runtime, undefined, "fixture must match PR5 and omit PR6 runtime identity");
    const peerHealth = await waitForHealth(urlB);

    const upgraded = runCli(envA, "start", "--no-open");
    assert.equal(upgraded.status, 0, `${upgraded.stdout}\n${upgraded.stderr}`);
    const current = await waitForHealth(urlA);
    assert.equal(current.product, "agent-bus");
    assert.ok(current.runtime?.busHome, "replacement must be the PR6 runtime with scoped identity");
    assert.notEqual(current.pid, pr5.pid, "PR5 target listener must be replaced");
    const deadline = Date.now() + 5_000;
    while (pr5.pid && alive(pr5.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(pr5.pid ? alive(pr5.pid) : false, false, "PR5 target process must exit");

    const peerAfter = await waitForHealth(urlB);
    assert.equal(peerAfter.pid, peerHealth.pid, "different-home peer on another port must survive PR5 upgrade");
  } finally {
    runCli(envA, "stop");
    runCli(envB, "stop");
    if (pr5.pid && alive(pr5.pid)) { try { process.kill(-pr5.pid, "SIGKILL"); } catch {} }
    if (peer.pid && alive(peer.pid)) { try { process.kill(-peer.pid, "SIGKILL"); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
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

test("PID start-fingerprint mismatch prevents operator kill after ownership record becomes stale", { timeout: 20_000 }, async () => {
  const root = temporaryDirectory("agent-bus-pid-reuse-");
  const home = join(root, "home");
  const project = join(root, "project");
  const configPath = join(root, "config.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const config = testConfig();
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, AGENT_BUS_HOME: home, AGENT_BUS_CONFIG: configPath, AGENT_BUS_PORT: String(port), AGENT_BUS_URL: url, AGENT_BUS_HOST: "127.0.0.1" };
  const broker = spawn(process.execPath, ["dist/cli.js", "broker"], { env, stdio: "ignore", detached: true });
  let supervisor: ReturnType<typeof spawn> | null = null;
  try {
    await waitForHealth(url);
    const operator = readFileSync(join(home, "operator.token"), "utf8").trim();
    const provision = await post<any>(url, "/agent/provision", { token: operator, id: "fake-small" });
    mkdirSync(join(home, "tokens"), { recursive: true });
    writeFileSync(join(home, "tokens", "fake-small.token"), `${provision.body.token}\n`, { mode: 0o600 });
    supervisor = spawn(process.execPath, ["dist/cli.js", "supervise", "fake-small", project], { env, stdio: "ignore", detached: true });
    assert.ok(supervisor.pid);
    const deadline = Date.now() + 5_000;
    let verified = false;
    while (Date.now() < deadline) {
      const roster = await post<any>(url, "/roster", {});
      verified = roster.body.roster?.some((agent: any) => agent.id === "fake-small" && agent.supervisorPid === supervisor!.pid);
      if (verified) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.equal(verified, true, "real supervisor should establish verified ownership");
    const recordPath = join(home, "runtime", "processes", `${supervisor.pid}.json`);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.startFingerprint = `${record.startFingerprint} stale-reuse`;
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    const killed = await post<any>(url, "/kill", { token: operator, agentId: "fake-small" });
    assert.equal(killed.status, 409, JSON.stringify(killed.body));
    assert.equal(alive(supervisor.pid!), true, "stale/reused PID fingerprint must never be killed");
  } finally {
    if (supervisor?.pid && alive(supervisor.pid)) { try { process.kill(-supervisor.pid, "SIGKILL"); } catch {} }
    if (broker.pid && alive(broker.pid)) { try { process.kill(-broker.pid, "SIGKILL"); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
});

test("genuine fingerprint-verified supervisor remains stoppable by operator", { timeout: 20_000 }, async () => {
  const root = temporaryDirectory("agent-bus-genuine-supervisor-");
  const home = join(root, "home");
  const project = join(root, "project");
  const configPath = join(root, "config.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(testConfig(), null, 2)}\n`);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, AGENT_BUS_HOME: home, AGENT_BUS_CONFIG: configPath, AGENT_BUS_PORT: String(port), AGENT_BUS_URL: url, AGENT_BUS_HOST: "127.0.0.1" };
  const broker = spawn(process.execPath, ["dist/cli.js", "broker"], { env, stdio: "ignore", detached: true });
  let supervisor: ReturnType<typeof spawn> | null = null;
  try {
    await waitForHealth(url);
    const operator = readFileSync(join(home, "operator.token"), "utf8").trim();
    const provision = await post<any>(url, "/agent/provision", { token: operator, id: "fake-small" });
    mkdirSync(join(home, "tokens"), { recursive: true });
    writeFileSync(join(home, "tokens", "fake-small.token"), `${provision.body.token}\n`, { mode: 0o600 });
    supervisor = spawn(process.execPath, ["dist/cli.js", "supervise", "fake-small", project], { env, stdio: "ignore", detached: true });
    assert.ok(supervisor.pid);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const roster = await post<any>(url, "/roster", {});
      if (roster.body.roster?.some((agent: any) => agent.id === "fake-small" && agent.supervisorPid === supervisor!.pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const killed = await post<any>(url, "/kill", { token: operator, agentId: "fake-small" });
    assert.equal(killed.status, 200, JSON.stringify(killed.body));
    const downDeadline = Date.now() + 5_000;
    while (alive(supervisor.pid!) && Date.now() < downDeadline) await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(alive(supervisor.pid!), false, "verified supervisor should stop normally");
  } finally {
    if (supervisor?.pid && alive(supervisor.pid)) { try { process.kill(-supervisor.pid, "SIGKILL"); } catch {} }
    if (broker.pid && alive(broker.pid)) { try { process.kill(-broker.pid, "SIGKILL"); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
});
