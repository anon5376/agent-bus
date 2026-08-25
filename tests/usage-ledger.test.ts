import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/store.js";
import { UsageEvent } from "../src/protocol.js";
import { costFor, findModel, lookupPricing } from "../src/pricing.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: `use_${Math.random().toString(16).slice(2, 14)}`,
    ts: Date.now(),
    agentId: "worker",
    taskId: null,
    runId: null,
    modelId: "fake-strong",
    model: "fake-strong",
    provider: "fake",
    harness: "fake",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1500,
    costUSD: 0.01,
    notionalUSD: 0.01,
    billing: "metered",
    pricingSource: "table",
    latencyMs: 100,
    source: "agent",
    ...overrides,
  };
}

test("usage events roll up per agent, model and provider inside the window", () => {
  const store = new StateStore(join(temporaryDirectory(), "state.sqlite"));
  const now = Date.now();
  store.appendUsageEvent(usageEvent({ ts: now - 60_000, agentId: "alice", modelId: "opus", provider: "anthropic" }));
  store.appendUsageEvent(usageEvent({ ts: now - 30_000, agentId: "alice", modelId: "opus", provider: "anthropic" }));
  store.appendUsageEvent(usageEvent({ ts: now - 10_000, agentId: "bob", modelId: "gpt", provider: "openai", totalTokens: 300, inputTokens: 300, outputTokens: 0 }));

  const summary = store.usageSummary(3_600_000, now, 12);
  assert.equal(summary.totals.events, 3);
  assert.equal(summary.totals.totalTokens, 3300);
  assert.equal(summary.byAgent.length, 2);
  // Ranked by tokens, so the heavier agent leads.
  assert.equal(summary.byAgent[0].key, "alice");
  assert.equal(summary.byAgent[0].totalTokens, 3000);
  assert.equal(summary.byProvider.find((bucket) => bucket.key === "openai")?.totalTokens, 300);
  assert.equal(summary.series.length, 12);
  assert.equal(summary.series.reduce((sum, point) => sum + point.totalTokens, 0), 3300);
  store.close();
});

test("events outside the window are excluded but survive for a wider one", () => {
  const store = new StateStore(join(temporaryDirectory(), "state.sqlite"));
  const now = Date.now();
  store.appendUsageEvent(usageEvent({ ts: now - 10 * 3_600_000 }));
  store.appendUsageEvent(usageEvent({ ts: now - 60_000 }));

  assert.equal(store.usageSummary(5 * 3_600_000, now).totals.events, 1);
  assert.equal(store.usageSummary(24 * 3_600_000, now).totals.events, 2);
  store.close();
});

test("appending the same event id twice does not double-count", () => {
  const store = new StateStore(join(temporaryDirectory(), "state.sqlite"));
  const event = usageEvent();
  store.appendUsageEvent(event);
  store.appendUsageEvent(event);
  assert.equal(store.usageSummary(3_600_000).totals.events, 1);
  store.close();
});

test("pruning drops old events and leaves recent ones", () => {
  const store = new StateStore(join(temporaryDirectory(), "state.sqlite"));
  const now = Date.now();
  store.appendUsageEvent(usageEvent({ ts: now - 40 * 86_400_000 }));
  store.appendUsageEvent(usageEvent({ ts: now - 60_000 }));
  assert.equal(store.pruneUsageEvents(now - 30 * 86_400_000), 1);
  assert.equal(store.usageSummary(90 * 86_400_000, now).totals.events, 1);
  store.close();
});

test("pricing resolves the most specific model row", () => {
  // `gpt-5-mini` must not be priced as the far more expensive `gpt-5`.
  assert.equal(lookupPricing("gpt-5-mini").pricing.inputPerMTok, 0.25);
  assert.equal(lookupPricing("gpt-5").pricing.inputPerMTok, 1.25);
  assert.equal(lookupPricing("anthropic/claude-opus-4-8").pricing.outputPerMTok, 75);
  assert.equal(lookupPricing("something-nobody-has-heard-of").source, "unknown");
});

test("subscription models report notional cost but bill nothing", () => {
  const config = testConfig();
  const model = findModel(config, "fake-strong");
  assert.ok(model, "fake-strong should exist in the test catalogue");
  model.capabilities.costClass = "subscription";
  model.pricing = { inputPerMTok: 10, outputPerMTok: 100 };

  const cost = costFor(model, "fake-strong", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
  assert.equal(cost.billing, "subscription");
  assert.equal(cost.costUSD, 0);
  assert.equal(cost.notionalUSD, 110);
  assert.equal(cost.pricingSource, "config");
});

test("reasoning tokens bill at the output rate", () => {
  const cost = costFor(null, "claude-sonnet-4-5", {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 1_000_000,
  });
  assert.equal(cost.costUSD, 15);
});

test("an unknown model records tokens without inventing a price", () => {
  const cost = costFor(null, "brand-new-thing", {
    inputTokens: 500_000,
    outputTokens: 500_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
  assert.equal(cost.costUSD, 0);
  assert.equal(cost.pricingSource, "unknown");
});
