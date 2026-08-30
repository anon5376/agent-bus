import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BrokerHandle, startBroker } from "../src/broker.js";
import { renderBusState, renderUsage } from "../src/cli-view.js";
import {
  BusState,
  ProtocolError,
  emptyUsage,
  parseBusState,
} from "../src/protocol.js";
import { post, temporaryDirectory, testConfig } from "./helpers.js";

/** Exact body the deployed 2026-08 broker returned on POST /state. */
const TODAY_DEPLOYED_STATE = {
  roster: [
    {
      id: "kimi",
      role: "worker",
      model: "kimi-k3",
      description: "Kimi K3 via kimi-code",
      harness: "kimi",
      auth: "Kimi subscription",
      status: "offline",
      currentTaskId: null,
      pendingMessages: 0,
      lastSeenSecondsAgo: 162059,
      blocked: false,
      stalled: false,
      supervisorPid: null,
      workdir: null,
      cli: null,
      usage: { turns: 0, tokens: 0, costUSD: 0 },
    },
    {
      id: "operator",
      role: "human",
      model: "control-panel",
      description: "The human operator at the control panel.",
      harness: null,
      auth: null,
      status: "offline",
      currentTaskId: null,
      pendingMessages: 0,
      lastSeenSecondsAgo: 351968,
      blocked: false,
      stalled: false,
      supervisorPid: null,
      workdir: null,
      cli: null,
      usage: { turns: 0, tokens: 0, costUSD: 0 },
    },
  ],
  tasks: [],
  waiting: [],
};

function emptyPermissions() {
  return {
    canDelegate: false,
    canReview: false,
    filesystem: "read" as const,
    shell: false,
    network: false,
    maxDelegationDepth: 0,
    allowedPaths: ["."],
  };
}

function rosterEntry(overrides: Partial<BusState["roster"][number]> = {}): BusState["roster"][number] {
  return {
    id: "worker",
    role: "implementation",
    model: "fake-small",
    family: "fake-small-family",
    provider: "fake",
    description: "test agent",
    harness: "fake",
    auth: "none",
    authority: "worker",
    permissions: emptyPermissions(),
    status: "offline",
    currentTaskId: null,
    pendingMessages: 0,
    lastSeenSecondsAgo: 0,
    blocked: false,
    stalled: false,
    supervisorPid: null,
    workdir: null,
    cli: null,
    usage: emptyUsage(),
    ...overrides,
  };
}

function validState(overrides: Partial<BusState> = {}): BusState {
  return {
    roster: [],
    tasks: [],
    runs: [],
    waiting: [],
    telemetry: [],
    pathLeases: [],
    revision: 1,
    configIdentity: { path: null, digest: "test" },
    ...overrides,
  };
}

interface Fixture {
  handle: BrokerHandle;
  operator: string;
}

async function brokerFixture(config = testConfig()): Promise<Fixture> {
  const root = temporaryDirectory();
  const operatorTokenPath = join(root, "operator.token");
  const handle = await startBroker({
    port: 0,
    config,
    statePath: join(root, "state.sqlite"),
    logPath: join(root, "bus.jsonl"),
    operatorTokenPath,
  });
  return { handle, operator: readFileSync(operatorTokenPath, "utf8").trim() };
}

test("today's deployed /state body is a named contract error, not a TypeError on .length", () => {
  assert.throws(
    () => { void (TODAY_DEPLOYED_STATE as { runs?: unknown[] }).runs!.length; },
    { name: "TypeError" },
  );
  assert.throws(() => parseBusState(TODAY_DEPLOYED_STATE), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.field, "runs");
    assert.match(error.message, /missing field runs/);
    assert.equal(error.name, "ProtocolError");
    return true;
  });
  assert.throws(
    () => parseBusState({ ...TODAY_DEPLOYED_STATE, runs: [], telemetry: [], pathLeases: [], revision: 1, configIdentity: { path: null, digest: "x" } }),
    /missing field roster\[0\]\.family/,
  );
});

