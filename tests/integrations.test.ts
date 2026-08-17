import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateConfig } from "../src/config.js";
import { addOrUpdateIntegration } from "../src/integrations.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

function configFile(): string {
  const root = temporaryDirectory("agent-bus-integrations-");
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(testConfig(), null, 2));
  return path;
}

test("generic command integration adds provider harness model and agent", () => {
  const path = configFile();
  const result = addOrUpdateIntegration(path, {
    kind: "command",
    providerId: "custom",
    providerName: "Custom Runtime",
    modelId: "custom-model",
    exactModel: "custom/1",
    family: "custom-family",
    agentId: "custom-worker",
    role: "implementation",
    command: "custom-cli",
    args: ["run", "--model", "{model}", "--prompt", "{prompt}"],
  });
  assert.equal(result.harness.adapter, "command");
  assert.equal(result.harness.command, "custom-cli");
  assert.equal(result.agent.model, "custom-model");
  assert.deepEqual(result.agent.harnessOptions?.args, ["run", "--model", "{model}", "--prompt", "{prompt}"]);
  const persisted = validateConfig(JSON.parse(readFileSync(path, "utf8")));
  assert.equal(persisted.models["custom-model"].family, "custom-family");
  assert.equal(persisted.agents["custom-worker"].permissions.filesystem, "write");
});

test("OpenAI-compatible integration is repo-local and does not store an API key", () => {
  const path = configFile();
  const result = addOrUpdateIntegration(path, {
    kind: "openai-compatible",
    providerId: "local-api",
    providerName: "Local API",
    modelId: "local-model",
    exactModel: "qwen/example",
    family: "qwen",
    agentId: "local-worker",
    role: "cheap-worker",
    baseUrl: "http://127.0.0.1:9999/v1",
    apiKeyEnv: "LOCAL_MODEL_KEY",
  });
  assert.equal(result.harness.adapter, "command");
  assert.equal(result.harness.command, process.execPath);
  const args = result.agent.harnessOptions?.args as string[];
  assert.ok(args[0].endsWith("dist/openai-compatible-harness.js"));
  assert.ok(args.includes("http://127.0.0.1:9999/v1"));
  assert.ok(args.includes("LOCAL_MODEL_KEY"));
  assert.equal(result.agent.permissions.shell, false);
  assert.equal(result.agent.permissions.network, true);
  const raw = readFileSync(path, "utf8");
  assert.equal(raw.includes("secret-value"), false);
});

test("raw OpenAI-compatible models cannot be configured as managers", () => {
  const path = configFile();
  assert.throws(() => addOrUpdateIntegration(path, {
    kind: "openai-compatible",
    providerId: "api",
    modelId: "api-model",
    role: "manager",
  }), /cannot act as manager\/reviewer/);
});
