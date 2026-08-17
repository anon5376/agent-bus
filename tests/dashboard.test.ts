import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startBroker } from "../src/broker.js";
import { startDashboard } from "../src/dashboard.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

async function fixture() {
  const root = temporaryDirectory("agent-bus-dashboard-");
  const operatorTokenPath = join(root, "operator.token");
  const configPath = join(root, "config.json");
  const staticRoot = join(root, "web");
  mkdirSync(staticRoot);
  writeFileSync(configPath, JSON.stringify(testConfig(), null, 2));
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Agent Bus Test</title>");
  writeFileSync(join(staticRoot, "app.js"), "console.log('test')");
  writeFileSync(join(staticRoot, "styles.css"), "body{}\n");
  const broker = await startBroker({
    port: 0,
    config: testConfig(),
    statePath: join(root, "state.sqlite"),
    logPath: join(root, "bus.jsonl"),
    operatorTokenPath,
  });
  const dashboard = await startDashboard({
    port: 0,
    brokerUrl: broker.url,
    operatorTokenPath,
    configPath,
    staticRoot,
  });
  return { root, broker, dashboard, operatorTokenPath, configPath };
}

function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

test("dashboard serves static UI and protects API behind a session cookie", async (t) => {
  const f = await fixture();
  t.after(async () => { await f.dashboard.close(); await f.broker.close(); });
  const page = await fetch(`${f.dashboard.url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Agent Bus Test/);
  const cookie = cookieFrom(page);
  assert.match(cookie, /^agent_bus_dashboard=/);

  const unauthorized = await fetch(`${f.dashboard.url}/api/state`);
  assert.equal(unauthorized.status, 401);

  const state = await fetch(`${f.dashboard.url}/api/state`, { headers: { cookie } });
  assert.equal(state.status, 200);
  const body = await state.json() as any;
  assert.ok(Array.isArray(body.roster));
  assert.ok(Array.isArray(body.runs));
});

test("dashboard mutations require same origin and can create real persisted runs", async (t) => {
  const f = await fixture();
  t.after(async () => { await f.dashboard.close(); await f.broker.close(); });
  const page = await fetch(`${f.dashboard.url}/`);
  const cookie = cookieFrom(page);
  const payload = JSON.stringify({ projectRoot: f.root, goal: "exercise dashboard API" });

  const csrf = await fetch(`${f.dashboard.url}/api/runs`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: payload,
  });
  assert.equal(csrf.status, 401);

  const created = await fetch(`${f.dashboard.url}/api/runs`, {
    method: "POST",
    headers: {
      cookie,
      origin: f.dashboard.url,
      "content-type": "application/json",
    },
    body: payload,
  });
  assert.equal(created.status, 200, await created.text());
  const listed = await fetch(`${f.dashboard.url}/api/runs`, { headers: { cookie } });
  const listBody = await listed.json() as any;
  assert.equal(listBody.runs.length, 1);
  assert.equal(listBody.runs[0].goal, "exercise dashboard API");
});

test("dashboard exposes an authenticated SSE stream", async (t) => {
  const f = await fixture();
  t.after(async () => { await f.dashboard.close(); await f.broker.close(); });
  const page = await fetch(`${f.dashboard.url}/`);
  const cookie = cookieFrom(page);
  const controller = new AbortController();
  const response = await fetch(`${f.dashboard.url}/api/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /connected|snapshot/);
  controller.abort();
});