test("CLI status against today's broker pair names the missing field", async () => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      const path = (req.url ?? "").split("?")[0];
      if (path === "/health") {
        res.end(JSON.stringify({ ok: true, agents: 2 }));
        return;
      }
      res.end(JSON.stringify(TODAY_DEPLOYED_STATE));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${url}/health`);
    assert.equal(health.ok, true, await health.text());
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/cli.js", "status"], {
        env: {
          ...process.env,
          AGENT_BUS_HOST: "127.0.0.1",
          AGENT_BUS_PORT: String(port),
          AGENT_BUS_URL: url,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(output, /Cannot read properties of undefined/);
    assert.match(output, /missing field runs/);
    assert.match(output, /\/state/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("empty bus — zero runs, zero tasks, empty roster — renders", () => {
  const rendered = renderBusState(validState());
  assert.match(rendered, /AGENTS/);
  assert.match(rendered, /\(none\)/);
  assert.match(rendered, /\(no open tasks\)/);
  assert.doesNotMatch(rendered, /undefined\//);
  assert.equal(renderUsage(validState()), "");
});

test("stale roster with null currentTaskId/workdir/cli/supervisorPid renders", () => {
  const hours = 3600;
  const rendered = renderBusState(validState({
    roster: [
      rosterEntry({
        id: "kimi",
        role: "worker",
        model: "kimi-k3",
        family: "kimi",
        provider: "moonshot",
        harness: "kimi",
        status: "offline",
        lastSeenSecondsAgo: 44 * hours,
        currentTaskId: null,
        supervisorPid: null,
        workdir: null,
        cli: null,
      }),
      rosterEntry({
        id: "codex",
        role: "worker",
        model: "codex",
        family: "gpt",
        provider: "openai",
        harness: "codex",
        status: "offline",
        lastSeenSecondsAgo: 4 * 24 * hours,
        currentTaskId: null,
        supervisorPid: null,
        workdir: null,
        cli: null,
      }),
      rosterEntry({ id: "operator", role: "operator", family: "human", status: "idle" }),
    ],
  }));
  assert.match(rendered, /kimi/);
  assert.match(rendered, /kimi\/kimi-k3/);
  assert.match(rendered, /gpt\/codex/);
  assert.match(rendered, /offline/);
  assert.doesNotMatch(rendered, /undefined\//);
  assert.doesNotMatch(rendered, /operator/);
});

test("broker /state satisfies BusState, including empty and stale live roster", async (t) => {
  const emptyConfig = testConfig();
  for (const agent of Object.values(emptyConfig.agents)) agent.enabled = false;
  const empty = await brokerFixture(emptyConfig);
  t.after(() => empty.handle.close());
  const emptyResponse = await post(empty.handle.url, "/state", {});
  assert.equal(emptyResponse.status, 200, JSON.stringify(emptyResponse.body));
  const emptyState = parseBusState(emptyResponse.body);
  assert.deepEqual(emptyState.runs, []);
  assert.deepEqual(emptyState.tasks, []);
  assert.equal(emptyState.roster.filter((row) => row.id !== "operator").length, 0);
  const emptyRendered = renderBusState(emptyState);
  assert.match(emptyRendered, /\(none\)/);
  assert.match(emptyRendered, /\(no open tasks\)/);

  const agentsAlias = await post(empty.handle.url, "/agents", {});
  assert.equal(agentsAlias.status, 200, JSON.stringify(agentsAlias.body));
  assert.ok(Array.isArray((agentsAlias.body as { roster?: unknown }).roster));

  const stale = await brokerFixture();
  t.after(() => stale.handle.close());
  const now = Date.now();
  const strong = stale.handle.service.agents.get("fake-strong");
  const small = stale.handle.service.agents.get("fake-small");
  assert.ok(strong && small);
  strong.lastSeen = now - 44 * 60 * 60 * 1000;
  small.lastSeen = now - 4 * 24 * 60 * 60 * 1000;
  strong.currentTaskId = null;
  small.currentTaskId = null;
  stale.handle.service.supervisorMeta.clear();
  const staleResponse = await post(stale.handle.url, "/state", {});
  assert.equal(staleResponse.status, 200, JSON.stringify(staleResponse.body));
  const staleState = parseBusState(staleResponse.body);
  const live = staleState.roster.filter((row) => row.id !== "operator");
  assert.equal(live.length, 2);
  for (const row of live) {
    assert.equal(row.status, "offline");
    assert.equal(row.currentTaskId, null);
    assert.equal(row.workdir, null);
    assert.equal(row.cli, null);
    assert.equal(row.supervisorPid, null);
    assert.ok(row.family.length > 0, `${row.id} must carry family from config`);
    assert.doesNotMatch(row.family, /undefined/);
  }
  const hoursAgo = (id: string) => live.find((row) => row.id === id)!.lastSeenSecondsAgo;
  assert.ok(hoursAgo("fake-strong") >= 43 * 3600);
  assert.ok(hoursAgo("fake-small") >= 3.5 * 24 * 3600);
  const rendered = renderBusState(staleState);
  assert.match(rendered, /fake-strong-family\/fake-strong/);
  assert.match(rendered, /fake-small-family\/fake-small/);
  assert.doesNotMatch(rendered, /undefined\//);
  const usage = renderUsage(staleState);
  assert.match(usage, /fake-strong/);
  assert.match(usage, /fake-small/);
});

test("/status remains an authenticated write; /state stays a local unauthenticated read", async (t) => {
  const f = await brokerFixture();
  t.after(() => f.handle.close());
  const unauthStatus = await post(f.handle.url, "/status", { status: "idle" });
  assert.equal(unauthStatus.status, 401);
  const state = await post(f.handle.url, "/state", {});
  assert.equal(state.status, 200);
  parseBusState(state.body);
});
