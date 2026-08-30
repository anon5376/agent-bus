#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function loadFakeOnlyTestConfig() {
  const config = JSON.parse(readFileSync(new URL("../tests/fixtures/test-bus.config.json", import.meta.url), "utf8"));
  for (const [id, provider] of Object.entries(config.providers)) if (id !== "fake") provider.enabled = false;
  for (const [id, harness] of Object.entries(config.harnesses)) if (id !== "fake") harness.enabled = false;
  for (const [id, model] of Object.entries(config.models)) if (!id.startsWith("fake-")) model.enabled = false;
  for (const [id, agent] of Object.entries(config.agents)) if (!id.startsWith("fake-")) agent.enabled = false;
  if (!config.agents["fake-small"]) throw new Error("test fixture is missing fake-small");
  return config;
}

export function writeFakeOnlyHomeConfig(home = process.env.AGENT_BUS_HOME) {
  if (!home) throw new Error("AGENT_BUS_HOME is required to seed the fake test roster");
  mkdirSync(home, { recursive: true });
  const path = join(home, "config.json");
  writeFileSync(path, `${JSON.stringify(loadFakeOnlyTestConfig(), null, 2)}\n`, { mode: 0o600 });
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${writeFakeOnlyHomeConfig()}\n`);
}
