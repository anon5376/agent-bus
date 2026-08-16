import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/store.js";
import { Agent, Run, Task, emptyUsage } from "../src/protocol.js";
import { temporaryDirectory } from "./helpers.js";

function sampleAgent(): Agent {
  return {
    id: "worker",
    role: "implementation",
    model: "fake-strong",
    family: "fake-strong-family",
    provider: "fake",
    harness: "fake",
    description: "test",
    auth: "local",
    authority: "worker",
    permissions: { canDelegate: false, canReview: false, filesystem: "write", shell: false, network: false, maxDelegationDepth: 0 },
    status: "idle",
    currentTaskId: null,
    registeredAt: 1,
    lastSeen: 1,
  };
}

function sampleRun(root: string): Run {
  return { id: "run-1", goal: "test", projectRoot: root, status: "active", rootTaskId: "task-1", createdBy: "operator", constraints: {}, createdAt: 1, updatedAt: 1 };
}

function sampleTask(): Task {
  return {
    id: "task-1",
    runId: "run-1",
    parentTaskId: null,
    childTaskIds: [],
    dependencyIds: [],
    title: "test",
    brief: "test",
    context: "",
    contextRefs: [],
    assigner: "operator",
    assignee: "worker",
    role: "implementation",
    complexity: 3,
    estimatedContextTokens: 1000,
    readOnly: false,
    pathScopes: ["src"],
    validationRequirements: [],
    state: "assigned",
    round: 1,
    attempts: 0,
    maxRetries: 2,
    depth: 0,
    reviewRequired: false,
    implementationFamily: "fake-strong-family",
    reviewerId: null,
    routing: null,
    reviewRouting: null,
    result: null,
    review: null,
    usage: emptyUsage(),
    createdAt: 1,
    updatedAt: 1,
    history: [],
  };
}

test("SQLite state survives close and restart", () => {
  const root = temporaryDirectory();
  const path = join(root, "state.sqlite");
  let store = new StateStore(path);
  store.upsertIdentity({
    id: "worker",
    tokenHash: "abc",
    authority: "worker",
    permissions: sampleAgent().permissions,
    createdAt: 1,
    updatedAt: 1,
  });
  store.saveAgent(sampleAgent());
  store.saveRun(sampleRun(root));
  store.saveTask(sampleTask());
  const message = store.appendMessage({ id: "msg-1", seq: 0, ts: 1, from: "operator", to: "worker", type: "task", subject: "x", body: "y", taskId: "task-1", refs: [] });
  assert.equal(message.seq, 1);
  store.close();

  store = new StateStore(path);
  assert.equal(store.identityById("worker")?.tokenHash, "abc");
  assert.equal(store.loadAgents()[0].id, "worker");
  assert.equal(store.loadRuns()[0].id, "run-1");
  assert.equal(store.task("task-1")?.state, "assigned");
  assert.equal(store.pendingMessages("worker").length, 1);
  assert.equal(store.latestSequence(), 1);
  store.close();
});

test("path leases reject overlapping write scopes and allow disjoint scopes", () => {
  const root = temporaryDirectory();
  const store = new StateStore(join(root, "state.sqlite"));
  const first = store.acquirePathLeases("task-a", "run", root, ["src/core"]);
  assert.equal(first.acquired, true);
  const overlap = store.acquirePathLeases("task-b", "run", root, ["src/core/parser"]);
  assert.equal(overlap.acquired, false);
  assert.equal(overlap.conflicts[0].taskId, "task-a");
  const disjoint = store.acquirePathLeases("task-c", "run", root, ["docs"]);
  assert.equal(disjoint.acquired, true);
  store.releasePathLeases("task-a");
  assert.equal(store.acquirePathLeases("task-b", "run", root, ["src/core/parser"]).acquired, true);
  assert.throws(() => store.acquirePathLeases("task-x", "run", root, ["../escape"]), /escapes project root/);
  store.close();
});
