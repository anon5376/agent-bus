#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const baseUrl = process.env.AGENT_BUS_BROWSER_URL ?? "http://127.0.0.1:7717";
const busHome = process.env.AGENT_BUS_HOME ?? join(process.env.HOME ?? "", ".agent-bus");

function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const absolute = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const path of absolute) {
    try { execFileSync("test", ["-x", path]); return path; } catch {}
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try { return execFileSync("which", [name], { encoding: "utf8" }).trim(); } catch {}
  }
  throw new Error("Chrome/Chromium was not found for the installed-product smoke test");
}

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

async function waitForJson(url, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (response.ok) return JSON.parse(text);
      last = `${response.status} ${text}`;
    } catch (error) { last = String(error); }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${last}`);
}

function cdpSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let id = 0;
  const ready = new Promise((done, reject) => {
    ws.addEventListener("open", done, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else call.resolve(message.result);
      return;
    }
    if (message.method) events.push(message);
  });
  async function send(method, params = {}) {
    await ready;
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return await new Promise((done, reject) => pending.set(callId, { resolve: done, reject }));
  }
  return { ws, ready, send, events };
}

async function browserState(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => ({
      href: location.href,
      search: location.search,
      title: document.title,
      text: document.body.innerText,
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
      mounted: Boolean(document.querySelector('[data-agent-bus-mounted="true"]')),
      boot: globalThis.__AGENT_BUS_BOOT__?.state ?? null,
      controlled: Boolean(navigator.serviceWorker?.controller),
      scripts: Array.from(document.scripts).map(script => script.src).filter(Boolean),
      styles: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(link => link.href)
    }))()`,
    returnByValue: true,
  });
  return result.result?.value ?? null;
}

