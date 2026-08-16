import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BrokerHandle, startBroker } from "../src/broker.js";
import { Task } from "../src/protocol.js";
import { post, temporaryDirectory, testConfig } from "./helpers.js";

interface Fixture {
  handle: BrokerHandle;
  root: string;
  operatorTokenPath: string;
  statePath: string;
  logPath: string;
  operator: string;
  strong: string;
  small: string;
}

async function fixture(): Promise<Fixture> {
  const root = temporaryDirectory();
  const operatorTokenPath = join(root, "operator.token");
  const statePath = join(root, "state.sqlite");
  const logPath = join(root, "bus.jsonl");
  const handle = await startBroker({ port: 0, config: testConfig(), statePath, logPath, operatorTokenPath });
  const operator = readFileSync(operatorTokenPath, "utf8").trim();
  const provisionStrong = await post<any>(handle.url, "/agent/provision", { token: operator, id: "fake-strong" });
  const provisionSmall = await post<any>(handle.url, "/agent/provision", { token: operator, id: "fake-small" });
  assert.equal(provisionStrong.status, 200);
  assert.equal(provisionSmall.status, 200);
  const strong = provisionStrong.body.token;
  const small = provisionSmall.body.token;
  assert.ok(strong && small);
  assert.equal((await post(handle.url, "/register", { token: strong, id: "fake-strong" })).status, 200);
  assert.equal((await post(handle.url, "/register", { token: small, id: "fake-small" })).status, 200);
  return { handle, root, operatorTokenPath, statePath, logPath, operator, strong, small };
}

async function createTask(f: Fixture, body: Record<string, unknown>): Promise<Task> {
  const response = await post<{ task: Task }>(f.handle.url, "/task/create", { token: f.operator, ...body });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.task;
}

test("registration cannot mint or steal an existing agent token", async (t) => {
  const f = await fixture();
  t.after(() => f.handle.close());
  const noToken = await post<any>(f.handle.url, "/register", { id: "fake-strong" });
  assert.equal(noToken.status, 401);
  const wrongIdentity = await post<any>(f.handle.url, "/register", { token: f.small, id: "fake-strong" });
  assert.equal(wrongIdentity.status, 401);
  const valid = await post<any>(f.handle.url, "/register", { token: f.strong, id: "fake-strong" });
  assert.equal(valid.status, 200);
  assert.equal("token" in valid.body, false);
  const reprovision = await post<any>(f.handle.url, "/agent/provision", { token: f.operator, id: "fake-strong" });
  assert.equal(reprovision.status, 200);
  assert.equal(reprovision.body.token, null);
});

test("task assign, message delivery, submit, revise and accept cycle", async (t) => {
  const f = await fixture();
  t.after(() => f.handle.close());
  const task = await createTask(f, {
    assignee: "fake-strong",
    title: "Implement feature",
    brief: "Change the scoped file and test it.",
    role: "implementation",
    complexity: 4,
    readOnly: true,
    reviewRequired: false,
  });
  assert.equal(task.state, "assigned");
  assert.match(task.routing?.reason ?? "", /fake-strong selected/);

  const mail = await post<any>(f.handle.url, "/wait", { token: f.strong, timeoutMs: 20 });
  assert.equal(mail.body.messages.length, 1);
  assert.equal(mail.body.messages[0].taskId, task.id);
  assert.equal((await post(f.handle.url, "/task/start", { token: f.strong, taskId: task.id })).status, 200);
  const submitted = await post<any>(f.handle.url, "/task/submit", {
    token: f.strong,
    taskId: task.id,
    summary: "implemented",
    details: "tests pass",
    changedFiles: ["src/feature.ts"],
    validation: [{ passed: true, summary: "unit test passed" }],
  });
  assert.equal(submitted.body.task.state, "submitted");
  const rejected = await post<any>(f.handle.url, "/task/review", {
    token: f.operator,
    taskId: task.id,
    accepted: false,
    feedback: "Add the missing edge-case test.",
  });
  assert.equal(rejected.body.task.state, "changes_requested");
  assert.equal(rejected.body.task.round, 2);
  const feedback = await post<any>(f.handle.url, "/wait", { token: f.strong, timeoutMs: 20 });
  assert.ok(feedback.body.messages.some((message: any) => message.subject.startsWith("[CHANGES")));
  await post(f.handle.url, "/task/submit", {
    token: f.strong,
    taskId: task.id,
    summary: "revised",
    details: "edge case covered",
    changedFiles: ["src/feature.ts", "tests/feature.test.ts"],
    validation: [{ passed: true, summary: "all tests passed" }],
  });
  const accepted = await post<any>(f.handle.url, "/task/review", {
    token: f.operator,
    taskId: task.id,
    accepted: true,
    feedback: "Verified independently.",
  });
  assert.equal(accepted.body.task.state, "accepted");
  assert.equal(accepted.body.task.review.accepted, true);
});

