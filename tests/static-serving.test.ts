import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startProductServer } from "../src/product-server.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

async function fixture() {
  const root = temporaryDirectory("agent-bus-static-");
  const staticRoot = join(root, "web");
  mkdirSync(join(staticRoot, "assets"), { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><body>INDEX_SENTINEL</body>");
  writeFileSync(join(staticRoot, "boot.css"), "body{background:#000}");
  writeFileSync(join(staticRoot, "assets", "app-AbC123xY.js"), "globalThis.__STATIC_TEST__=true;\n");
  const handle = await startProductServer({
    host: "127.0.0.1",
    port: 0,
    config: testConfig(),
    statePath: join(root, "state.sqlite"),
    logPath: join(root, "bus.jsonl"),
    operatorTokenPath: join(root, "operator.token"),
    staticRoot,
  });
  return { root, staticRoot, handle };
}

test("production static server separates SPA routes from assets and APIs", async (t) => {
  const f = await fixture();
  t.after(() => f.handle.close());

  const index = await fetch(`${f.handle.url}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /text\/html/);
  assert.match(index.headers.get("cache-control") ?? "", /no-store/);
  assert.match(await index.text(), /INDEX_SENTINEL/);

  const boot = await fetch(`${f.handle.url}/boot.css`);
  assert.equal(boot.status, 200);
  assert.match(boot.headers.get("content-type") ?? "", /text\/css/);
  assert.match(boot.headers.get("cache-control") ?? "", /no-cache/);

  const asset = await fetch(`${f.handle.url}/assets/app-AbC123xY.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
  assert.doesNotMatch(await asset.text(), /INDEX_SENTINEL/);

  const missingAsset = await fetch(`${f.handle.url}/assets/missing-AbC123xY.js`);
  assert.equal(missingAsset.status, 404);
  assert.match(missingAsset.headers.get("content-type") ?? "", /application\/json/);
  assert.doesNotMatch(await missingAsset.text(), /INDEX_SENTINEL/);

  const missingFile = await fetch(`${f.handle.url}/missing.js`);
  assert.equal(missingFile.status, 404);
  assert.doesNotMatch(await missingFile.text(), /INDEX_SENTINEL/);

  const spaRoute = await fetch(`${f.handle.url}/projects/example/run`);
  assert.equal(spaRoute.status, 200);
  assert.match(await spaRoute.text(), /INDEX_SENTINEL/);
  assert.match(spaRoute.headers.get("cache-control") ?? "", /no-store/);

  const api = await fetch(`${f.handle.url}/api/not-a-route`);
  assert.equal(api.status, 401);
  assert.match(api.headers.get("content-type") ?? "", /application\/json/);
  assert.doesNotMatch(await api.text(), /INDEX_SENTINEL/);

  const health = await fetch(`${f.handle.url}/health`);
  const healthBody = await health.json() as any;
  assert.equal(healthBody.product, "agent-bus");
  assert.equal(typeof healthBody.productProtocol, "number");
  assert.equal(typeof healthBody.buildId, "string");
  assert.equal(healthBody.dashboard, true);
  assert.equal(healthBody.uiBuilt, true);
});

test("missing production frontend is an explicit service error", async (t) => {
  const root = temporaryDirectory("agent-bus-static-missing-");
  const handle = await startProductServer({
    host: "127.0.0.1",
    port: 0,
    config: testConfig(),
    statePath: join(root, "state.sqlite"),
    logPath: join(root, "bus.jsonl"),
    operatorTokenPath: join(root, "operator.token"),
    staticRoot: join(root, "does-not-exist"),
  });
  t.after(() => handle.close());

  const page = await fetch(`${handle.url}/`);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /dashboard build missing/i);

  const health = await fetch(`${handle.url}/health`);
  assert.equal((await health.json() as any).uiBuilt, false);
});
