#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      const response = await fetch(url);
      if (response.ok) return await response.json();
      last = `${response.status} ${await response.text()}`;
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
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`)); else resolve(message.result);
    } else if (message.method) {
      events.push(message);
      if (events.length > 8000) events.shift();
    }
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

async function runChrome(url, profileDir, verify, label, options = {}) {
  const debugPort = await freePort();
  mkdirSync(profileDir, { recursive: true });
  const browser = spawn(chromeBinary(), [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  browser.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    try {
      await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, 20_000);
    } catch (error) {
      throw new Error(`${error.message}\nChrome exit=${browser.exitCode} signal=${browser.signalCode}\n${stderr.slice(-5000)}`);
    }
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
    const page = targets.find((target) => target.type === "page");
    assert.ok(page?.webSocketDebuggerUrl, `${label}: no debuggable page target`);
    const cdp = cdpSocket(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Log.enable");
    if (options.beforeNavigate) await options.beforeNavigate(cdp);
    await cdp.send("Page.navigate", { url });

    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    let lastState = null;
    let iteration = 0;
    while (Date.now() < deadline) {
      iteration += 1;
      const result = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const boot = globalThis.__AGENT_BUS_BOOT__?.state ?? null;
          return {
            href: location.href,
            search: location.search,
            rootChildren: document.getElementById('root')?.childElementCount ?? -1,
            mounted: Boolean(document.querySelector('[data-agent-bus-mounted="true"]')),
            text: document.body.innerText,
            boot,
            serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
            scripts: Array.from(document.scripts).map(script => script.src).filter(Boolean),
            styles: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(link => link.href)
          };
        })()`,
        returnByValue: true,
      });
      lastState = result.result?.value ?? null;
      if (lastState && await verify(lastState, cdp, iteration)) {
        const events = cdp.events.slice();
        cdp.ws.close();
        return { state: lastState, events, stderr };
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const exceptions = cdp.events.filter((event) => event.method === "Runtime.exceptionThrown");
    const consoles = cdp.events.filter((event) => event.method === "Runtime.consoleAPICalled");
    const failedRequests = cdp.events.filter((event) => event.method === "Network.loadingFailed");
    const logs = cdp.events.filter((event) => event.method === "Log.entryAdded");
    cdp.ws.close();
    throw new Error(`${label}: browser condition not met\nstate=${JSON.stringify(lastState)}\nexceptions=${JSON.stringify(exceptions)}\nconsole=${JSON.stringify(consoles)}\nfailedRequests=${JSON.stringify(failedRequests)}\nlogs=${JSON.stringify(logs)}\nchrome=${stderr.slice(-4000)}`);
  } finally {
    browser.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1800);
      browser.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (browser.exitCode === null) {
      browser.kill("SIGKILL");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1200);
        browser.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

function assertCleanBrowser(result, label, options = {}) {
  const exceptions = result.events.filter((event) => event.method === "Runtime.exceptionThrown");
  const consoleErrors = result.events.filter((event) => event.method === "Runtime.consoleAPICalled" && event.params?.type === "error");
  const allowedStatusUrls = new Set(options.allowedStatusUrls ?? []);
  const logErrors = result.events.filter((event) => {
    if (event.method !== "Log.entryAdded" || event.params?.entry?.level !== "error") return false;
    const url = event.params?.entry?.url ? new URL(event.params.entry.url).pathname : "";
    return !allowedStatusUrls.has(url);
  });
  const failedRequests = result.events.filter((event) => event.method === "Network.loadingFailed" && !event.params?.canceled && event.params?.errorText !== "net::ERR_ABORTED");
  assert.equal(exceptions.length, 0, `${label}: uncaught browser exceptions: ${JSON.stringify(exceptions)}`);
  assert.equal(consoleErrors.length, 0, `${label}: console errors: ${JSON.stringify(consoleErrors)}`);
  assert.equal(logErrors.length, 0, `${label}: browser log errors: ${JSON.stringify(logErrors)}`);
  assert.equal(failedRequests.length, 0, `${label}: failed network requests: ${JSON.stringify(failedRequests)}`);
}

function assertAllCheckpoints(state, label) {
  assert.equal(state.boot?.failed, false, `${label}: boot monitor reported failure: ${JSON.stringify(state.boot?.failure)}`);
  assert.equal(state.boot?.highest, 10, `${label}: expected checkpoint 10, got ${state.boot?.highest}`);
  for (let number = 1; number <= 10; number += 1) {
    assert.ok(state.boot?.stages?.[number - 1], `${label}: checkpoint ${number} was not recorded`);
  }
}

