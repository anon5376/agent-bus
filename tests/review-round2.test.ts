import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configPathFromProject, loadConfig, resolveAgent } from "../src/config.js";
import { knownAgentBusCommand } from "../src/process-management.js";

test("explicit AGENT_BUS_CONFIG wins over project-local config for supervisor resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bus-config-precedence-"));
  const project = join(root, "project");
  const localDir = join(project, ".agent-bus");
  mkdirSync(localDir, { recursive: true });
  const explicitPath = join(root, "explicit.json");
  const localPath = join(localDir, "config.json");
  const base = structuredClone(loadConfig());
  const explicit = structuredClone(base);
  const local = structuredClone(base);
  explicit.agents["fake-small"].model = "fake-strong";
  local.agents["fake-small"].model = "fake-small";
  writeFileSync(explicitPath, `${JSON.stringify(explicit, null, 2)}\n`);
  writeFileSync(localPath, `${JSON.stringify(local, null, 2)}\n`);
  const previous = process.env.AGENT_BUS_CONFIG;
  process.env.AGENT_BUS_CONFIG = explicitPath;
  try {
    const selected = configPathFromProject(project);
    assert.equal(selected, explicitPath);
    assert.equal(resolveAgent(loadConfig(selected), "fake-small").modelDefinition.id, "fake-strong");
  } finally {
    if (previous === undefined) delete process.env.AGENT_BUS_CONFIG; else process.env.AGENT_BUS_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped Agent Bus command matching does not claim a generic checkout", () => {
  const command = "/opt/homebrew/bin/node /Users/me/code/agent-bus/dist/cli.js broker";
  assert.equal(knownAgentBusCommand(command, { busHome: "/tmp/instance-a", applicationRoot: "/tmp/instance-a/app/current" }), false);
});

test("installer replaces app/current without an unlink window", () => {
  const script = readFileSync(join(process.cwd(), "install.sh"), "utf8");
  assert.doesNotMatch(script, /rm -f "\$APP_ROOT\/current"\s*\n\s*mv "\$APP_ROOT\/current\.next" "\$APP_ROOT\/current"/);
  assert.match(script, /renameSync|mv\s+-h|atomic/i);
});
