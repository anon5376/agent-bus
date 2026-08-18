import assert from "node:assert/strict";
import test from "node:test";
import { classifyPortOwner, knownAgentBusCommand } from "../src/process-management.js";
import { PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "../src/product-runtime.js";

const buildId = "abc123build";

test("process classification reuses only the exact current Agent Bus build", () => {
  const owner = classifyPortOwner(42, "node /tmp/agent-bus/dist/cli.js broker", {
    ok: true,
    pid: 42,
    product: PRODUCT_NAME,
    productProtocol: PRODUCT_PROTOCOL_VERSION,
    buildId,
    dashboard: true,
    uiBuilt: true,
    durable: true,
    agents: 1,
    tasks: 2,
    runs: 3,
  }, buildId);
  assert.equal(owner.kind, "current");
});

test("process classification recognizes old Agent Bus health without relying on process regex", () => {
  const owner = classifyPortOwner(77, "node /some/renamed/location/server.js", {
    ok: true,
    pid: 77,
    durable: true,
    agents: 1,
    tasks: 2,
    runs: 3,
  }, buildId);
  assert.equal(owner.kind, "agent-bus");
  assert.match(owner.reason, /legacy/i);
});

test("process classification protects unrelated port owners", () => {
  const owner = classifyPortOwner(99, "/usr/bin/python3 unrelated-server.py", {
    ok: true,
    pid: 99,
  }, buildId);
  assert.equal(owner.kind, "unrelated");
});

test("different Agent Bus build is replaceable rather than reused", () => {
  const owner = classifyPortOwner(100, "node /tmp/agent-bus/dist/cli.js broker", {
    ok: true,
    pid: 100,
    product: PRODUCT_NAME,
    productProtocol: PRODUCT_PROTOCOL_VERSION,
    buildId: "older-build",
    dashboard: true,
    uiBuilt: true,
  }, buildId);
  assert.equal(owner.kind, "agent-bus");
});

test("known Agent Bus command matcher is narrow", () => {
  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/agent-bus/dist/cli.js broker"), true);
  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/agent-bus/dist/broker.js"), true);
  assert.equal(knownAgentBusCommand("python server.py --name agent-bus --port 7717"), false);
  assert.equal(knownAgentBusCommand("node /Users/me/other-agent-bus-project/server.js"), false);
});
