import assert from "node:assert/strict";
import test from "node:test";
import { routeTask } from "../src/router.js";
import { testConfig } from "./helpers.js";

test("routing sends low-complexity cheap work to the efficient small model", () => {
  const config = testConfig();
  const decision = routeTask(config, {
    role: "cheap-worker",
    complexity: 1,
    contextTokens: 2_000,
    writeAccess: false,
    shell: false,
    network: false,
  }, [], [
    { agentId: "fake-small", status: "idle", openTasks: 0 },
    { agentId: "fake-strong", status: "idle", openTasks: 0 },
  ]);
  assert.equal(decision.selectedAgentId, "fake-small");
  assert.match(decision.reason, /token efficiency|low-complexity|selected/i);
});

test("routing rejects the small model for difficult implementation and selects strong", () => {
  const config = testConfig();
  const decision = routeTask(config, {
    role: "implementation",
    complexity: 5,
    contextTokens: 64_000,
    writeAccess: true,
    shell: false,
    network: false,
  });
  assert.equal(decision.selectedAgentId, "fake-strong");
  const small = decision.candidates.find((candidate) => candidate.agentId === "fake-small");
  assert.ok(small);
  assert.equal(small.eligible, false);
  assert.ok(small.rejectedBy.some((reason) => reason.includes("capability fit")));
});

test("independent review excludes the implementation family", () => {
  const config = testConfig();
  const decision = routeTask(config, {
    role: "reviewer",
    complexity: 4,
    contextTokens: 8_000,
    writeAccess: false,
    shell: false,
    network: false,
    implementationFamily: "fake-strong-family",
  });
  assert.equal(decision.selectedAgentId, "fake-small");
  const strong = decision.candidates.find((candidate) => candidate.agentId === "fake-strong");
  assert.ok(strong?.rejectedBy.some((reason) => reason.includes("review must use a family other")));
});

test("exact missing model produces an inspectable no-route decision", () => {
  const config = testConfig();
  const decision = routeTask(config, {
    role: "implementation",
    complexity: 3,
    contextTokens: 1_000,
    writeAccess: true,
    shell: false,
    network: false,
    exactModel: "does-not-exist",
  });
  assert.equal(decision.selectedAgentId, null);
  assert.match(decision.reason, /no eligible agent/);
  assert.ok(decision.candidates.every((candidate) => candidate.rejectedBy.some((reason) => reason.includes("exact model"))));
});

test("observed failures influence deterministic routing without mutating profiles", () => {
  const config = testConfig();
  config.roles["cheap-worker"].minimumCapability = 0;
  const before = structuredClone(config.models["fake-strong"].capabilities);
  const decision = routeTask(config, {
    role: "cheap-worker",
    complexity: 2,
    contextTokens: 1_000,
    writeAccess: false,
    shell: false,
    network: false,
  }, [
    { agentId: "fake-small", taskCount: 10, acceptedCount: 9, failedCount: 1, reviewRejectedCount: 0, averageLatencyMs: 100, averageTokens: 100 },
    { agentId: "fake-strong", taskCount: 10, acceptedCount: 1, failedCount: 9, reviewRejectedCount: 4, averageLatencyMs: 100_000, averageTokens: 50_000 },
  ]);
  assert.equal(decision.selectedAgentId, "fake-small");
  assert.deepEqual(config.models["fake-strong"].capabilities, before);
});
