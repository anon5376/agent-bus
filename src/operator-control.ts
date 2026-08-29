import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { BusConfig } from "./config.js";
import { ownedAgentBusPids, verifiedSupervisorProcess } from "./instance-processes.js";
import { APPLICATION_ROOT, EXPECTED_BUILD_ID, ensureAgentBusRunning, stopAgentBusInstance } from "./lifecycle.js";
import { fetchHealth, listenerPids, ProductHealth } from "./process-management.js";
import { PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";
import {
  BUS_HOME,
  BUS_PORT,
  BUS_URL,
  MAX_WAIT_MS,
  Message,
  Run,
  Task,
  parseBusState,
  parseStateWaitResponse,
} from "./protocol.js";
import {
  OPERATOR_TOKEN_PATH,
  agentTokenPath,
  readTokenFile,
  writePrivateToken,
} from "./security.js";
import { launchSupervisor } from "./supervisor-launch.js";

export type OperatorErrorCode =
  | "BROKER_UNAVAILABLE"
  | "AUTH_MISSING"
  | "INVALID_ARGUMENT"
  | "CONFIG_UNAVAILABLE"
  | "AGENT_START_FAILED"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BROKER_ERROR";

export class OperatorControlError extends Error {
  constructor(readonly code: OperatorErrorCode, message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "OperatorControlError";
  }
}

interface InstanceProbe {
  running: boolean;
  occupied: boolean;
  health: ProductHealth | null;
  reason?: string;
}

function terminalTask(state: Task["state"]): boolean {
  return ["accepted", "failed", "cancelled"].includes(state);
}

function terminalRun(status: Run["status"]): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

function validProjectRoot(value: unknown): string {
  const projectRoot = resolve(String(value ?? "").trim());
  if (!projectRoot || !existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    throw new OperatorControlError("INVALID_ARGUMENT", `project root is not a directory: ${projectRoot}`);
  }
  return projectRoot;
}

function currentOwnedHealth(health: ProductHealth | null, ownedBrokerPids: Set<number>, busHome: string): boolean {
  const runtime = health?.runtime;
  return health?.ok === true
    && health.product === PRODUCT_NAME
    && health.productProtocol === PRODUCT_PROTOCOL_VERSION
    && health.buildId === EXPECTED_BUILD_ID
    && health.dashboard === true
    && health.uiBuilt === true
    && ownedBrokerPids.has(Number(health.pid))
    && resolve(runtime?.busHome ?? "") === resolve(busHome)
    && resolve(runtime?.applicationRoot ?? "") === resolve(APPLICATION_ROOT);
}

function isAttentionMessage(message: Message): boolean {
  return message.type === "question"
    || (message.type === "control" && message.subject.startsWith("[ESCALATE"));
}

export class OperatorControl {
  constructor(
    private readonly operatorTokenPath = OPERATOR_TOKEN_PATH,
    private readonly busHome = BUS_HOME,
    private readonly port = BUS_PORT,
    private readonly url = BUS_URL,
  ) {}

  private token(): string {
    const token = readTokenFile(this.operatorTokenPath);
    if (!token) throw new OperatorControlError("AUTH_MISSING", `operator token missing at ${this.operatorTokenPath}`);
    return token;
  }

  private async instanceProbe(): Promise<InstanceProbe> {
    const health = await fetchHealth(this.url);
    const ownedBrokerPids = new Set(ownedAgentBusPids({
      busHome: this.busHome,
      port: this.port,
      includeSupervisors: false,
    }));
    if (currentOwnedHealth(health, ownedBrokerPids, this.busHome)) {
      return { running: true, occupied: true, health };
    }

    const listeners = listenerPids(this.port);
    const occupied = Boolean(health) || listeners.length > 0 || ownedBrokerPids.size > 0;
    if (!occupied) return { running: false, occupied: false, health: null };
    const reason = ownedBrokerPids.size > 0
      ? "registered Agent Bus process failed current-instance verification"
      : "unrelated listener occupies the configured Agent Bus port";
    return { running: false, occupied: true, health, reason };
  }

  private async call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    try {
      const response = await fetch(`${this.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, token: this.token() }),
        signal: AbortSignal.timeout(MAX_WAIT_MS + 15_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`broker ${path} -> ${response.status}: ${text.slice(0, 800)}`);
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const code: OperatorErrorCode = /unknown (run|task|agent)/i.test(message)
        ? "NOT_FOUND"
        : /already|conflict|not eligible|not submitted|ownership cannot be verified|no verified supervisor/i.test(message)
          ? "CONFLICT"
          : /configuration|config/i.test(message)
            ? "CONFIG_UNAVAILABLE"
            : "BROKER_ERROR";
      throw new OperatorControlError(code, message, error);
    }
  }

  async ensureRunning(): Promise<Record<string, unknown>> {
    try {
      const result = await ensureAgentBusRunning();
      const verified = await this.instanceProbe();
      if (!verified.running) {
        throw new Error(`refusing authenticated operator request: ${verified.reason ?? "running listener ownership is unverified"}`);
      }
      return result;
    } catch (error) {
      throw new OperatorControlError("BROKER_UNAVAILABLE", String((error as Error)?.message ?? error), error);
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const probe = await this.instanceProbe();
    if (!probe.running) {
      return {
        ok: true,
        running: false,
        occupied: probe.occupied,
        url: this.url,
        ...(probe.reason ? { reason: probe.reason } : {}),
      };
    }
    let state = parseBusState(await this.call("/state"));
    let pruned = false;
    for (const entry of state.roster ?? []) {
      const agentId = String(entry.id ?? "");
      const pid = Number(entry.supervisorPid);
      if (!agentId || !Number.isInteger(pid) || pid <= 0) continue;
      if (await this.clearStaleSupervisor(agentId, pid)) pruned = true;
    }
    if (pruned) state = parseBusState(await this.call("/state"));
    return { ok: true, running: true, occupied: true, health: probe.health, ...state };
  }

  async catalog(): Promise<{ ok: true; catalog: BusConfig }> {
    await this.ensureRunning();
    return { ok: true, catalog: await this.call<BusConfig>("/catalog") };
  }

  private async ensureAgentToken(agentId: string): Promise<void> {
    if (readTokenFile(agentTokenPath(agentId))) return;
    let provisioned = await this.call<{ token: string | null }>("/agent/provision", { id: agentId, rotate: false });
    if (!provisioned.token) provisioned = await this.call<{ token: string | null }>("/agent/provision", { id: agentId, rotate: true });
    if (!provisioned.token) throw new OperatorControlError("AGENT_START_FAILED", `could not provision ${agentId}`);
    writePrivateToken(agentTokenPath(agentId), provisioned.token);
  }

  private async clearStaleSupervisor(agentId: string, pid: number): Promise<boolean> {
    const verified = verifiedSupervisorProcess({
      busHome: this.busHome,
      port: this.port,
      applicationRoot: APPLICATION_ROOT,
      agentId,
      pid,
    });
    if (verified) return false;
    try {
      await this.call<Record<string, unknown>>("/kill", { agentId });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (!/ownership cannot be verified|no verified supervisor/i.test(message)) throw error;
    }
    return true;
  }

  async startAgent(agentId: string, projectRootValue: unknown): Promise<Record<string, unknown>> {
    await this.ensureRunning();
    const projectRoot = validProjectRoot(projectRootValue);
    const state = parseBusState(await this.call("/state"));
    const live = (state.roster ?? []).find((entry) => entry.id === agentId && Number(entry.supervisorPid) > 0);
    if (live) {
      const pid = Number(live.supervisorPid);
      if (!(await this.clearStaleSupervisor(agentId, pid))) {
        return { ok: true, agentId, started: false, pid, projectRoot };
      }
    }
    const configPath = String(state.configIdentity?.path ?? process.env.AGENT_BUS_CONFIG ?? "").trim();
    if (!configPath) throw new OperatorControlError("CONFIG_UNAVAILABLE", "running broker does not expose a persistent configuration path");
    await this.ensureAgentToken(agentId);
    const launched = launchSupervisor({
      agentId,
      projectRoot,
      configPath,
      busHome: this.busHome,
      port: this.port,
      url: this.url,
    });
    const deadline = Date.now() + 8_000;
    let revision = Number(state.revision ?? 0);
    while (Date.now() < deadline) {
      const waited = parseStateWaitResponse(await this.call("/state/wait", {
        sinceRevision: revision,
        timeoutMs: Math.min(1_000, deadline - Date.now()),
      }));
      revision = waited.revision;
      const next = parseBusState(await this.call("/state"));
      const registered = (next.roster ?? []).find((entry) => entry.id === agentId && Number(entry.supervisorPid) > 0);
      if (registered) return { ok: true, agentId, started: true, pid: Number(registered.supervisorPid), projectRoot };
    }
    throw new OperatorControlError("AGENT_START_FAILED", `supervisor ${agentId} did not register after launch (pid ${launched.pid})`);
  }

  async stopAgent(agentId: string): Promise<Record<string, unknown>> {
    await this.ensureRunning();
    return { ok: true, agentId, ...await this.call<Record<string, unknown>>("/kill", { agentId }) };
  }

  async createRun(input: {
    projectRoot: unknown;
    goal: string;
    role?: string;
    network?: boolean;
    startSupervisor?: boolean;
  }): Promise<Record<string, unknown>> {
    await this.ensureRunning();
    const projectRoot = validProjectRoot(input.projectRoot);
    const response = await this.call<{ run: Run; rootTask: Task }>("/run/create", {
      projectRoot,
      goal: input.goal,
      role: input.role ?? "manager",
      network: input.network !== false,
    });
    let supervisor: Record<string, unknown> | null = null;
    if (input.startSupervisor !== false && response.rootTask.assignee) {
      supervisor = await this.startAgent(response.rootTask.assignee, projectRoot);
    }
    return {
      ok: true,
      runId: response.run.id,
      rootTaskId: response.rootTask.id,
      assignee: response.rootTask.assignee,
      run: response.run,
      rootTask: response.rootTask,
      supervisor,
    };
  }

  async execute(input: {
    projectRoot: unknown;
    goal: string;
    role?: string;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const created = await this.createRun({ ...input, startSupervisor: true });
    const waited = await this.wait({ taskId: String(created.rootTaskId), timeoutMs: input.timeoutMs ?? MAX_WAIT_MS });
    return { ...created, execution: waited };
  }

  async delegate(input: {
    runId: string;
    parentTaskId?: string;
    title: string;
    description: string;
    role?: string;
    complexity?: number;
    contextTokens?: number;
    writeAccess?: boolean;
    shell?: boolean;
    network?: boolean;
    exactAgent?: string;
    exactModel?: string;
    families?: string[];
    providers?: string[];
    implementationFamily?: string;
    dependencies?: string[];
    pathScopes?: string[];
    validationRequirements?: Array<{ id?: string; description: string; command?: string; required?: boolean }>;
    reviewRequired?: boolean;
  }): Promise<Record<string, unknown>> {
    await this.ensureRunning();
    const created = await this.call<{ task: Task }>("/task/create", {
      runId: input.runId,
      parentTaskId: input.parentTaskId,
      title: input.title,
      brief: input.description,
      role: input.role ?? "implementation",
      complexity: input.complexity ?? 3,
      estimatedContextTokens: input.contextTokens ?? 8_000,
      readOnly: !Boolean(input.writeAccess),
      shell: Boolean(input.shell ?? input.writeAccess),
      network: Boolean(input.network),
      assignee: input.exactAgent,
      exactModel: input.exactModel,
      families: input.families ?? [],
      providers: input.providers ?? [],
      implementationFamily: input.implementationFamily,
      dependencies: input.dependencies ?? [],
      pathScopes: input.pathScopes ?? [],
      validationRequirements: input.validationRequirements ?? [],
      reviewRequired: input.reviewRequired,
    });
    const run = await this.call<{ run: Run }>("/run/get", { runId: input.runId });
    const supervisor = created.task.assignee
      ? await this.startAgent(created.task.assignee, run.run.projectRoot)
      : null;
    return { ok: true, taskId: created.task.id, assignee: created.task.assignee, task: created.task, supervisor };
  }

  async message(input: { to: string; subject: string; body: string; taskId?: string }): Promise<Record<string, unknown>> {
    await this.ensureRunning();
    return { ok: true, ...await this.call<Record<string, unknown>>("/send", { ...input, type: "info" }) };
  }

  async task(taskId: string): Promise<Record<string, unknown>> {
    await this.ensureRunning();
    return { ok: true, ...await this.call<Record<string, unknown>>("/task/detail", { taskId }) };
  }

  async run(runId: string): Promise<Record<string, unknown>> {
    await this.ensureRunning();
    return { ok: true, ...await this.call<Record<string, unknown>>("/run/get", { runId }) };
  }

  private async pendingAttention(): Promise<Message[]> {
    const peek = await this.call<{ messages: Message[] }>("/peek", { drain: false });
    const attention = (peek.messages ?? []).filter(isAttentionMessage);
    if (attention.length) {
      // The operator MCP is consuming the operator inbox. Once attention is surfaced,
      // mark the pending batch delivered so the same question does not wake every
      // subsequent wait; task/run state remains durable and inspectable separately.
      await this.call("/peek", { drain: true });
    }
    return attention;
  }

  async wait(input: { taskId?: string; runId?: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
    if (!input.taskId && !input.runId) throw new OperatorControlError("INVALID_ARGUMENT", "taskId or runId is required");
    await this.ensureRunning();
    const timeoutMs = Math.min(Math.max(1, Number(input.timeoutMs ?? MAX_WAIT_MS)), MAX_WAIT_MS);
    const deadline = Date.now() + timeoutMs;
    let state = parseBusState(await this.call("/state"));
    let revision = Number(state.revision ?? 0);
    for (;;) {
      if (input.taskId) {
        const detail = await this.call<{ task: Task }>("/task/detail", { taskId: input.taskId });
        if (terminalTask(detail.task.state) || detail.task.state === "submitted") {
          return { ok: true, terminal: terminalTask(detail.task.state), attentionRequired: false, task: detail.task, revision };
        }
      } else if (input.runId) {
        const detail = await this.call<{ run: Run; tasks: Task[] }>("/run/get", { runId: input.runId });
        if (terminalRun(detail.run.status)) return { ok: true, terminal: true, attentionRequired: false, ...detail, revision };
      }

      const attention = await this.pendingAttention();
      if (attention.length) {
        return { ok: true, terminal: false, attentionRequired: true, messages: attention, revision };
      }

      // /peek updates operator presence and therefore the broker revision. Absorb
      // that self-generated revision before blocking so this remains a true
      // notification wait rather than a polling loop.
      state = parseBusState(await this.call("/state"));
      revision = Math.max(revision, Number(state.revision ?? 0));
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new OperatorControlError("TIMEOUT", `timed out waiting for ${input.taskId ?? input.runId}`);
      const waited = parseStateWaitResponse(await this.call("/state/wait", {
        sinceRevision: revision,
        timeoutMs: Math.min(remaining, MAX_WAIT_MS),
      }));
      revision = waited.revision;
      state = parseBusState(await this.call("/state"));
      revision = Math.max(revision, Number(state.revision ?? 0));
    }
  }

  async review(input: { taskId: string; decision: "accept" | "revise"; feedback?: string }): Promise<Record<string, unknown>> {
    await this.ensureRunning();
    return {
      ok: true,
      ...await this.call<Record<string, unknown>>("/task/review", {
        taskId: input.taskId,
        accepted: input.decision === "accept",
        feedback: input.feedback?.trim() || (input.decision === "accept" ? "Accepted by operator." : "Revision requested by operator."),
      }),
    };
  }

  async cancel(input: { taskId?: string; runId?: string; reason?: string }): Promise<Record<string, unknown>> {
    await this.ensureRunning();
    if (input.taskId) return { ok: true, ...await this.call<Record<string, unknown>>("/task/cancel", input) };
    if (input.runId) return { ok: true, ...await this.call<Record<string, unknown>>("/run/cancel", input) };
    throw new OperatorControlError("INVALID_ARGUMENT", "taskId or runId is required");
  }

  async artifacts(input: { taskId?: string; runId?: string }): Promise<Record<string, unknown>> {
    await this.ensureRunning();
    if (input.taskId) {
      const detail = await this.call<{ task: Task }>("/task/detail", { taskId: input.taskId });
      return {
        ok: true,
        taskId: detail.task.id,
        result: detail.task.result ?? null,
        artifacts: detail.task.result?.artifacts ?? [],
        changedFiles: detail.task.result?.changedFiles ?? [],
        validation: detail.task.result?.validation ?? [],
      };
    }
    if (input.runId) {
      const detail = await this.call<{ run: Run; tasks: Task[] }>("/run/get", { runId: input.runId });
      return {
        ok: true,
        runId: detail.run.id,
        tasks: detail.tasks.map((task) => ({
          taskId: task.id,
          state: task.state,
          artifacts: task.result?.artifacts ?? [],
          changedFiles: task.result?.changedFiles ?? [],
          validation: task.result?.validation ?? [],
        })),
      };
    }
    throw new OperatorControlError("INVALID_ARGUMENT", "taskId or runId is required");
  }

  async stopInstance(): Promise<Record<string, unknown>> {
    const result = await stopAgentBusInstance(true);
    return { ok: true, ...result };
  }
}
