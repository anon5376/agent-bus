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

test("process classification recognizes legacy Agent Bus only with a broker fingerprint", () => {
  const health = {
    ok: true,
    pid: 77,
    durable: true,
    agents: 1,
    tasks: 2,
    runs: 3,
  };
  assert.equal(classifyPortOwner(77, "node /some/renamed/location/server.js", health, buildId, false).kind, "unrelated");
  const owner = classifyPortOwner(77, "node /some/renamed/location/server.js", health, buildId, true);
  assert.equal(owner.kind, "agent-bus");
  assert.match(owner.reason, /legacy/i);
});

test("process classification protects unrelated port owners even if health superficially resembles a broker", () => {
  const owner = classifyPortOwner(99, "/usr/bin/python3 unrelated-server.py", {
    ok: true,
    pid: 99,
    durable: true,
    agents: 0,
    tasks: 0,
    runs: 0,
  }, buildId, false);
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
  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/.agent-bus/app/current/cli.js broker"), true);
  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/.agent-bus/app/releases/abc123/dist/cli.js broker"), true);
  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /tmp/custom-bus/app/releases/abc123/dist/cli.js broker", { busHome: "/tmp/custom-bus" }), true);
  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /tmp/other-bus/app/releases/abc123/dist/cli.js broker", { busHome: "/tmp/custom-bus" }), false);
  assert.equal(knownAgentBusCommand("python server.py --name agent-bus --port 7717"), false);
  assert.equal(knownAgentBusCommand("node /Users/me/other-agent-bus-project/server.js"), false);
});


test("product health from another Agent Bus home is not owned by this instance", () => {
  const owner = classifyPortOwner(123, "node /tmp/other/app/current/dist/cli.js broker", {
    ok: true,
    pid: 123,
    product: PRODUCT_NAME,
    productProtocol: PRODUCT_PROTOCOL_VERSION,
    buildId,
    dashboard: true,
    uiBuilt: true,
    runtime: { busHome: "/tmp/other", applicationRoot: "/tmp/other/app/releases/abc" },
  }, buildId, false, { busHome: "/tmp/mine", applicationRoot: "/tmp/mine/app/current" });
  assert.equal(owner.kind, "unrelated");
  assert.match(owner.reason, /different Agent Bus instance/i);
});
