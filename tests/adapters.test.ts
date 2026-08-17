import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { getHarnessAdapter } from "../src/adapters.js";
import { resolveAgent } from "../src/config.js";
import { retryDelayMs, runHarnessProcess } from "../src/supervisor.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

function contextFor(agentId: string) {
  const config = testConfig();
  const agent = resolveAgent(config, agentId);
  return {
    agent,
    prompt: "perform a deterministic test",
    sessionId: null,
    workdir: temporaryDirectory(),
    mcpServerPath: "/tmp/mcp-server.js",
    fakeHarnessPath: join(process.cwd(), "dist", "fake-harness.js"),
    busEnvironment: { AGENT_TOKEN: "secret-test-token" },
  };
}

test("Claude adapter normalizes JSON envelope and usage", () => {
  const config = testConfig();
  config.providers.anthropic.enabled = true;
  config.harnesses.claude.enabled = true;
  config.models["opus-current"].enabled = true;
  config.agents.opus.enabled = true;
  const agent = resolveAgent(config, "opus");
  const adapter = getHarnessAdapter("claude");
  const invocation = adapter.build({
    agent,
    prompt: "test",
    sessionId: null,
    workdir: temporaryDirectory(),
    mcpServerPath: "/tmp/mcp.js",
    fakeHarnessPath: "/tmp/fake.js",
    busEnvironment: { AGENT_TOKEN: "token" },
  });
  assert.ok(invocation.args.includes("--mcp-config"));
  assert.ok(invocation.args.includes("--output-format"));
  const parsed = adapter.parse(JSON.stringify({
    result: "done",
    session_id: "session-1",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    total_cost_usd: 0.1,
  }), 0);
  assert.equal(parsed.text, "done");
  assert.equal(parsed.sessionId, "session-1");
  assert.equal(parsed.usage.totalTokens, 17);
  assert.equal(parsed.usage.costUSD, 0.1);
});

test("Codex adapter places options before positional prompt", () => {
  const config = testConfig();
  config.providers.openai.enabled = true;
  config.harnesses.codex.enabled = true;
  config.models["codex-default"].enabled = true;
  config.agents.gpt.enabled = true;
  const agent = resolveAgent(config, "gpt");
  const invocation = getHarnessAdapter("codex").build({
    agent,
    prompt: "THE_PROMPT",
    sessionId: null,
    workdir: temporaryDirectory(),
    mcpServerPath: "/tmp/mcp.js",
    fakeHarnessPath: "/tmp/fake.js",
    busEnvironment: { AGENT_TOKEN: "token" },
  });
  assert.equal(invocation.args.at(-1), "THE_PROMPT");
  assert.ok(invocation.args.indexOf("-c") < invocation.args.indexOf("THE_PROMPT"));
});

test("fake adapter runs a normalized successful process", async () => {
  const context = contextFor("fake-small");
  const adapter = getHarnessAdapter("fake");
  const invocation = adapter.build(context);
  const processResult = await runHarnessProcess(invocation, context.agent, context.workdir);
  const normalized = adapter.parse(processResult.output, processResult.code);
  assert.equal(processResult.code, 0);
  assert.equal(normalized.malformed, false);
  assert.match(normalized.text, /completed/);
  assert.ok(normalized.usage.totalTokens > 0);
});

test("malformed provider output is detected", () => {
  const parsed = getHarnessAdapter("fake").parse("not-json", 0);
  assert.equal(parsed.malformed, true);
});

test("supervisor retry backoff is bounded and exponential", () => {
  assert.equal(retryDelayMs(1), 2_000);
  assert.equal(retryDelayMs(2), 4_000);
  assert.equal(retryDelayMs(99), 60_000);
});
