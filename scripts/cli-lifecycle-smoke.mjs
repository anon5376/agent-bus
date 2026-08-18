#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const config = JSON.parse(readFileSync("agent-bus.config.json", "utf8"));
  for (const [id, provider] of Object.entries(config.providers)) if (id !== "fake") provider.enabled = false;
  for (const [id, harness] of Object.entries(config.harnesses)) if (id !== "fake") harness.enabled = false;
  for (const [id, model] of Object.entries(config.models)) if (!id.startsWith("fake-")) model.enabled = false;
  for (const [id, agent] of Object.entries(config.agents)) if (!id.startsWith("fake-")) agent.enabled = false;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function startFixtureServer(port, kind) {
  const code = `
    const http=require('node:http');
    const kind=${JSON.stringify(kind)};
    const server=http.createServer((req,res)=>{
      res.setHeader('content-type','application/json');
      if(req.url==='/health'){
        const body=kind==='legacy'
          ? {ok:true,pid:process.pid,agents:0,tasks:0,runs:0,durable:true}
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

  const stop = runCli(env, "stop");
  assert.equal(stop.status, 0, `stop failed:\n${stop.stdout}\n${stop.stderr}`);
  await waitForDown(url);

  const legacy = startFixtureServer(port, "legacy");
  await waitForHealth(url, (body) => body.durable === true && !body.product);
  const replace = runCli(env, "start", "--no-open");
  assert.equal(replace.status, 0, `legacy replacement failed:\n${replace.stdout}\n${replace.stderr}`);
  const replacedHealth = await waitForHealth(url, (body) => body.product === "agent-bus" && body.dashboard === true);
  assert.notEqual(replacedHealth.pid, legacy.pid, "legacy listener should be replaced");
  await waitForProcessDown(legacy.pid);
  assert.equal(runCli(env, "stop").status, 0);
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
