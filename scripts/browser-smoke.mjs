#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProductServer } from "../dist/product-server.js";

function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try { return execFileSync("which", [name], { encoding: "utf8" }).trim(); } catch {}
  }
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

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

async function waitForJson(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      last = `${res.status} ${await res.text()}`;
    } catch (error) { last = String(error); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${last}`);
}

function cdpSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let id = 0;
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`)); else resolve(msg.result);
    } else if (msg.method) events.push(msg);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  async function send(method, params = {}) {
    await ready;
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return await new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  }
  return { ws, send, events, ready };
}

async function runChrome(url, profileDir, verify, label) {
  const debugPort = await freePort();
  const browser = spawn(chromeBinary(), [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  browser.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
    const page = targets.find((target) => target.type === "page");
    assert.ok(page?.webSocketDebuggerUrl, `${label}: no debuggable page target`);
    const cdp = cdpSocket(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.navigate", { url });

    const deadline = Date.now() + 12_000;
    let lastState = null;
    while (Date.now() < deadline) {
      const result = await cdp.send("Runtime.evaluate", {
        expression: `(() => ({ href: location.href, search: location.search, rootChildren: document.getElementById('root')?.childElementCount ?? -1, mounted: Boolean(document.querySelector('[data-agent-bus-mounted="true"]')), text: document.body.innerText, boot: document.getElementById('agent-bus-boot')?.innerText ?? '', phase: globalThis.__AGENT_BUS_BOOTSTRAP__?.phase ?? '' }))()`,
        returnByValue: true,
      });
      lastState = result.result?.value ?? null;
      if (lastState && await verify(lastState, cdp)) {
        cdp.ws.close();
        return { state: lastState, events: cdp.events };
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const exceptions = cdp.events.filter((event) => event.method === "Runtime.exceptionThrown");
    const consoles = cdp.events.filter((event) => event.method === "Runtime.consoleAPICalled");
    cdp.ws.close();
    throw new Error(`${label}: browser condition not met\nstate=${JSON.stringify(lastState)}\nexceptions=${JSON.stringify(exceptions)}\nconsole=${JSON.stringify(consoles)}\nchrome=${stderr.slice(-4000)}`);
  } finally {
    browser.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      browser.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (browser.exitCode === null) browser.kill("SIGKILL");
  }
}

function fakeConfig() {
  const config = JSON.parse(readFileSync(new URL("../agent-bus.config.json", import.meta.url), "utf8"));
  for (const [id, provider] of Object.entries(config.providers)) if (id !== "fake") provider.enabled = false;
  for (const [id, harness] of Object.entries(config.harnesses)) if (id !== "fake") harness.enabled = false;
  for (const [id, model] of Object.entries(config.models)) if (!id.startsWith("fake-")) model.enabled = false;
  for (const [id, agent] of Object.entries(config.agents)) if (!id.startsWith("fake-")) agent.enabled = false;
  return config;
}

async function issueTicket(handle, token) {
  const response = await fetch(`${handle.url}/dashboard/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  assert.ok(body.ticket);
  return body.ticket;
}

const root = mkdtempSync(join(tmpdir(), "agent-bus-browser-"));
const profile = join(root, "profile");
const replayProfile = join(root, "replay-profile");
const expiredProfile = join(root, "expired-profile");
const operatorTokenPath = join(root, "operator.token");
const config = fakeConfig();

const handle = await startProductServer({
  host: "127.0.0.1",
  port: 0,
  config,
  statePath: join(root, "state.sqlite"),
  logPath: join(root, "bus.jsonl"),
  operatorTokenPath,
});

let expiredHandle = null;
try {
  const token = readFileSync(operatorTokenPath, "utf8").trim();
  const ticket = await issueTicket(handle, token);

  const first = await runChrome(`${handle.url}/?ticket=${encodeURIComponent(ticket)}`, profile, async (state, cdp) => {
    if (!(state.rootChildren > 0 && state.mounted && state.text.includes("Agent Bus") && state.search === "")) return false;
    const cookies = await cdp.send("Network.getCookies", { urls: [handle.url] });
    return cookies.cookies.some((cookie) => cookie.name === "agent_bus_session" && cookie.httpOnly === true);
  }, "ticket login");
  assert.equal(first.state.phase, "mounted");

  const reload = await runChrome(handle.url, profile, async (state) => state.mounted && state.rootChildren > 0 && state.text.includes("Agent Bus") && state.search === "", "session reload");
  assert.ok(reload.state.text.includes("Agent Bus"));

  const replay = await runChrome(`${handle.url}/?ticket=${encodeURIComponent(ticket)}`, replayProfile, async (state) => state.rootChildren > 0 && state.text.includes("invalid or expired"), "replayed ticket diagnostic");
  assert.match(replay.state.text, /invalid or expired/i);

  const expiredTokenPath = join(root, "expired-operator.token");
  expiredHandle = await startProductServer({
    host: "127.0.0.1",
    port: 0,
    config: fakeConfig(),
    statePath: join(root, "expired-state.sqlite"),
    logPath: join(root, "expired-bus.jsonl"),
    operatorTokenPath: expiredTokenPath,
    loginTicketTtlMs: 40,
  });
  const expiredToken = readFileSync(expiredTokenPath, "utf8").trim();
  const expiredTicket = await issueTicket(expiredHandle, expiredToken);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const expired = await runChrome(`${expiredHandle.url}/?ticket=${encodeURIComponent(expiredTicket)}`, expiredProfile, async (state) => state.rootChildren > 0 && state.text.includes("invalid or expired"), "expired ticket diagnostic");
  assert.match(expired.state.text, /invalid or expired/i);

  process.stdout.write("production browser smoke passed\n");
} finally {
  if (expiredHandle) await expiredHandle.close().catch(() => {});
  await handle.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
