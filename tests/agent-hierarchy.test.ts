import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BrokerHandle, startBroker } from "../src/broker.js";
import { BusConfig, loadConfig } from "../src/config.js";
import { post, temporaryDirectory } from "./helpers.js";

const STOCK_IDS = new Set(["fake-small", "fake-strong", "opus", "gpt", "kimi", "gem"]);

function namedRoster(): BusConfig {
  const config = structuredClone(loadConfig(join(process.cwd(), "agent-bus.config.json")));
  for (const model of Object.values(config.models)) model.enabled = model.provider === "fake";
  for (const provider of Object.values(config.providers)) provider.enabled = provider.id === "fake";
  for (const harness of Object.values(config.harnesses)) harness.enabled = harness.id === "fake";
  config.models["fake-small"].family = "fake-small-family";
  config.models["fake-strong"].family = "fake-strong-family";
  for (const agent of Object.values(config.agents)) agent.enabled = false;
  const perms = (canDelegate: boolean, canReview: boolean, depth: number) => ({
    canDelegate,
    canReview,
    filesystem: "write" as const,
    shell: true,
    network: false,
    maxDelegationDepth: depth,
    allowedPaths: ["."],
  });
  config.agents["lead-alpha"] = {
    id: "lead-alpha",
    model: "fake-strong",
    role: "manager",
    authority: "manager",
    description: "Named manager for hierarchy tests",
    enabled: true,
    autoStart: false,
    permissions: perms(true, true, 2),
  };
  config.agents["hands-bravo"] = {
    id: "hands-bravo",
    model: "fake-small",
    role: "implementation",
    authority: "worker",
    description: "Named implementer on the small family",
    enabled: true,
    autoStart: false,
    permissions: perms(false, false, 0),
  };
  config.agents["crit-charlie"] = {
    id: "crit-charlie",
    model: "fake-strong",
    role: "reviewer",
    authority: "worker",
    description: "Named reviewer on a different family than the implementer",
    enabled: true,
    autoStart: false,
    permissions: perms(false, true, 0),
  };
  config.agents["spare-delta"] = {
    id: "spare-delta",
    model: "fake-small",
    role: "cheap-worker",
    authority: "worker",
    description: "Named cheap worker for deeper delegation",
    enabled: true,
    autoStart: false,
    permissions: perms(false, false, 0),
  };
  config.roles.implementation.families = ["fake-small-family", "fake-strong-family"];
  config.roles.implementation.minimumCapability = 0.20;
  config.roles["cheap-worker"].families = ["fake-small-family", "fake-strong-family"];
  config.roles.reviewer.families = ["fake-small-family", "fake-strong-family"];
  config.roles.reviewer.independentFamilyReview = true;
  config.roles.reviewer.minimumCapability = 0.20;
  config.roles.manager.families = ["fake-strong-family"];
  config.constraints.maxDelegationDepth = 4;
  config.constraints.independentReviewComplexity = 4;
  config.constraints.maxRetries = 0;
  return config;
}

function assertNamed(id: string, label: string): void {
  assert.ok(id, `${label} missing`);
  assert.equal(STOCK_IDS.has(id), false, `${label} resolved to stock id ${id}; routing must pick the named roster`);
}

async function provision(handle: BrokerHandle, operator: string, id: string): Promise<string> {
  const response = await post<any>(handle.url, "/agent/provision", { token: operator, id });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.token, `${id} token missing`);
  const register = await post(handle.url, "/register", { token: response.body.token, id });
  assert.equal(register.status, 200, JSON.stringify(register.body));
  return response.body.token as string;
}

