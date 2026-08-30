#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";

if (process.platform !== "darwin") {
  throw new Error("The Safari installed-product smoke test requires macOS");
}

const baseUrl = process.env.AGENT_BUS_BROWSER_URL ?? "http://127.0.0.1:11511";
const busHome = process.env.AGENT_BUS_HOME ?? join(process.env.HOME ?? "", ".agent-bus");
const safariDriver = process.env.SAFARIDRIVER_BIN ?? "/usr/bin/safaridriver";

function freePort() {
  return new Promise((done, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : done(port));
    });
  });
}

async function request(driverUrl, path, options = {}) {
  const response = await fetch(`${driverUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok || body?.value?.error) {
    throw new Error(`SafariDriver ${options.method ?? "GET"} ${path} failed: HTTP ${response.status} ${text}`);
  }
  return body;
}

async function waitForDriver(driverUrl, stderr, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const result = await request(driverUrl, "/status", { timeoutMs: 1200 });
      if (result.value?.ready !== false) return;
      last = JSON.stringify(result);
    } catch (error) { last = String(error); }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`SafariDriver did not become ready: ${last}\n${stderr()}`);
}

async function execute(driverUrl, sessionId, script, args = []) {
  const result = await request(driverUrl, `/session/${sessionId}/execute/sync`, {
    method: "POST",
    body: { script, args },
  });
  return result.value;
}

async function executeAsync(driverUrl, sessionId, script, args = []) {
  const result = await request(driverUrl, `/session/${sessionId}/execute/async`, {
    method: "POST",
    body: { script, args },
    timeoutMs: 20_000,
  });
  return result.value;
}

async function state(driverUrl, sessionId) {
  return execute(driverUrl, sessionId, `return (() => ({
    href: location.href,
    search: location.search,
    title: document.title,
    text: document.body.innerText,
    rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    mounted: Boolean(document.querySelector('[data-agent-bus-mounted="true"]')),
    boot: globalThis.__AGENT_BUS_BOOT__?.state ?? null,
    controlled: Boolean(navigator.serviceWorker?.controller),
    userAgent: navigator.userAgent,
    scripts: Array.from(document.scripts).map(script => script.src).filter(Boolean),
    styles: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(link => link.href),
    resources: performance.getEntriesByType('resource').map(entry => ({name: entry.name, duration: entry.duration, transferSize: entry.transferSize}))
  }))();`);
}

async function waitForMounted(driverUrl, sessionId, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await state(driverUrl, sessionId);
    if (last?.mounted && last.rootChildren > 0 && last.text.includes("Agent Bus") && last.search === "" && last.boot?.highest === 10) return last;
    if (last?.boot?.failed) throw new Error(`${label} failed at checkpoint ${last.boot.highest}: ${JSON.stringify(last.boot.failure)}\n${last.text}`);
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`${label} did not mount in Safari: ${JSON.stringify(last)}`);
}

const diagnosticResponse = await fetch(`${baseUrl}/diagnostics/runtime?safari=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
const diagnosticText = await diagnosticResponse.text();
assert.equal(diagnosticResponse.status, 200, diagnosticText);
const diagnostic = JSON.parse(diagnosticText);
const applicationScript = diagnostic.runtime.ui.scripts.find((entry) => entry.url.startsWith("/assets/"));
assert.ok(applicationScript);

const token = readFileSync(join(busHome, "operator.token"), "utf8").trim();
const ticketResponse = await fetch(`${baseUrl}/dashboard/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token }),
});
const ticketText = await ticketResponse.text();
assert.equal(ticketResponse.status, 200, ticketText);
const ticket = JSON.parse(ticketText).ticket;
assert.ok(ticket);

const port = await freePort();
const driverUrl = `http://127.0.0.1:${port}`;
const driver = spawn(safariDriver, ["-p", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
let driverOutput = "";
driver.stdout.on("data", (chunk) => { driverOutput += chunk.toString(); });
driver.stderr.on("data", (chunk) => { driverOutput += chunk.toString(); });
let sessionId = null;

try {
  await waitForDriver(driverUrl, () => driverOutput.slice(-5000));
  const session = await request(driverUrl, "/session", {
    method: "POST",
    body: {
      capabilities: {
        alwaysMatch: {
          browserName: "safari",
          acceptInsecureCerts: false,
          pageLoadStrategy: "normal",
        },
      },
    },
    timeoutMs: 30_000,
  });
  sessionId = session.value?.sessionId ?? session.sessionId;
  assert.ok(sessionId, `SafariDriver returned no session ID: ${JSON.stringify(session)}`);

  const ticketUrl = `${baseUrl}/?ticket=${encodeURIComponent(ticket)}&build=${encodeURIComponent(diagnostic.buildId)}&launch=${randomBytes(8).toString("hex")}`;
  await request(driverUrl, `/session/${sessionId}/url`, { method: "POST", body: { url: ticketUrl }, timeoutMs: 30_000 });
  const mounted = await waitForMounted(driverUrl, sessionId, "installed Safari ticket login");
  assert.match(mounted.userAgent, /Safari\//);
  assert.doesNotMatch(mounted.userAgent, /Chrome\//);
  assert.equal(mounted.controlled, false);
  assert.equal(mounted.boot.runtime.buildId, diagnostic.buildId);
  assert.equal(mounted.boot.runtime.runtime.applicationRoot, diagnostic.runtime.applicationRoot);
  assert.equal(mounted.boot.failed, false);
  for (let number = 1; number <= 10; number += 1) assert.ok(mounted.boot.stages[number - 1], `Safari missed checkpoint ${number}`);
  assert.ok(mounted.scripts.some((url) => new URL(url).pathname === applicationScript.url));

  const cookies = await request(driverUrl, `/session/${sessionId}/cookie`);
  assert.ok(cookies.value.some((cookie) => cookie.name === "agent_bus_session" && cookie.httpOnly === true));

  const browserHash = await executeAsync(driverUrl, sessionId, `
    const done = arguments[arguments.length - 1];
    fetch(arguments[0], {cache: 'no-store', credentials: 'same-origin'})
      .then(response => response.arrayBuffer())
      .then(buffer => crypto.subtle.digest('SHA-256', buffer))
      .then(digest => done(Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('')))
      .catch(error => done({error: String(error)}));
  `, [`${baseUrl}${applicationScript.url}?safari_hash=${Date.now()}`]);
  assert.equal(browserHash, applicationScript.sha256, `Safari fetched a JS asset different from the installed manifest: ${JSON.stringify(browserHash)}`);

  await request(driverUrl, `/session/${sessionId}/url`, { method: "POST", body: { url: baseUrl }, timeoutMs: 30_000 });
  const reload = await waitForMounted(driverUrl, sessionId, "installed Safari session reload");
  assert.equal(reload.boot.runtime.buildId, diagnostic.buildId);

  process.stdout.write(JSON.stringify({
    safariUserAgent: mounted.userAgent,
    buildId: diagnostic.buildId,
    applicationRoot: diagnostic.runtime.applicationRoot,
    staticRoot: diagnostic.runtime.staticRoot,
    script: applicationScript,
    checkpoints: mounted.boot.highest,
  }, null, 2) + "\ninstalled production Safari smoke passed\n");
} catch (error) {
  throw new Error(`${error.message}\nSafariDriver output:\n${driverOutput.slice(-6000)}`);
} finally {
  if (sessionId) await request(driverUrl, `/session/${sessionId}`, { method: "DELETE", timeoutMs: 5000 }).catch(() => {});
  driver.kill("SIGTERM");
  await new Promise((done) => {
    const timer = setTimeout(done, 1500);
    driver.once("exit", () => { clearTimeout(timer); done(); });
  });
  if (driver.exitCode === null) driver.kill("SIGKILL");
}