test("dependencies and path ownership block unsafe concurrent work", async (t) => {
  const f = await fixture();
  t.after(() => f.handle.close());
  const a = await createTask(f, {
    assignee: "fake-strong",
    title: "Core edit",
    brief: "Edit the core.",
    role: "implementation",
    complexity: 4,
    readOnly: false,
    pathScopes: ["src/core"],
    reviewRequired: false,
  });
  const overlap = await createTask(f, {
    assignee: "fake-small",
    title: "Overlapping edit",
    brief: "Edit a child path.",
    role: "cheap-worker",
    complexity: 1,
    readOnly: false,
    pathScopes: ["src/core/parser"],
    reviewRequired: false,
  });
  assert.equal(overlap.state, "blocked");
  assert.match(overlap.history.at(-1)?.note ?? "", /path scope conflict/);
  const dependent = await createTask(f, {
    assignee: "fake-small",
    title: "Dependent read",
    brief: "Continue after core edit.",
    role: "cheap-worker",
    complexity: 1,
    readOnly: true,
    dependencies: [a.id],
    reviewRequired: false,
  });
  assert.equal(dependent.state, "blocked");
  assert.match(dependent.history.at(-1)?.note ?? "", /dependencies/);

  await post(f.handle.url, "/task/submit", { token: f.strong, taskId: a.id, summary: "done" });
  await post(f.handle.url, "/task/review", { token: f.operator, taskId: a.id, accepted: true, feedback: "accepted" });
  const refreshed = await post<any>(f.handle.url, "/task/get", { taskId: overlap.id });
  assert.equal(refreshed.body.task.state, "assigned");
  const stillBlocked = await post<any>(f.handle.url, "/task/get", { taskId: dependent.id });
  assert.equal(stillBlocked.body.task.state, "blocked", "same worker remains bounded to one open task");
  const cancelled = await post<any>(f.handle.url, "/task/cancel", { token: f.operator, taskId: overlap.id, reason: "operator cancellation test" });
  assert.equal(cancelled.body.task.state, "cancelled");
  const released = await post<any>(f.handle.url, "/task/get", { taskId: dependent.id });
  assert.equal(released.body.task.state, "assigned");
});

test("failure retries the original worker then reroutes to a different family", async (t) => {
  const f = await fixture();
  t.after(() => f.handle.close());
  const task = await createTask(f, {
    assignee: "fake-small",
    title: "Failure policy",
    brief: "Exercise retry and reroute.",
    role: "cheap-worker",
    complexity: 1,
    readOnly: true,
    maxRetries: 1,
    reviewRequired: false,
  });
  const first = await post<any>(f.handle.url, "/task/failure", { token: f.small, taskId: task.id, error: "first failure", exitCode: 1 });
  assert.equal(first.body.task.state, "assigned");
  assert.equal(first.body.task.assignee, "fake-small");
  const second = await post<any>(f.handle.url, "/task/failure", { token: f.small, taskId: task.id, error: "second failure", exitCode: 1 });
  assert.equal(second.body.task.state, "assigned");
  assert.equal(second.body.task.assignee, "fake-strong");
  assert.ok(second.body.task.history.some((event: any) => event.kind === "rerouted"));
});

test("durable task graph and tokens survive a broker restart", async () => {
  const f = await fixture();
  const task = await createTask(f, {
    assignee: "fake-strong",
    title: "Persist me",
    brief: "Remain after restart.",
    role: "implementation",
    complexity: 4,
    readOnly: true,
    reviewRequired: false,
  });
  await f.handle.close();
  const reopened = await startBroker({
    port: 0,
    config: testConfig(),
    statePath: f.statePath,
    logPath: f.logPath,
    operatorTokenPath: f.operatorTokenPath,
  });
  try {
    const detail = await post<any>(reopened.url, "/task/get", { taskId: task.id });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.task.title, "Persist me");
    const register = await post<any>(reopened.url, "/register", { token: f.strong, id: "fake-strong" });
    assert.equal(register.status, 200, "pre-restart token remains valid");
    const pending = await post<any>(reopened.url, "/peek", { token: f.strong, drain: false });
    assert.ok(pending.body.messages.some((message: any) => message.taskId === task.id));
  } finally {
    await reopened.close();
  }
});