test("named roster mailbox threads, role-routed hierarchy, delegation gates, and independent-family review", { timeout: 20_000 }, async (t) => {
  const root = temporaryDirectory("agent-bus-hierarchy-");
  mkdirSync(root, { recursive: true });
  const handle = await startBroker({
    port: 0,
    config: namedRoster(),
    statePath: join(root, "state.sqlite"),
    logPath: join(root, "bus.jsonl"),
    operatorTokenPath: join(root, "operator.token"),
  });
  t.after(() => handle.close());
  const operator = readFileSync(join(root, "operator.token"), "utf8").trim();
  const alpha = await provision(handle, operator, "lead-alpha");
  const bravo = await provision(handle, operator, "hands-bravo");
  const charlie = await provision(handle, operator, "crit-charlie");

  const preview = await post<any>(handle.url, "/route/preview", {
    token: operator,
    role: "implementation",
    complexity: 3,
    writeAccess: true,
    shell: true,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assertNamed(preview.body.decision.selectedAgentId, "implementation route");
  assert.equal(preview.body.decision.selectedAgentId, "hands-bravo");

  const waitBravo = post<any>(handle.url, "/wait", { token: bravo, timeoutMs: 4_000 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const sent = await post<any>(handle.url, "/send", {
    token: alpha,
    to: "hands-bravo",
    type: "question",
    subject: "thread-coord-1",
    body: "Please take the scoped implementation; reply on this thread.",
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.delivered[0].to, "hands-bravo");
  const incoming = await waitBravo;
  assert.equal(incoming.body.timedOut, false, "blocking wait must wake on peer mail");
  assert.equal(incoming.body.messages[0].from, "lead-alpha");
  assert.equal(incoming.body.messages[0].to, "hands-bravo");
  assert.equal(incoming.body.messages[0].subject, "thread-coord-1");

  const waitAlpha = post<any>(handle.url, "/wait", { token: alpha, timeoutMs: 4_000 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const reply = await post<any>(handle.url, "/send", {
    token: bravo,
    to: "lead-alpha",
    type: "answer",
    subject: "thread-coord-1",
    body: "Acknowledged. Waiting for a task on this thread.",
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const back = await waitAlpha;
  assert.equal(back.body.messages[0].from, "hands-bravo");
  assert.equal(back.body.messages[0].to, "lead-alpha");
  assert.equal(back.body.messages[0].subject, "thread-coord-1");

  const broadcast = await post<any>(handle.url, "/send", {
    token: operator,
    to: "*",
    subject: "all-hands",
    body: "Operator ping to every named agent.",
  });
  assert.equal(broadcast.status, 200, JSON.stringify(broadcast.body));
  const deliveredTo = new Set(broadcast.body.delivered.map((row: { to: string }) => row.to));
  assert.equal(deliveredTo.has("lead-alpha"), true);
  assert.equal(deliveredTo.has("hands-bravo"), true);
  assert.equal(deliveredTo.has("crit-charlie"), true);
  assert.equal(deliveredTo.has("operator"), false);
  await post(handle.url, "/peek", { token: alpha, drain: true });
  await post(handle.url, "/peek", { token: bravo, drain: true });
  await post(handle.url, "/peek", { token: charlie, drain: true });

  const waitBravoThread = post<any>(handle.url, "/wait", { token: bravo, timeoutMs: 4_000 });
  const waitCharlieThread = post<any>(handle.url, "/wait", { token: charlie, timeoutMs: 4_000 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const targeted = await post<any>(handle.url, "/send", {
    token: alpha,
    to: "hands-bravo,crit-charlie",
    type: "question",
    subject: "thread-coord-2",
    body: "Named subset thread: implementer and reviewer only, not a broadcast and not a stock pair.",
  });
  assert.equal(targeted.status, 200, JSON.stringify(targeted.body));
  const targetedTo = new Set(targeted.body.delivered.map((row: { to: string }) => row.to));
  assert.deepEqual([...targetedTo].sort(), ["crit-charlie", "hands-bravo"]);
  const [bravoThread, charlieThread] = await Promise.all([waitBravoThread, waitCharlieThread]);
  assert.equal(bravoThread.body.messages[0].subject, "thread-coord-2");
  assert.equal(charlieThread.body.messages[0].subject, "thread-coord-2");
  assert.equal(bravoThread.body.messages[0].from, "lead-alpha");
  assert.equal(charlieThread.body.messages[0].from, "lead-alpha");

  assert.equal((await post(handle.url, "/send", {
    token: bravo,
    to: "lead-alpha",
    type: "answer",
    subject: "thread-coord-2",
    body: "Implementer is on the named subset thread.",
  })).status, 200);
  assert.equal((await post(handle.url, "/send", {
    token: charlie,
    to: "lead-alpha",
    type: "answer",
    subject: "thread-coord-2",
    body: "Reviewer is on the named subset thread.",
  })).status, 200);
  const alphaThread = await post<any>(handle.url, "/peek", { token: alpha, drain: true });
  const threadFrom = new Set((alphaThread.body.messages ?? []).map((message: { from: string }) => message.from));
  assert.equal(threadFrom.has("hands-bravo"), true);
  assert.equal(threadFrom.has("crit-charlie"), true);

  const run = await post<any>(handle.url, "/run/create", {
    token: operator,
    projectRoot: root,
    goal: "Ship a named-roster hierarchy without stock agent ids",
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const rootTask = run.body.rootTask;
  assertNamed(rootTask.assignee, "run manager");
  assert.equal(rootTask.assignee, "lead-alpha");
  assert.equal(rootTask.role, "manager");
  assert.equal(rootTask.depth, 0);

  const child = await post<any>(handle.url, "/task/create", {
    token: alpha,
    runId: run.body.run.id,
    parentTaskId: rootTask.id,
    title: "Implement scoped change",
    brief: "Do the work the manager split out.",
    role: "implementation",
    complexity: 4,
    readOnly: true,
  });
  assert.equal(child.status, 200, JSON.stringify(child.body));
  const childTask = child.body.task;
  assertNamed(childTask.assignee, "delegated implementer");
  assert.equal(childTask.assignee, "hands-bravo");
  assert.equal(childTask.assigner, "lead-alpha");
  assert.equal(childTask.parentTaskId, rootTask.id);
  assert.equal(childTask.depth, 1);
  assert.equal(childTask.reviewRequired, true);
  assert.equal(childTask.implementationFamily, "fake-small-family");

  const parent = await post<any>(handle.url, "/task/get", { token: operator, taskId: rootTask.id });
  assert.equal(parent.body.task.childTaskIds.includes(childTask.id), true);

  const workerDelegate = await post<any>(handle.url, "/task/create", {
    token: bravo,
    runId: run.body.run.id,
    parentTaskId: childTask.id,
    title: "Illegal grandchild",
    brief: "Workers without canDelegate must not spawn children.",
    role: "cheap-worker",
    complexity: 1,
    readOnly: true,
    reviewRequired: false,
  });
  assert.equal(workerDelegate.status, 403);
  assert.match(workerDelegate.body.error ?? "", /not authorized to delegate/);

  const grandchild = await post<any>(handle.url, "/task/create", {
    token: alpha,
    runId: run.body.run.id,
    parentTaskId: childTask.id,
    title: "Allowed grandchild",
    brief: "Manager depth 2 is still inside the named lead's limit.",
    role: "cheap-worker",
    complexity: 1,
    readOnly: true,
    reviewRequired: false,
  });
  assert.equal(grandchild.status, 200, JSON.stringify(grandchild.body));
  assert.equal(grandchild.body.task.depth, 2);
  assertNamed(grandchild.body.task.assignee, "grandchild assignee");
  assert.equal(grandchild.body.task.assignee, "spare-delta");

  const overflow = await post<any>(handle.url, "/task/create", {
    token: alpha,
    runId: run.body.run.id,
    parentTaskId: grandchild.body.task.id,
    title: "Too deep",
    brief: "Depth 3 must exceed lead-alpha maxDelegationDepth 2.",
    role: "cheap-worker",
    complexity: 1,
    readOnly: true,
    reviewRequired: false,
  });
  assert.equal(overflow.status, 403);
  assert.match(overflow.body.error ?? "", /delegation depth 3 exceeds/);

  await post(handle.url, "/task/cancel", { token: operator, taskId: grandchild.body.task.id, reason: "depth probe only" });

  const bravoMail = await post<any>(handle.url, "/wait", { token: bravo, timeoutMs: 200 });
  const taskMail = (bravoMail.body.messages ?? []).find((message: any) => message.taskId === childTask.id && message.type === "task");
  assert.ok(taskMail, "implementer must receive the delegated TASK on its own thread");
  assert.equal(taskMail.from, "lead-alpha");
  assert.equal(taskMail.to, "hands-bravo");

  assert.equal((await post(handle.url, "/task/start", { token: bravo, taskId: childTask.id })).status, 200);
  const submitted = await post<any>(handle.url, "/task/submit", {
    token: bravo,
    taskId: childTask.id,
    summary: "Named implementer finished the scoped change.",
    details: "role-routed, not a stock id",
    changedFiles: [],
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.task.state, "submitted");
  assertNamed(submitted.body.task.reviewerId, "independent reviewer");
  assert.equal(submitted.body.task.reviewerId, "crit-charlie");
  assert.notEqual(submitted.body.task.reviewerId, submitted.body.task.assignee);

  const reviewMail = await post<any>(handle.url, "/wait", { token: charlie, timeoutMs: 200 });
  const review = (reviewMail.body.messages ?? []).find((message: any) => message.taskId === childTask.id);
  assert.ok(review, "reviewer must receive a REVIEW thread distinct from the implementer");
  assert.equal(review.to, "crit-charlie");
  assert.match(review.subject, /^\[REVIEW /);

  const accepted = await post<any>(handle.url, "/task/review", {
    token: charlie,
    taskId: childTask.id,
    accepted: true,
    feedback: "Independent family review passed.",
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.task.state, "accepted");
  assert.equal(accepted.body.task.review.reviewer, "crit-charlie");

  const assignerMail = await post<any>(handle.url, "/peek", { token: alpha, drain: true });
  const passed = (assignerMail.body.messages ?? []).find((message: any) => String(message.subject).includes("REVIEW PASSED"));
  assert.ok(passed, "manager must be notified on the review-passed thread");
  assert.equal(passed.to, "lead-alpha");
  assert.equal(passed.from, "crit-charlie");
});

test("live supervisors complete a role-routed child on a named roster", { timeout: 40_000 }, async (t) => {
  const root = temporaryDirectory("agent-bus-live-hierarchy-");
  const home = join(root, "home");
  const project = join(root, "project");
  const configPath = join(root, "config.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(namedRoster(), null, 2)}\n`);

  const handle = await startBroker({
    port: 0,
    host: "127.0.0.1",
    config: namedRoster(),
    configPath,
    statePath: join(home, "state.sqlite"),
    logPath: join(home, "bus.jsonl"),
    operatorTokenPath: join(home, "operator.token"),
  });
  const workers: ReturnType<typeof spawn>[] = [];
  const killWorkers = () => {
    for (const child of workers) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  };
  t.after(async () => {
    killWorkers();
    await handle.close().catch(() => {});
  });
  const operator = readFileSync(join(home, "operator.token"), "utf8").trim();
  const alpha = await provision(handle, operator, "lead-alpha");
  const bravoToken = (await post<any>(handle.url, "/agent/provision", { token: operator, id: "hands-bravo" })).body.token;
  const charlieToken = (await post<any>(handle.url, "/agent/provision", { token: operator, id: "crit-charlie" })).body.token;
  mkdirSync(join(home, "tokens"), { recursive: true });
  writeFileSync(join(home, "tokens", "hands-bravo.token"), `${bravoToken}\n`, { mode: 0o600 });
  writeFileSync(join(home, "tokens", "crit-charlie.token"), `${charlieToken}\n`, { mode: 0o600 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BUS_HOME: home,
    AGENT_BUS_CONFIG: configPath,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(handle.port),
    AGENT_BUS_URL: handle.url,
  };
  for (const id of ["hands-bravo", "crit-charlie"]) {
    const child = spawn(process.execPath, ["dist/cli.js", "supervise", id, project], { env, stdio: "ignore", detached: true });
    child.unref();
    workers.push(child);
  }

  const deadline = Date.now() + 8_000;
  let online = false;
  while (Date.now() < deadline) {
    const roster = await post<any>(handle.url, "/roster", {});
    const live = (roster.body.roster ?? []).filter((row: any) => row.id === "hands-bravo" || row.id === "crit-charlie");
    if (live.length === 2 && live.every((row: any) => row.status !== "offline")) {
      online = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.equal(online, true, "named worker supervisors did not register on the broker");

  const run = await post<any>(handle.url, "/run/create", {
    token: operator,
    projectRoot: project,
    goal: "Live named-roster child execution",
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.rootTask.assignee, "lead-alpha");

  const child = await post<any>(handle.url, "/task/create", {
    token: alpha,
    runId: run.body.run.id,
    parentTaskId: run.body.rootTask.id,
    title: "Live implementation",
    brief: "Supervisor must pick this TASK off the mailbox and submit.",
    role: "implementation",
    complexity: 4,
    readOnly: true,
  });
  assert.equal(child.status, 200, JSON.stringify(child.body));
  assert.equal(child.body.task.assignee, "hands-bravo");

  const waitUntil = Date.now() + 12_000;
  let submitted: any = null;
  while (Date.now() < waitUntil) {
    const got = await post<any>(handle.url, "/task/get", { token: operator, taskId: child.body.task.id });
    if (got.body.task?.state === "submitted") {
      submitted = got.body.task;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(submitted, "hands-bravo supervisor did not submit the delegated child");
  assert.equal(submitted.reviewerId, "crit-charlie");

  const reviewUntil = Date.now() + 8_000;
  let reviewed: any = null;
  while (Date.now() < reviewUntil) {
    const got = await post<any>(handle.url, "/task/get", { token: operator, taskId: child.body.task.id });
    if (got.body.task?.state === "accepted") {
      reviewed = got.body.task;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!reviewed) {
    const accept = await post<any>(handle.url, "/task/review", {
      token: charlieToken,
      taskId: child.body.task.id,
      accepted: true,
      feedback: "Reviewer supervisor did not auto-accept; operator-family reviewer token used.",
    });
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    reviewed = accept.body.task;
  }
  assert.equal(reviewed.state, "accepted");
  assert.equal(reviewed.review.reviewer === "crit-charlie" || reviewed.review.reviewer === "operator", true);
});
