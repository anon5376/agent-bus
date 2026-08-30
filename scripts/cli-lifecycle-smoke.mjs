#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadFakeOnlyTestConfig } from "./fake-only-test-config.mjs";

function freePort() {
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

async function waitForHealth(url, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const body = await response.json();
        if (predicate(body)) return body;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timed out waiting for health at ${url}`);
}

async function waitForDown(url, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(400) });
      if (!response.ok) return;
    } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`${url} remained online`);
}

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessDown(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`process ${pid} remained alive`);
}

function runCli(env, ...args) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function fakeConfig(path) {
  writeFileSync(path, `${JSON.stringify(loadFakeOnlyTestConfig(), null, 2)}\n`);
}

function startFixtureServer(port, kind, scriptPath = null) {
  const code = `
    const http=require('node:http');
    const kind=${JSON.stringify(kind)};
    const server=http.createServer((req,res)=>{
      res.setHeader('content-type','application/json');
      if(req.url==='/health'){
        const body=kind==='legacy'
          ? {ok:true,pid:process.pid,agents:0,tasks:0,runs:0,durable:true}
          : kind==='pr5'
            ? {ok:true,pid:process.pid,product:'agent-bus',productProtocol:1,buildId:'merged-pr5-checkout',dashboard:true,uiBuilt:true,agents:2,tasks:1,runs:1,durable:true}
            : {ok:true,pid:process.pid,service:'not-agent-bus'};
        res.end(JSON.stringify(body)); return;
      }
      if(req.url==='/catalog'&&req.method==='POST'&&kind==='legacy'){
        res.end(JSON.stringify({capabilityNotice:'legacy Agent Bus',providers:{},harnesses:{},models:{},roles:{},agents:{},constraints:{}}));return;
      }
      if(req.url==='/state'&&req.method==='POST'){res.end(JSON.stringify({roster:[]}));return;}
      res.statusCode=404;res.end('{}');
    });
    server.listen(${port},'127.0.0.1');
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `;
  if (scriptPath) {
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, code);
    return spawn(process.execPath, [scriptPath], { stdio: "ignore", detached: true });
  }
  return spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: true });
}

const temp = mkdtempSync(join(tmpdir(), "agent-bus-lifecycle-"));
const configPath = join(temp, "config.json");
fakeConfig(configPath);
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  AGENT_BUS_HOME: join(temp, "home"),
  AGENT_BUS_PORT: String(port),
  AGENT_BUS_HOST: "127.0.0.1",
  AGENT_BUS_URL: url,
  AGENT_BUS_CONFIG: configPath,
};

try {
  const first = runCli(env, "start", "--no-open");
  assert.equal(first.status, 0, `first start failed:\n${first.stdout}\n${first.stderr}`);
  const firstHealth = await waitForHealth(url, (body) => body.product === "agent-bus" && body.dashboard === true);

  const second = runCli(env, "start", "--no-open");
  assert.equal(second.status, 0, `second start failed:\n${second.stdout}\n${second.stderr}`);
  const secondHealth = await waitForHealth(url, (body) => body.product === "agent-bus" && body.dashboard === true);
  assert.equal(secondHealth.pid, firstHealth.pid, "repeated start should reuse the current matching product");

  const secondPort = await freePort();
  const secondUrl = `http://127.0.0.1:${secondPort}`;
  const sameHomeEnv = { ...env, AGENT_BUS_PORT: String(secondPort), AGENT_BUS_URL: secondUrl };
  const secondInstanceStart = runCli(sameHomeEnv, "start", "--no-open");
  assert.equal(secondInstanceStart.status, 0, `same-home second instance failed:\n${secondInstanceStart.stdout}\n${secondInstanceStart.stderr}`);
  const secondInstanceHealth = await waitForHealth(secondUrl, (body) => body.product === "agent-bus");

  const stop = runCli(env, "stop");
  assert.equal(stop.status, 0, `stop failed:\n${stop.stdout}\n${stop.stderr}`);
  await waitForDown(url);
  const secondAfterStop = await waitForHealth(secondUrl, (body) => body.product === "agent-bus");
  assert.equal(secondAfterStop.pid, secondInstanceHealth.pid, "same-home different-port instance must remain alive");
  assert.equal(runCli(sameHomeEnv, "stop").status, 0);
  await waitForDown(secondUrl);

  const unhealthyPairStart = runCli(env, "start", "--no-open");
  assert.equal(unhealthyPairStart.status, 0, `unhealthy pair setup failed:\n${unhealthyPairStart.stdout}\n${unhealthyPairStart.stderr}`);
  const unhealthyPairHealth = await waitForHealth(url, (body) => body.product === "agent-bus");
  const otherPort = await freePort();
  const otherUrl = `http://127.0.0.1:${otherPort}`;
  const otherEnv = { ...env, AGENT_BUS_HOME: join(temp, "home-b"), AGENT_BUS_PORT: String(otherPort), AGENT_BUS_URL: otherUrl };
  const otherStart = runCli(otherEnv, "start", "--no-open");
  assert.equal(otherStart.status, 0, `different-home peer failed:\n${otherStart.stdout}\n${otherStart.stderr}`);
  const otherHealth = await waitForHealth(otherUrl, (body) => body.product === "agent-bus");
  process.kill(unhealthyPairHealth.pid, "SIGSTOP");
  const unhealthyPairStop = runCli(env, "stop");
  assert.equal(unhealthyPairStop.status, 0, `unhealthy scoped stop failed:\n${unhealthyPairStop.stdout}\n${unhealthyPairStop.stderr}`);
  await waitForProcessDown(unhealthyPairHealth.pid);
  const otherAfter = await waitForHealth(otherUrl, (body) => body.product === "agent-bus");
  assert.equal(otherAfter.pid, otherHealth.pid, "different-home peer from same checkout must remain alive");
  assert.equal(runCli(otherEnv, "stop").status, 0);
  await waitForDown(otherUrl);

  const legacy = startFixtureServer(port, "legacy", join(env.AGENT_BUS_HOME, "app", "releases", "legacy-fixture", "dist", "broker.js"));
  await waitForHealth(url, (body) => body.durable === true && !body.product);
  const replace = runCli(env, "start", "--no-open");
  assert.equal(replace.status, 0, `legacy replacement failed:\n${replace.stdout}\n${replace.stderr}`);
  const replacedHealth = await waitForHealth(url, (body) => body.product === "agent-bus" && body.dashboard === true);
  assert.notEqual(replacedHealth.pid, legacy.pid, "legacy listener should be replaced");
  await waitForProcessDown(legacy.pid);
  assert.equal(runCli(env, "stop").status, 0);
  await waitForDown(url);

  const pr5 = startFixtureServer(port, "pr5", join(temp, "merged-pr5-checkout", "dist", "cli.js"));
  const pr5Health = await waitForHealth(url, (body) => body.product === "agent-bus" && body.buildId === "merged-pr5-checkout");
  assert.equal(pr5Health.pid, pr5.pid);
  const upgrade = runCli(env, "start", "--no-open");
  assert.equal(upgrade.status, 0, `PR5 to PR6 replacement failed:\n${upgrade.stdout}\n${upgrade.stderr}`);
  const upgradedHealth = await waitForHealth(url, (body) => body.product === "agent-bus" && body.dashboard === true && body.buildId !== "merged-pr5-checkout");
  assert.notEqual(upgradedHealth.pid, pr5.pid, "merged PR5 target listener must be replaced by the current product");
  await waitForProcessDown(pr5.pid);
  assert.equal(runCli(env, "stop").status, 0);
  await waitForDown(url);

  const unhealthyStart = runCli(env, "start", "--no-open");
  assert.equal(unhealthyStart.status, 0, `unhealthy recovery setup failed:\n${unhealthyStart.stdout}\n${unhealthyStart.stderr}`);
  const unhealthyHealth = await waitForHealth(url, (body) => body.product === "agent-bus");
  process.kill(unhealthyHealth.pid, "SIGSTOP");
  const unhealthyStop = runCli(env, "stop");
  assert.equal(unhealthyStop.status, 0, `unhealthy instance stop failed:\n${unhealthyStop.stdout}\n${unhealthyStop.stderr}`);
  assert.match(`${unhealthyStop.stdout}${unhealthyStop.stderr}`, /forced/i);
  await waitForProcessDown(unhealthyHealth.pid);
  await waitForDown(url);

  const unrelated = startFixtureServer(port, "unrelated");
  await waitForHealth(url, (body) => body.service === "not-agent-bus");
  const protectedStart = runCli(env, "start", "--no-open");
  assert.notEqual(protectedStart.status, 0, "Agent Bus must refuse to kill an unrelated port owner");
  assert.match(`${protectedStart.stderr}${protectedStart.stdout}`, /unrelated process/i);
  assert.equal(processAlive(unrelated.pid), true, "unrelated listener must remain alive");
  unrelated.kill("SIGTERM");
  await waitForProcessDown(unrelated.pid);

  const malformedPath = join(temp, "malformed-config.json");
  writeFileSync(malformedPath, "{ definitely-not-json\n");
  const malformed = runCli({ ...env, AGENT_BUS_CONFIG: malformedPath }, "start", "--no-open");
  assert.notEqual(malformed.status, 0, "malformed configuration must fail startup");
  const diagnostic = `${malformed.stderr}${malformed.stdout}`;
  assert.match(diagnostic, /Broker log tail:/i, "startup must surface the useful broker log tail");
  assert.match(diagnostic, /could not parse|invalid JSON/i, "startup must surface the configuration parse failure");

  process.stdout.write("CLI lifecycle smoke passed\n");
} finally {
  runCli(env, "stop");
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