async function waitForMounted(cdp, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await browserState(cdp);
    if (last?.mounted && last.rootChildren > 0 && last.text.includes("Agent Bus") && last.search === "" && last.boot?.highest === 10) return last;
    await new Promise((done) => setTimeout(done, 120));
  }
  const exceptions = cdp.events.filter((event) => event.method === "Runtime.exceptionThrown");
  const consoleErrors = cdp.events.filter((event) => event.method === "Runtime.consoleAPICalled" && event.params?.type === "error");
  const failed = cdp.events.filter((event) => event.method === "Network.loadingFailed");
  throw new Error(`${label} did not mount\nstate=${JSON.stringify(last)}\nexceptions=${JSON.stringify(exceptions)}\nconsole=${JSON.stringify(consoleErrors)}\nfailed=${JSON.stringify(failed)}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function command(...args) {
  return execFileSync(args[0], args.slice(1), { encoding: "utf8" }).trim();
}

function parseLauncherInfo(value) {
  return Object.fromEntries(value.split("\n").filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

async function fetchText(path) {
  const response = await fetch(`${baseUrl}${path}${path.includes("?") ? "&" : "?"}installed_probe=${Date.now()}`, {
    headers: { "cache-control": "no-cache" },
  });
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, `${path} returned HTTP ${response.status}: ${body.toString("utf8").slice(0, 500)}`);
  return { response, body };
}

const launcherPath = command("which", "agent-bus");
const launcher = parseLauncherInfo(command(launcherPath, "__launcher-info"));
const currentLink = join(busHome, "app", "current");
const releaseRoot = realpathSync(currentLink);
assert.equal(resolve(launcher.application), resolve(currentLink));
assert.equal(resolve(launcher.entrypoint), resolve(join(currentLink, "dist", "cli.js")));

const runtimeCli = JSON.parse(command(launcherPath, "runtime", "--json"));
const diagnosticResponse = await fetch(`${baseUrl}/diagnostics/runtime?installed=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
const diagnosticText = await diagnosticResponse.text();
assert.equal(diagnosticResponse.status, 200, diagnosticText);
const diagnostic = JSON.parse(diagnosticText);
const runtime = diagnostic.runtime;

assert.equal(diagnostic.product, "agent-bus");
assert.equal(diagnostic.buildId, runtimeCli.local.buildId);
assert.equal(runtimeCli.running.buildId, diagnostic.buildId);
assert.equal(resolve(runtime.applicationRoot), resolve(releaseRoot));
assert.equal(resolve(runtime.staticRoot), resolve(join(releaseRoot, "dist", "web")));
assert.equal(resolve(runtime.entrypoint), resolve(join(releaseRoot, "cli.js")));
assert.equal(resolve(runtime.installRoot), resolve(currentLink));
assert.equal(resolve(runtime.launcherPath), resolve(launcherPath));
assert.equal(resolve(runtime.nodePath), resolve(process.execPath));
assert.equal(runtime.nodeVersion, process.version);
assert.equal(resolve(runtime.cwd), resolve(process.cwd()));
assert.equal(Number(runtime.pid), Number(command("lsof", "-nP", "-t", "-iTCP:7717", "-sTCP:LISTEN")));
const processCommand = command("ps", "-p", String(runtime.pid), "-o", "command=");
assert.match(processCommand, /\.agent-bus\/app\/current\/cli\.js broker|\.agent-bus\/app\/releases\/[^/]+\/cli\.js broker/);
const cwdOutput = command("lsof", "-a", "-p", String(runtime.pid), "-d", "cwd", "-Fn");
assert.ok(cwdOutput.split("\n").some((line) => line === `n${runtime.cwd}`), `running PID cwd mismatch: ${cwdOutput}`);

const artifacts = [runtime.ui.index, ...runtime.ui.scripts, ...runtime.ui.styles];
const artifactBodies = new Map();
for (const artifact of artifacts) {
  const pathname = artifact.path === "index.html" ? "/" : artifact.url;
  const { response, body } = await fetchText(pathname);
  assert.equal(sha256(body), artifact.sha256, `${pathname} differs from installed runtime manifest`);
  artifactBodies.set(pathname, body);
  const contentType = response.headers.get("content-type") ?? "";
  if (pathname.endsWith(".js")) assert.match(contentType, /javascript/);
  if (pathname.endsWith(".css")) assert.match(contentType, /text\/css/);
}
assert.match(artifactBodies.get("/").toString("utf8"), /data-boot-stage="10"/);
const applicationScript = runtime.ui.scripts.find((entry) => entry.url.startsWith("/assets/"));
assert.ok(applicationScript);
assert.match(artifactBodies.get(applicationScript.url).toString("utf8"), /createRoot invocation reached/);

const operatorToken = readFileSync(join(busHome, "operator.token"), "utf8").trim();
const loginResponse = await fetch(`${baseUrl}/dashboard/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: operatorToken }),
});
const loginText = await loginResponse.text();
assert.equal(loginResponse.status, 200, loginText);
const ticket = JSON.parse(loginText).ticket;
assert.ok(ticket);

const browserRoot = mkdtempSync(join(tmpdir(), "agent-bus-installed-browser-"));
const debugPort = await freePort();
const browser = spawn(chromeBinary(), [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${join(browserRoot, "profile")}`,
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let browserError = "";
browser.stderr.on("data", (chunk) => { browserError += chunk.toString(); });

try {
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
  const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = targets.find((target) => target.type === "page");
  assert.ok(page?.webSocketDebuggerUrl);
  const cdp = cdpSocket(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Log.enable");

  const ticketUrl = `${baseUrl}/?ticket=${encodeURIComponent(ticket)}&build=${encodeURIComponent(diagnostic.buildId)}&launch=${randomBytes(8).toString("hex")}`;
  await cdp.send("Page.navigate", { url: ticketUrl });
  const mounted = await waitForMounted(cdp, "installed ticket login");
  assert.equal(mounted.boot.runtime.buildId, diagnostic.buildId);
  assert.equal(mounted.boot.runtime.runtime.applicationRoot, runtime.applicationRoot);
  assert.equal(mounted.controlled, false);
  for (let number = 1; number <= 10; number += 1) assert.ok(mounted.boot.stages[number - 1], `missing installed checkpoint ${number}`);

  const cookies = await cdp.send("Network.getCookies", { urls: [baseUrl] });
  assert.ok(cookies.cookies.some((cookie) => cookie.name === "agent_bus_session" && cookie.httpOnly === true));

  const scriptResponse = cdp.events.find((event) => event.method === "Network.responseReceived" && new URL(event.params.response.url).pathname === applicationScript.url);
  assert.ok(scriptResponse, `Chromium did not receive ${applicationScript.url}`);
  const browserBodyResult = await cdp.send("Network.getResponseBody", { requestId: scriptResponse.params.requestId });
  const browserBody = browserBodyResult.base64Encoded ? Buffer.from(browserBodyResult.body, "base64") : Buffer.from(browserBodyResult.body);
  assert.equal(sha256(browserBody), applicationScript.sha256, "Chromium executed a JS asset different from the installed manifest");

  await cdp.send("Page.navigate", { url: baseUrl });
  const reloaded = await waitForMounted(cdp, "installed session reload");
  assert.equal(reloaded.boot.runtime.buildId, diagnostic.buildId);

  const exceptions = cdp.events.filter((event) => event.method === "Runtime.exceptionThrown");
  const consoleErrors = cdp.events.filter((event) => event.method === "Runtime.consoleAPICalled" && event.params?.type === "error");
  const logErrors = cdp.events.filter((event) => event.method === "Log.entryAdded" && event.params?.entry?.level === "error");
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  assert.equal(consoleErrors.length, 0, JSON.stringify(consoleErrors));
  assert.equal(logErrors.length, 0, JSON.stringify(logErrors));
  cdp.ws.close();

  process.stdout.write(JSON.stringify({
    launcherPath,
    applicationRoot: runtime.applicationRoot,
    staticRoot: runtime.staticRoot,
    pid: runtime.pid,
    nodePath: runtime.nodePath,
    cwd: runtime.cwd,
    buildId: diagnostic.buildId,
    index: runtime.ui.index,
    scripts: runtime.ui.scripts,
    styles: runtime.ui.styles,
    browser: chromeBinary(),
    checkpoints: mounted.boot.highest,
  }, null, 2) + "\ninstalled production Chromium smoke passed\n");
} catch (error) {
  throw new Error(`${error.message}\nChromium stderr:\n${browserError.slice(-5000)}`);
} finally {
  browser.kill("SIGTERM");
  await new Promise((done) => {
    const timer = setTimeout(done, 1800);
    browser.once("exit", () => { clearTimeout(timer); done(); });
  });
  if (browser.exitCode === null) browser.kill("SIGKILL");
  rmSync(browserRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