async function verifyAgentModelFields(cdp) {
  await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.right .pane-head button')?.click()" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  async function selectModel(id) {
    const changed = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const select=document.querySelector('[data-agent-model-select="true"]'); if(!select)return false; select.value=${JSON.stringify(id)}; select.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`,
      returnByValue: true,
    });
    assert.equal(changed.result?.value, true, "agent model selector was not found");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => ({exact:document.querySelector('[data-agent-model-exact="true"]')?.value??null,family:document.querySelector('[data-agent-model-family="true"]')?.value??null}))()`,
      returnByValue: true,
    });
    return result.result?.value;
  }
  const small = await selectModel("fake-small");
  assert.equal(small?.exact, "fake-small");
  const strong = await selectModel("fake-strong");
  assert.equal(strong?.exact, "fake-strong", "model metadata must update when model selection changes");
  assert.equal(strong?.family, "fake");
  await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.modal .modal-head button')?.click()" });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function verifyRuntimeAssets(baseUrl) {
  const response = await fetch(`${baseUrl}/diagnostics/runtime?asset_probe=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  const diagnosticText = await response.text();
  assert.equal(response.status, 200, diagnosticText);
  const diagnostic = JSON.parse(diagnosticText);
  const runtime = diagnostic.runtime;
  assert.equal(diagnostic.product, "agent-bus");
  assert.equal(typeof diagnostic.buildId, "string");
  assert.equal(runtime.pid, process.pid);
  assert.equal(runtime.nodePath, process.execPath);
  assert.match(runtime.staticRoot, /dist\/web$/);
  assert.ok(runtime.ui.index);
  assert.ok(runtime.ui.scripts.some((entry) => entry.url.startsWith("/assets/")));

  const assets = [runtime.ui.index, ...runtime.ui.scripts, ...runtime.ui.styles];
  const bodies = new Map();
  for (const asset of assets) {
    const pathname = asset.path === "index.html" ? "/" : asset.url;
    const assetResponse = await fetch(`${baseUrl}${pathname}?runtime_hash=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
    assert.equal(assetResponse.status, 200, `${pathname} returned ${assetResponse.status}`);
    const body = Buffer.from(await assetResponse.arrayBuffer());
    assert.equal(sha256(body), asset.sha256, `${pathname} did not match the runtime manifest`);
    bodies.set(pathname, body.toString("utf8"));
    const cacheControl = assetResponse.headers.get("cache-control") ?? "";
    if (pathname === "/") assert.match(cacheControl, /no-store/);
    else if (pathname.startsWith("/assets/")) assert.match(cacheControl, /immutable/);
    else assert.match(cacheControl, /no-cache/);
  }
  assert.match(bodies.get("/") ?? "", /data-boot-stage="10"/);
  const applicationScript = runtime.ui.scripts.find((entry) => entry.url.startsWith("/assets/"));
  const applicationBody = bodies.get(applicationScript.url) ?? "";
  assert.match(applicationBody, /createRoot returned successfully/);
  assert.match(applicationBody, /POST \/api\/session started/);
  assert.match(applicationBody, /authenticated dashboard committed to the DOM/);
  return diagnostic;
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
const reloadProfile = join(root, "reload-profile");
const replayProfile = join(root, "replay-profile");
const expiredProfile = join(root, "expired-profile");
const blockedProfile = join(root, "blocked-profile");
const noJavascriptProfile = join(root, "no-javascript-profile");
const rejectionProfile = join(root, "rejection-profile");
const cspProfile = join(root, "csp-profile");
const operatorTokenPath = join(root, "operator.token");

const handle = await startProductServer({
  host: "127.0.0.1",
  port: 0,
  config: fakeConfig(),
  statePath: join(root, "state.sqlite"),
  logPath: join(root, "bus.jsonl"),
  operatorTokenPath,
});

let expiredHandle = null;
try {
  const runtime = await verifyRuntimeAssets(handle.url);
  const applicationScript = runtime.runtime.ui.scripts.find((entry) => entry.url.startsWith("/assets/"));
  assert.ok(applicationScript?.url);

  const token = readFileSync(operatorTokenPath, "utf8").trim();
  const ticket = await issueTicket(handle, token);

  let agentModelFieldsChecked = false;
  let sessionCookie = null;
  const first = await runChrome(`${handle.url}/?ticket=${encodeURIComponent(ticket)}&build=${encodeURIComponent(runtime.buildId)}&launch=chrome-smoke`, profile, async (state, cdp) => {
    if (!(state.mounted && state.rootChildren > 0 && state.text.includes("Agent Bus") && state.search === "" && state.boot?.highest === 10)) return false;
    if (!agentModelFieldsChecked) { await verifyAgentModelFields(cdp); agentModelFieldsChecked = true; }
    const cookies = await cdp.send("Network.getCookies", { urls: [handle.url] });
    sessionCookie = cookies.cookies.find((cookie) => cookie.name === "agent_bus_session" && cookie.httpOnly === true) ?? null;
    return Boolean(sessionCookie);
  }, "ticket login");
  assertAllCheckpoints(first.state, "ticket login");
  assert.equal(first.state.boot.runtime.buildId, runtime.buildId);
  assert.equal(first.state.serviceWorkerControlled, false);
  assertCleanBrowser(first, "ticket login");

  const responseUrls = first.events.filter((event) => event.method === "Network.responseReceived").map((event) => event.params.response.url);
  for (const script of runtime.runtime.ui.scripts) {
    assert.ok(responseUrls.some((url) => new URL(url).pathname === script.url), `browser did not receive ${script.url}`);
  }

  assert.ok(sessionCookie?.value, "ticket login did not expose the HttpOnly session cookie to CDP");
  const reload = await runChrome(handle.url, reloadProfile, async (state) => state.mounted && state.rootChildren > 0 && state.text.includes("Agent Bus") && state.search === "" && state.boot?.highest === 10, "session reload", {
    beforeNavigate: (cdp) => cdp.send("Network.setCookie", {
      name: "agent_bus_session",
      value: sessionCookie.value,
      url: handle.url,
      httpOnly: true,
      sameSite: "Strict",
    }),
  });
  assertAllCheckpoints(reload.state, "session reload");
  assertCleanBrowser(reload, "session reload");

  const replay = await runChrome(`${handle.url}/?ticket=${encodeURIComponent(ticket)}`, replayProfile, async (state) => state.rootChildren > 0 && state.text.includes("invalid or expired") && state.boot?.diagnostic === true && state.search === "", "replayed ticket diagnostic");
  assert.match(replay.state.text, /invalid or expired/i);
  assert.equal(replay.state.boot.stages[7] !== undefined, true);
  assert.equal(replay.state.boot.stages[8], undefined);
  assertCleanBrowser(replay, "replayed ticket diagnostic", { allowedStatusUrls: ["/api/session"] });

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
  const expired = await runChrome(`${expiredHandle.url}/?ticket=${encodeURIComponent(expiredTicket)}`, expiredProfile, async (state) => state.rootChildren > 0 && state.text.includes("invalid or expired") && state.boot?.diagnostic === true && state.search === "", "expired ticket diagnostic");
  assert.match(expired.state.text, /invalid or expired/i);
  assertCleanBrowser(expired, "expired ticket diagnostic", { allowedStatusUrls: ["/api/session"] });

  const blocked = await runChrome(handle.url, blockedProfile, async (state) => state.rootChildren > 0 && state.boot?.failed === true && state.text.includes("resource failed to load"), "blocked application module", {
    beforeNavigate: (cdp) => cdp.send("Network.setBlockedURLs", { urls: [`*${applicationScript.url}*`] }),
  });
  assert.equal(blocked.state.boot.highest, 1);
  assert.ok(blocked.events.some((event) => event.method === "Network.loadingFailed"));

  const noJavascript = await runChrome(handle.url, noJavascriptProfile, async (state, _cdp, iteration) => iteration > 8 && state.rootChildren > 0 && state.text.includes("Starting Agent Bus") && state.boot === null, "all dashboard JavaScript blocked", {
    beforeNavigate: (cdp) => cdp.send("Network.setBlockedURLs", { urls: ["*/boot.js*", `*${applicationScript.url}*`] }),
  });
  assert.match(noJavascript.state.text, /Starting Agent Bus/);
  assert.ok(noJavascript.state.rootChildren > 0);

  let rejectionInjected = false;
  const rejection = await runChrome(handle.url, rejectionProfile, async (state, cdp) => {
    if (!rejectionInjected && state.boot?.highest === 10) {
      rejectionInjected = true;
      await cdp.send("Runtime.evaluate", { expression: 'Promise.reject(new Error("SMOKE_UNHANDLED_REJECTION"))' });
      return false;
    }
    return rejectionInjected && state.boot?.failed === true && state.text.includes("Agent Bus promise rejected") && state.text.includes("SMOKE_UNHANDLED_REJECTION");
  }, "unhandled rejection diagnostic");
  assert.match(rejection.state.text, /SMOKE_UNHANDLED_REJECTION/);

  let cspInjected = false;
  const csp = await runChrome(handle.url, cspProfile, async (state, cdp) => {
    if (!cspInjected && state.boot?.highest === 10) {
      cspInjected = true;
      await cdp.send("Runtime.evaluate", { expression: '(() => { const script=document.createElement("script"); script.src="https://example.invalid/agent-bus-csp-smoke.js"; document.head.appendChild(script); })()' });
      return false;
    }
    return cspInjected && state.boot?.failed === true && state.text.includes("Content Security Policy violation");
  }, "CSP violation diagnostic");
  assert.match(csp.state.text, /Content Security Policy violation/);

  process.stdout.write("production Chrome boot/auth/runtime smoke passed\n");
} finally {
  if (expiredHandle) await expiredHandle.close().catch(() => {});
  await handle.close().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}
