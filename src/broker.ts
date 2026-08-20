import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentPermissions, BusConfig, ResolvedAgent } from "./config.js";
import { DEFAULT_CONFIG_PATH, enabledAgents, loadConfig, resolveAgent } from "./config.js";
import { configDigest, resolvedExecutionConfig } from "./config-transitions.js";
import { processParentPid, verifiedSupervisorProcess } from "./instance-processes.js";
import {
  Agent,
  AgentStatus,
  BUS_HOME,
  BUS_HOST,
  BUS_PORT,
  ContextReference,
  MAX_WAIT_MS,
  Message,
  MessageType,
  ModelTelemetry,
  Run,
  STALE_AGENT_MS,
  Task,
  TaskResult,
  TaskState,
  UsageMetrics,
  ValidationRequirement,
  emptyUsage,
  newId,
} from "./protocol.js";
import {
  CandidateAvailability,
  RoutingDecision,
  RoutingTask,
  routeTask,
} from "./router.js";
import {
  OPERATOR_TOKEN_PATH,
  createBearerToken,
  ensurePrivateDirectories,
  hashToken,
  readTokenFile,
  writePrivateToken,
} from "./security.js";
import { StateStore, StoredIdentity } from "./store.js";

const APPLICATION_ROOT = resolve(process.env.AGENT_BUS_APPLICATION_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));

interface Waiter {
  agentId: string;
  resolve: (value: { messages: Message[]; timedOut: boolean }) => void;
  timer: NodeJS.Timeout;
}

interface StateWaiter {
  sinceRevision: number;
  resolve: (value: { revision: number; changed: boolean }) => void;
  timer: NodeJS.Timeout;
}

interface SupervisorMeta {
  pid: number;
  childPid: number | null;
  workdir: string;
  cli: string;
  startedAt: number;
}

export interface BrokerOptions {
  host?: string;
  port?: number;
  config?: BusConfig;
  configPath?: string;
  statePath?: string;
  logPath?: string;
  operatorTokenPath?: string;
}

export interface BrokerHandle {
  service: BrokerService;
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

class AuthError extends Error {}
class PermissionError extends Error {}
class ConflictError extends Error {}

const OPERATOR_ID = "operator";
const TERMINAL_STATES: TaskState[] = ["accepted", "failed", "cancelled"];
const OPEN_EXECUTION_STATES: TaskState[] = ["assigned", "in_progress", "submitted", "changes_requested"];

function operatorPermissions(): AgentPermissions {
  return {
    canDelegate: true,
    canReview: true,
    filesystem: "write",
    shell: true,
    network: true,
    maxDelegationDepth: Number.MAX_SAFE_INTEGER,
    allowedPaths: ["."],
  };
}

function boundedString(value: unknown, label: string, max: number, required = false): string {
  const text = String(value ?? "");
  if (required && !text.trim()) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return text;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
}

function contextReferences(value: unknown): ContextReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : { value: String(item) };
    const type = String(row.type ?? "path");
    if (!["path", "artifact", "summary", "commit", "url"].includes(type)) throw new Error(`invalid context reference type: ${type}`);
    return {
      type: type as ContextReference["type"],
      value: boundedString(row.value, "context reference value", 4096, true),
      description: row.description ? boundedString(row.description, "context reference description", 2048) : undefined,
      digest: row.digest ? boundedString(row.digest, "context reference digest", 256) : undefined,
    };
  });
}

function validationRequirements(value: unknown): ValidationRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : { description: String(item) };
    return {
      id: String(row.id ?? `validation-${index + 1}`),
      description: boundedString(row.description, "validation description", 4096, true),
      command: row.command ? boundedString(row.command, "validation command", 8192) : undefined,
      required: row.required !== false,
    };
  });
}

function resultPayload(body: Record<string, unknown>): TaskResult {
  const changedFiles = stringList(body.changedFiles).slice(0, 500);
  const artifacts = contextReferences(body.artifacts);
  const validation = Array.isArray(body.validation)
    ? body.validation.slice(0, 100).map((item) => {
        const row = item && typeof item === "object" ? item as Record<string, unknown> : { summary: String(item) };
        return {
          requirementId: row.requirementId ? String(row.requirementId) : undefined,
          command: row.command ? String(row.command) : undefined,
          passed: Boolean(row.passed),
          summary: boundedString(row.summary, "validation summary", 4096, true),
          artifact: row.artifact ? String(row.artifact) : undefined,
        };
      })
    : [];
  return {
    summary: boundedString(body.summary, "summary", 20_000, true),
    details: boundedString(body.details, "details", 100_000),
    changedFiles,
    artifacts,
    validation,
    completedAt: Date.now(),
  };
}

export class BrokerService {
  readonly config: BusConfig;
  readonly store: StateStore;
  readonly agents = new Map<string, Agent>();
  readonly tasks = new Map<string, Task>();
  readonly runs = new Map<string, Run>();
  readonly supervisorMeta = new Map<string, SupervisorMeta>();
  readonly usageByAgent = new Map<string, UsageMetrics>();
  readonly configPath: string | null;
  readonly instancePort: number;
  private waiters: Waiter[] = [];
  private stateWaiters: StateWaiter[] = [];
  private stateRevision = 1;
  private readonly logPath: string;
  private readonly operatorTokenPath: string;

  constructor(options: BrokerOptions = {}) {
    this.configPath = options.config ? null : resolve(options.configPath ?? process.env.AGENT_BUS_CONFIG ?? DEFAULT_CONFIG_PATH);
    this.config = options.config ?? loadConfig(this.configPath ?? undefined);
    this.instancePort = options.port ?? BUS_PORT;
    const statePath = options.statePath ?? join(BUS_HOME, "state.sqlite");
    this.logPath = options.logPath ?? join(BUS_HOME, "bus.jsonl");
    this.operatorTokenPath = options.operatorTokenPath ?? OPERATOR_TOKEN_PATH;
    ensurePrivateDirectories();
    mkdirSync(join(BUS_HOME, "logs"), { recursive: true });
    this.store = new StateStore(statePath);
    for (const agent of this.store.loadAgents()) this.agents.set(agent.id, agent);
    for (const task of this.store.loadTasks()) this.tasks.set(task.id, task);
    for (const run of this.store.loadRuns()) this.runs.set(run.id, run);
    for (const [id, usage] of Object.entries(this.store.allUsage())) this.usageByAgent.set(id, usage);
    this.ensureConfiguredRoster();
    this.ensureOperator();
  }

  close(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ messages: [], timedOut: true });
    }
    this.waiters = [];
    for (const waiter of this.stateWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ revision: this.stateRevision, changed: false });
    }
    this.stateWaiters = [];
    this.store.close();
  }

  private bumpStateRevision(): void {
    this.stateRevision += 1;
    const waiters = this.stateWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ revision: this.stateRevision, changed: true });
    }
  }

  private configIdentity(): { path: string | null; digest: string } {
    return { path: this.configPath, digest: configDigest(this.config) };
  }

  private audit(kind: string, data: unknown): void {
    this.bumpStateRevision();
    try {
      appendFileSync(this.logPath, JSON.stringify({ ts: Date.now(), kind, data }) + "\n");
    } catch {
      // The durable SQLite state is authoritative; audit logging must never crash the broker.
    }
  }

  private ensureConfiguredRoster(): void {
    for (const resolvedAgent of enabledAgents(this.config)) {
      if (this.agents.has(resolvedAgent.id)) continue;
      this.agents.set(resolvedAgent.id, this.agentFromDefinition(resolvedAgent, 0));
    }
  }

  private ensureOperator(): void {
    const permissions = operatorPermissions();
    const now = Date.now();
    const existingIdentity = this.store.identityById(OPERATOR_ID);
    const fileToken = readTokenFile(this.operatorTokenPath);
    if (!existingIdentity || !fileToken || hashToken(fileToken) !== existingIdentity.tokenHash) {
      const token = createBearerToken();
      this.store.upsertIdentity({
        id: OPERATOR_ID,
        tokenHash: hashToken(token),
        authority: "operator",
        permissions,
        createdAt: existingIdentity?.createdAt ?? now,
        updatedAt: now,
      });
      writePrivateToken(this.operatorTokenPath, token);
      this.audit("operator_token_rotated", { reason: existingIdentity ? "token file missing or mismatched" : "initial bootstrap" });
    }
    const existingAgent = this.agents.get(OPERATOR_ID);
    const operator: Agent = {
      id: OPERATOR_ID,
      role: "operator",
      model: "control-panel",
      family: "human",
      provider: "local",
      harness: "control-panel",
      description: "Human operator at the local control plane.",
      auth: "local operator token",
      authority: "operator",
      permissions,
      status: "idle",
      currentTaskId: existingAgent?.currentTaskId ?? null,
      registeredAt: existingAgent?.registeredAt || now,
      lastSeen: now,
    };
    this.agents.set(OPERATOR_ID, operator);
    this.store.saveAgent(operator);
  }

  private agentFromDefinition(definition: ResolvedAgent, registeredAt: number): Agent {
    return {
      id: definition.id,
      role: definition.role,
      model: definition.modelDefinition.id,
      family: definition.modelDefinition.family,
      provider: definition.modelDefinition.provider,
      harness: definition.harnessDefinition.id,
      description: definition.description,
      auth: definition.providerDefinition.authSource,
      authority: definition.authority,
      permissions: definition.permissions,
      status: registeredAt ? "idle" : "offline",
      currentTaskId: null,
      registeredAt,
      lastSeen: registeredAt,
    };
  }

  private caller(body: Record<string, unknown>): StoredIdentity {
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) throw new AuthError("unauthorized: missing bearer token");
    const identity = this.store.identityByTokenHash(hashToken(token));
    if (!identity) throw new AuthError("unauthorized: invalid bearer token");
    return identity;
  }

  private requireOperator(body: Record<string, unknown>): StoredIdentity {
    const identity = this.caller(body);
    if (identity.authority !== "operator") throw new PermissionError("only the operator may perform this action");
    return identity;
  }

  private touch(agentId: string, status?: AgentStatus): Agent | undefined {
    const agent = this.agents.get(agentId);
    if (!agent) return undefined;
    agent.lastSeen = Date.now();
    if (status) agent.status = status;
    this.store.saveAgent(agent);
    this.bumpStateRevision();
    return agent;
  }

  private effectiveStatus(agent: Agent): AgentStatus {
    if (agent.id === OPERATOR_ID) return agent.status;
    if (!agent.registeredAt || !agent.lastSeen) return "offline";
    if (Date.now() - agent.lastSeen > STALE_AGENT_MS) return "offline";
    return agent.status;
  }

  roster(): Record<string, unknown>[] {
    return [...this.agents.values()]
      .map((agent) => {
        const pending = this.store.pendingMessages(agent.id).length;
        const blocked = this.waiters.some((waiter) => waiter.agentId === agent.id);
        const supervisor = this.supervisorMeta.get(agent.id);
        const status = this.effectiveStatus(agent);
        return {
          id: agent.id,
          role: agent.role,
          model: agent.model,
          family: agent.family,
          provider: agent.provider,
          description: agent.description,
          harness: agent.harness,
          auth: agent.auth,
          authority: agent.authority,
          permissions: agent.permissions,
          status,
          currentTaskId: agent.currentTaskId,
          pendingMessages: pending,
          lastSeenSecondsAgo: agent.lastSeen ? Math.max(0, Math.round((Date.now() - agent.lastSeen) / 1000)) : -1,
          blocked,
          stalled: pending > 0 && !blocked && status !== "working",
          supervisorPid: supervisor?.pid ?? null,
          workdir: supervisor?.workdir ?? null,
          cli: supervisor?.cli ?? agent.harness,
          usage: this.usageByAgent.get(agent.id) ?? emptyUsage(),
        };
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  private availability(): CandidateAvailability[] {
    const openByAgent = new Map<string, number>();
    for (const task of this.tasks.values()) {
      if (OPEN_EXECUTION_STATES.includes(task.state) && task.assignee) {
        openByAgent.set(task.assignee, (openByAgent.get(task.assignee) ?? 0) + 1);
      }
    }
    return enabledAgents(this.config).map((agent) => {
      const live = this.agents.get(agent.id);
      return {
        agentId: agent.id,
        status: live ? this.effectiveStatus(live) : "unregistered",
        openTasks: openByAgent.get(agent.id) ?? 0,
      };
    });
  }

  private routing(task: RoutingTask): RoutingDecision {
    return routeTask(this.config, task, this.store.telemetry(), this.availability());
  }

  private makeMessage(input: {
    from: string;
    to: string;
    type: MessageType;
    subject: string;
    body: string;
    taskId?: string | null;
    refs?: ContextReference[];
  }): Message {
    return {
      id: newId("msg"),
      seq: 0,
      ts: Date.now(),
      from: input.from,
      to: input.to,
      type: input.type,
      subject: input.subject,
      body: input.body,
      taskId: input.taskId ?? null,
      refs: input.refs ?? [],
    };
  }

  private deliver(input: Message): Message {
    const message = this.store.appendMessage(input);
    this.audit("message", message);
    this.flushWaiters();
    return message;
  }

  private flushWaiters(): void {
    if (!this.waiters.length) return;
    const stillWaiting: Waiter[] = [];
    const handled = new Set<string>();
    for (const waiter of this.waiters) {
      if (handled.has(waiter.agentId)) {
        stillWaiting.push(waiter);
        continue;
      }
      const pending = this.store.pendingMessages(waiter.agentId);
      if (!pending.length) {
        stillWaiting.push(waiter);
        continue;
      }
      handled.add(waiter.agentId);
      clearTimeout(waiter.timer);
      this.store.markMessagesDelivered(pending.map((message) => message.id));
      waiter.resolve({ messages: pending, timedOut: false });
    }
    this.waiters = stillWaiting;
  }

  private resolveRecipients(from: string, to: string): string[] {
    if (to === "*" || to.toLowerCase() === "all") {
      return [...this.agents.keys()].filter((id) => id !== from && id !== OPERATOR_ID);
    }
    return [...new Set(to.split(",").map((part) => part.trim()).filter(Boolean))];
  }

  private taskView(task: Task): Task {
    return { ...task, history: task.history.slice(-30) };
  }

  private taskProjectRoot(task: Task): string | null {
    if (task.runId) return this.runs.get(task.runId)?.projectRoot ?? null;
    return this.config.constraints.defaultWriteScopes.length ? process.cwd() : null;
  }

  private dependenciesSatisfied(task: Task): boolean {
    return task.dependencyIds.every((id) => this.tasks.get(id)?.state === "accepted");
  }

  private activeExecutionCount(): number {
    return [...this.tasks.values()].filter((task) => OPEN_EXECUTION_STATES.includes(task.state)).length;
  }

  private assignmentBody(task: Task): string {
    const run = task.runId ? this.runs.get(task.runId) : null;
    const references = task.contextRefs.length
      ? task.contextRefs.map((ref) => `- ${ref.type}: ${ref.value}${ref.description ? ` — ${ref.description}` : ""}`).join("\n")
      : "- none; inspect the project on demand";
    const validation = task.validationRequirements.length
      ? task.validationRequirements.map((item) => `- ${item.required ? "required" : "optional"}: ${item.description}${item.command ? ` (${item.command})` : ""}`).join("\n")
      : "- report the checks you actually ran";
    return [
      task.brief,
      task.context ? `\nScoped context summary:\n${task.context}` : "",
      `\nProject root: ${run?.projectRoot ?? "use your supervisor working directory"}`,
      `Role: ${task.role}; complexity: ${task.complexity}/5; read-only: ${task.readOnly}`,
      `Write scopes: ${task.readOnly ? "none" : task.pathScopes.join(", ") || "."}`,
      `\nContext references:\n${references}`,
      `\nValidation contract:\n${validation}`,
      `\nReturn a concise structured report. Prefer file/artifact references over copying large content.`,
      `When finished call bus_submit_work with task_id="${task.id}".`,
    ].join("\n");
  }

  private reviewerBody(task: Task): string {
    return [
      `Independently review task ${task.id}: ${task.title}`,
      `Implementation family: ${task.implementationFamily ?? "unknown"}. Your family must be independent when possible.`,
      `Result summary: ${task.result?.summary ?? "(missing)"}`,
      task.result?.changedFiles.length ? `Changed files:\n${task.result.changedFiles.map((path) => `- ${path}`).join("\n")}` : "",
      task.result?.validation.length ? `Validation observations:\n${task.result.validation.map((item) => `- ${item.passed ? "PASS" : "FAIL"}: ${item.summary}`).join("\n")}` : "",
      `Read the relevant files/diffs and run the required checks yourself.`,
      `Then call bus_review_work(task_id="${task.id}", accepted=..., feedback=...).`,
    ].filter(Boolean).join("\n\n");
  }

  private addEvent(task: Task, actor: string, kind: Task["history"][number]["kind"], state: TaskState, note: string, metadata?: Record<string, unknown>): void {
    task.history.push({ ts: Date.now(), actor, kind, state, note, metadata });
    task.updatedAt = Date.now();
  }

  private tryDispatch(task: Task, reason = "ready"): boolean {
    if (TERMINAL_STATES.includes(task.state) || task.state === "submitted") return false;
    if (!this.dependenciesSatisfied(task)) {
      task.state = "blocked";
      if (task.history.at(-1)?.kind !== "blocked" || task.history.at(-1)?.note !== "waiting for dependencies") {
        this.addEvent(task, "broker", "blocked", "blocked", "waiting for dependencies");
      }
      this.store.saveTask(task);
      return false;
    }
    if (this.activeExecutionCount() >= this.config.constraints.maxConcurrentTasks && !OPEN_EXECUTION_STATES.includes(task.state)) {
      task.state = "blocked";
      this.addEvent(task, "broker", "blocked", "blocked", "global concurrency limit reached");
      this.store.saveTask(task);
      return false;
    }
    if (!task.assignee) {
      const decision = this.routing({
        role: task.role,
        complexity: task.complexity,
        contextTokens: task.estimatedContextTokens,
        writeAccess: !task.readOnly,
        shell: !task.readOnly,
        network: task.role === "research",
        implementationFamily: task.implementationFamily ?? undefined,
      });
      task.routing = decision;
      this.store.saveRoutingDecision(task.id, task.runId, decision);
      if (!decision.selectedAgentId) {
        task.state = "blocked";
        this.addEvent(task, "router", "blocked", "blocked", decision.reason);
        this.store.saveTask(task);
        return false;
      }
      task.assignee = decision.selectedAgentId;
    }
    const assigneeBusy = [...this.tasks.values()].some((candidate) =>
      candidate.id !== task.id && candidate.assignee === task.assignee && OPEN_EXECUTION_STATES.includes(candidate.state),
    );
    if (assigneeBusy) {
      task.state = "blocked";
      this.addEvent(task, "broker", "blocked", "blocked", `assignee ${task.assignee} already owns an open task`);
      this.store.saveTask(task);
      return false;
    }
    if (!task.readOnly && this.config.constraints.isolation === "path-locks") {
      const projectRoot = this.taskProjectRoot(task);
      if (!projectRoot) throw new Error(`cannot acquire path leases without a project root for ${task.id}`);
      const leaseGroup = task.runId ?? `standalone:${projectRoot}`;
      const lease = this.store.acquirePathLeases(task.id, leaseGroup, projectRoot, task.pathScopes.length ? task.pathScopes : ["."]);
      task.pathScopes = lease.normalized;
      if (!lease.acquired) {
        task.state = "blocked";
        this.addEvent(
          task,
          "broker",
          "blocked",
          "blocked",
          `path scope conflict with ${lease.conflicts.map((item) => `${item.taskId}:${item.path}`).join(", ")}`,
          { conflicts: lease.conflicts },
        );
        this.store.saveTask(task);
        return false;
      }
    }

    task.state = "assigned";
    this.addEvent(task, "broker", "assigned", "assigned", reason, { assignee: task.assignee, routing: task.routing?.reason });
    const agent = this.agents.get(task.assignee);
    if (agent) {
      agent.currentTaskId = task.id;
      this.store.saveAgent(agent);
    }
    this.store.saveTask(task);
    this.deliver(this.makeMessage({
      from: task.assigner,
      to: task.assignee,
      type: "task",
      subject: `[TASK ${task.id}] ${task.title}`,
      body: this.assignmentBody(task),
      taskId: task.id,
      refs: task.contextRefs,
    }));
    return true;
  }

  private refreshBlocked(runId?: string | null): void {
    const blocked = [...this.tasks.values()]
      .filter((task) => task.state === "blocked" && (!runId || task.runId === runId))
      .sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt);
    for (const task of blocked) {
      if (this.activeExecutionCount() >= this.config.constraints.maxConcurrentTasks) break;
      if (this.tryDispatch(task, "dependencies and capacity available")) {
        this.addEvent(task, "broker", "dependency_released", task.state, "blocked task released");
        this.store.saveTask(task);
      }
    }
  }

  private completeRunIfReady(task: Task): void {
    if (!task.runId) return;
    const run = this.runs.get(task.runId);
    if (!run || run.rootTaskId !== task.id || task.state !== "accepted") return;
    const open = [...this.tasks.values()].some((candidate) => candidate.runId === run.id && !TERMINAL_STATES.includes(candidate.state));
    run.status = open ? "active" : "completed";
    run.updatedAt = Date.now();
    this.store.saveRun(run);
  }

  private createTask(identity: StoredIdentity, body: Record<string, unknown>): Task {
    const parentTaskId = body.parentTaskId ? String(body.parentTaskId) : null;
    const parent = parentTaskId ? this.tasks.get(parentTaskId) : undefined;
    if (parentTaskId && !parent) throw new Error(`unknown parent task: ${parentTaskId}`);
    if (parent && identity.id !== OPERATOR_ID && identity.id !== parent.assignee && identity.id !== parent.assigner) {
      throw new PermissionError(`only the parent worker, parent assigner, or operator may create child tasks`);
    }
    if (identity.id !== OPERATOR_ID && !identity.permissions.canDelegate) {
      throw new PermissionError(`${identity.id} is not authorized to delegate tasks`);
    }
    const depth = parent ? parent.depth + 1 : 0;
    const identityDepth = identity.permissions.maxDelegationDepth;
    if (depth > this.config.constraints.maxDelegationDepth || depth > identityDepth) {
      throw new PermissionError(`delegation depth ${depth} exceeds the configured limit`);
    }
    const runId = body.runId ? String(body.runId) : parent?.runId ?? null;
    if (runId && !this.runs.has(runId)) throw new Error(`unknown run: ${runId}`);
    const dependencyIds = stringList(body.dependencies ?? body.dependencyIds);
    for (const dependency of dependencyIds) {
      const task = this.tasks.get(dependency);
      if (!task) throw new Error(`unknown dependency: ${dependency}`);
      if (runId && task.runId !== runId) throw new Error(`dependency ${dependency} belongs to a different run`);
    }

    const now = Date.now();
    const role = String(body.role ?? "implementation");
    if (!this.config.roles[role]) throw new Error(`unknown role: ${role}`);
    const complexity = Math.max(1, Math.min(5, Number(body.complexity ?? 3) || 3));
    const readOnly = Boolean(body.readOnly ?? !this.config.roles[role].requireWrite);
    const requestedAssignee = body.assignee ? String(body.assignee) : "";
    const routingRequest: RoutingTask = {
      role,
      complexity,
      contextTokens: Math.max(0, Number(body.estimatedContextTokens ?? 8_000) || 0),
      writeAccess: !readOnly,
      shell: Boolean(body.shell ?? this.config.roles[role].requireShell ?? !readOnly),
      network: Boolean(body.network ?? this.config.roles[role].requireNetwork ?? role === "research"),
      exactAgent: requestedAssignee || undefined,
      exactModel: body.exactModel ? String(body.exactModel) : undefined,
      families: stringList(body.families),
      providers: stringList(body.providers),
      implementationFamily: body.implementationFamily ? String(body.implementationFamily) : undefined,
      preferSubscription: body.preferSubscription === undefined ? undefined : Boolean(body.preferSubscription),
    };
    const decision = this.routing(routingRequest);
    if (requestedAssignee && decision.selectedAgentId !== requestedAssignee) {
      throw new ConflictError(`explicit assignee ${requestedAssignee} is not eligible: ${decision.reason}`);
    }
    const task: Task = {
      id: newId("task"),
      runId,
      parentTaskId,
      childTaskIds: [],
      dependencyIds,
      title: boundedString(body.title, "title", 500, true),
      brief: boundedString(body.brief, "brief", 50_000, true),
      context: boundedString(body.context, "context", 20_000),
      contextRefs: contextReferences(body.contextRefs),
      assigner: identity.id,
      assignee: decision.selectedAgentId ?? requestedAssignee,
      role,
      complexity,
      estimatedContextTokens: routingRequest.contextTokens,
      readOnly,
      pathScopes: readOnly ? [] : (stringList(body.pathScopes).length ? stringList(body.pathScopes) : this.config.constraints.defaultWriteScopes),
      validationRequirements: validationRequirements(body.validationRequirements),
      state: "blocked",
      round: 1,
      attempts: 0,
      maxRetries: Math.max(0, Math.min(10, Number(body.maxRetries ?? this.config.constraints.maxRetries) || 0)),
      depth,
      reviewRequired: body.reviewRequired === undefined
        ? (role === "implementation" && complexity >= this.config.constraints.independentReviewComplexity)
        : Boolean(body.reviewRequired),
      implementationFamily: decision.selectedFamily,
      reviewerId: null,
      routing: decision,
      reviewRouting: null,
      result: null,
      review: null,
      usage: emptyUsage(),
      createdAt: now,
      updatedAt: now,
      history: [{ ts: now, actor: identity.id, kind: "created", state: "blocked", note: String(body.title), metadata: { role, complexity } }],
    };
    this.tasks.set(task.id, task);
    this.store.saveRoutingDecision(task.id, runId, decision);
    if (parent) {
      parent.childTaskIds.push(task.id);
      parent.updatedAt = now;
      this.store.saveTask(parent);
    }
    this.store.saveTask(task);
    this.tryDispatch(task, "task created and ready");
    this.audit("task_create", { taskId: task.id, runId, parentTaskId, assigner: identity.id, assignee: task.assignee, routing: decision.reason });
    return task;
  }

  private sendForReview(task: Task): void {
    const reviewDecision = this.routing({
      role: "reviewer",
      complexity: task.complexity,
      contextTokens: Math.max(task.estimatedContextTokens, 8_000),
      writeAccess: false,
      shell: true,
      network: false,
      implementationFamily: task.implementationFamily ?? undefined,
    });
    task.reviewRouting = reviewDecision;
    this.store.saveRoutingDecision(task.id, task.runId, reviewDecision);
    const reviewerId = reviewDecision.selectedAgentId ?? task.assigner;
    task.reviewerId = reviewerId;
    this.store.saveTask(task);
    this.deliver(this.makeMessage({
      from: task.assigner,
      to: reviewerId,
      type: "feedback",
      subject: `[REVIEW ${task.id}] ${task.title}`,
      body: this.reviewerBody(task),
      taskId: task.id,
      refs: [...task.contextRefs, ...(task.result?.artifacts ?? [])],
    }));
  }

  async handle(path: string, body: Record<string, unknown>): Promise<unknown> {
    switch (path) {
      case "/agent/provision": {
        this.requireOperator(body);
        const id = String(body.id ?? "");
        if (!id || id === OPERATOR_ID) throw new Error("a configured non-operator agent id is required");
        const definition = resolveAgent(this.config, id);
        const existing = this.store.identityById(id);
        const rotate = Boolean(body.rotate);
        if (existing && !rotate) {
          return { id, provisioned: false, token: null, message: "identity already provisioned; use rotate=true only when deliberately replacing its token" };
        }
        const token = createBearerToken();
        const now = Date.now();
        this.store.upsertIdentity({
          id,
          tokenHash: hashToken(token),
          authority: definition.authority,
          permissions: definition.permissions,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        this.audit(existing ? "agent_token_rotated" : "agent_provisioned", { id, by: OPERATOR_ID });
        return { id, provisioned: true, rotated: Boolean(existing), token };
      }

      case "/register": {
        const identity = this.caller(body);
        const id = String(body.id ?? "");
        if (id !== identity.id) throw new AuthError(`token belongs to ${identity.id}, not ${id || "(missing id)"}`);
        if (id === OPERATOR_ID) throw new AuthError("operator identity cannot register as an agent");
        const definition = resolveAgent(this.config, id);
        const existing = this.agents.get(id);
        const now = Date.now();
        const agent = this.agentFromDefinition(definition, existing?.registeredAt || now);
        agent.currentTaskId = existing?.currentTaskId ?? null;
        agent.status = "idle";
        agent.lastSeen = now;
        this.agents.set(id, agent);
        this.store.saveAgent(agent);
        const supervisorPid = Number(body.pid);
        const verified = verifiedSupervisorProcess({
          busHome: BUS_HOME,
          port: this.instancePort,
          applicationRoot: APPLICATION_ROOT,
          agentId: id,
          pid: supervisorPid,
        });
        if (verified) {
          this.supervisorMeta.set(id, {
            pid: supervisorPid,
            childPid: null,
            workdir: String(body.workdir ?? ""),
            cli: String(body.cli ?? agent.harness),
            startedAt: Date.now(),
          });
        }
        this.audit("register", { id, role: agent.role, model: agent.model, harness: agent.harness, supervisorVerified: Boolean(verified) });
        return { agent, pendingMessages: this.store.pendingMessages(id).length, roster: this.roster() };
      }

      case "/status": {
        const identity = this.caller(body);
        const agent = this.touch(identity.id, body.status as AgentStatus | undefined);
        if (!agent) throw new Error(`unknown registered agent: ${identity.id}`);
        return { ok: true, status: this.effectiveStatus(agent) };
      }

      case "/presence": {
        const identity = this.caller(body);
        const pid = Number(body.pid);
        const existing = this.supervisorMeta.get(identity.id);
        if (existing && existing.pid === pid && verifiedSupervisorProcess({
          busHome: BUS_HOME,
          port: this.instancePort,
          applicationRoot: APPLICATION_ROOT,
          agentId: identity.id,
          pid,
        })) {
          const childPid = Number(body.childPid);
          existing.childPid = Number.isInteger(childPid) && childPid > 0 && processParentPid(childPid) === pid ? childPid : null;
          existing.workdir = String(body.workdir ?? existing.workdir);
          existing.cli = String(body.cli ?? existing.cli);
        }
        this.touch(identity.id);
        return { ok: true, supervisorVerified: Boolean(existing && existing.pid === pid) };
      }

      case "/agent/execution-config": {
        const identity = this.caller(body);
        const id = String(body.id ?? identity.id);
        if (identity.authority !== "operator" && id !== identity.id) throw new PermissionError(`only ${identity.id} may resolve its execution configuration`);
        return { agent: resolvedExecutionConfig(this.config, id), configIdentity: this.configIdentity() };
      }

      case "/usage": {
        const identity = this.caller(body);
        const previous = this.usageByAgent.get(identity.id) ?? emptyUsage();
        const usage: UsageMetrics = {
          turns: Math.max(previous.turns, Number(body.turns ?? previous.turns) || 0),
          inputTokens: Math.max(previous.inputTokens, Number(body.inputTokens ?? previous.inputTokens) || 0),
          outputTokens: Math.max(previous.outputTokens, Number(body.outputTokens ?? previous.outputTokens) || 0),
          totalTokens: Math.max(previous.totalTokens, Number(body.totalTokens ?? body.tokens ?? previous.totalTokens) || 0),
          costUSD: Math.max(previous.costUSD, Number(body.costUSD ?? previous.costUSD) || 0),
          latencyMs: Math.max(previous.latencyMs, Number(body.latencyMs ?? previous.latencyMs) || 0),
        };
        this.usageByAgent.set(identity.id, usage);
        this.store.saveUsage(identity.id, usage);
        return { ok: true };
      }

      case "/roster":
        return { roster: this.roster() };

      case "/catalog":
        return {
          capabilityNotice: this.config.capabilityNotice,
          providers: this.config.providers,
          harnesses: this.config.harnesses,
          models: this.config.models,
          roles: this.config.roles,
          agents: this.config.agents,
          constraints: this.config.constraints,
        };

      case "/route/preview": {
        const request = body as unknown as RoutingTask;
        return { decision: this.routing({
          role: String(request.role ?? "implementation"),
          complexity: Math.max(1, Math.min(5, Number(request.complexity ?? 3) || 3)),
          contextTokens: Math.max(0, Number(request.contextTokens ?? 8_000) || 0),
          writeAccess: Boolean(request.writeAccess),
          shell: Boolean(request.shell),
          network: Boolean(request.network),
          exactAgent: request.exactAgent ? String(request.exactAgent) : undefined,
          exactModel: request.exactModel ? String(request.exactModel) : undefined,
          families: request.families ? stringList(request.families) : undefined,
          providers: request.providers ? stringList(request.providers) : undefined,
          excludedFamilies: request.excludedFamilies ? stringList(request.excludedFamilies) : undefined,
          preferSubscription: request.preferSubscription,
          implementationFamily: request.implementationFamily,
          taskKind: request.taskKind,
        }) };
      }

      case "/send": {
        const identity = this.caller(body);
        this.touch(identity.id);
        const recipients = this.resolveRecipients(identity.id, String(body.to ?? ""));
        if (!recipients.length) throw new Error("no recipients resolved");
        const unknown = recipients.filter((id) => !this.agents.has(id));
        const delivered: { id: string; to: string }[] = [];
        for (const to of recipients) {
          if (!this.agents.has(to)) continue;
          const message = this.deliver(this.makeMessage({
            from: identity.id,
            to,
            type: (body.type ?? "info") as MessageType,
            subject: boundedString(body.subject, "subject", 1000),
            body: boundedString(body.body, "body", 200_000),
            taskId: body.taskId ? String(body.taskId) : null,
            refs: contextReferences(body.refs),
          }));
          delivered.push({ id: message.id, to });
        }
        return { delivered, unknownRecipients: unknown };
      }

      case "/wait": {
        const identity = this.caller(body);
        this.touch(identity.id, "waiting");
        const pending = this.store.pendingMessages(identity.id);
        if (pending.length) {
          this.store.markMessagesDelivered(pending.map((message) => message.id));
          return { messages: pending, timedOut: false };
        }
        const timeoutMs = Math.min(Math.max(1, Number(body.timeoutMs ?? MAX_WAIT_MS) || MAX_WAIT_MS), MAX_WAIT_MS);
        return await new Promise((resolve) => {
          const waiter: Waiter = {
            agentId: identity.id,
            resolve,
            timer: setTimeout(() => {
              this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
              resolve({ messages: [], timedOut: true });
            }, timeoutMs),
          };
          this.waiters.push(waiter);
        });
      }

      case "/peek": {
        const identity = this.caller(body);
        this.touch(identity.id);
        const pending = this.store.pendingMessages(identity.id);
        if (body.drain !== false) this.store.markMessagesDelivered(pending.map((message) => message.id));
        return { messages: pending, timedOut: false };
      }

      case "/run/create": {
        const identity = this.requireOperator(body);
        const projectRoot = resolve(boundedString(body.projectRoot, "projectRoot", 8192, true));
        if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) throw new Error(`project root is not a directory: ${projectRoot}`);
        const now = Date.now();
        const run: Run = {
          id: newId("run"),
          goal: boundedString(body.goal, "goal", 100_000, true),
          projectRoot,
          status: "active",
          rootTaskId: null,
          createdBy: identity.id,
          constraints: body.constraints && typeof body.constraints === "object" ? body.constraints as Record<string, unknown> : {},
          createdAt: now,
          updatedAt: now,
        };
        this.runs.set(run.id, run);
        this.store.saveRun(run);
        const root = this.createTask(identity, {
          runId: run.id,
          title: `Manage objective: ${run.goal.slice(0, 120)}`,
          brief: [
            `Own this objective end to end: ${run.goal}`,
            "Inspect the project, create a dependency-aware task graph, delegate scoped work, review every result, request revisions when needed, run final validation, and submit only when the objective is genuinely complete.",
            "Use concise briefs and path/artifact references. Sleep while workers execute rather than watching their transcripts.",
          ].join("\n\n"),
          role: String(body.role ?? "manager"),
          complexity: 5,
          readOnly: true,
          shell: true,
          network: Boolean(body.network ?? true),
          estimatedContextTokens: Number(body.estimatedContextTokens ?? 24_000),
          contextRefs: [{ type: "path", value: projectRoot, description: "selected project root" }],
          reviewRequired: false,
          maxRetries: this.config.constraints.maxRetries,
        });
        run.rootTaskId = root.id;
        run.updatedAt = Date.now();
        this.store.saveRun(run);
        this.audit("run_create", { runId: run.id, projectRoot, rootTaskId: root.id, routing: root.routing?.reason });
        return { run, rootTask: this.taskView(root) };
      }

      case "/run/list":
        return { runs: [...this.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt) };

      case "/run/get": {
        const run = this.runs.get(String(body.runId ?? ""));
        if (!run) throw new Error(`unknown run: ${body.runId}`);
        return { run, tasks: [...this.tasks.values()].filter((task) => task.runId === run.id).sort((a, b) => a.createdAt - b.createdAt) };
      }

      case "/run/cancel": {
        this.requireOperator(body);
        const runId = String(body.runId ?? "");
        const run = this.runs.get(runId);
        if (!run) throw new Error(`unknown run: ${runId}`);
        const reason = boundedString(body.reason, "reason", 20_000) || "Run cancelled by operator.";
        for (const task of [...this.tasks.values()].filter((candidate) => candidate.runId === runId && !TERMINAL_STATES.includes(candidate.state))) {
          await this.handle("/task/cancel", { ...body, taskId: task.id, reason });
        }
        run.status = "cancelled";
        run.updatedAt = Date.now();
        this.store.saveRun(run);
        this.audit("run_cancel", { runId, reason });
        return { run, tasks: [...this.tasks.values()].filter((task) => task.runId === runId).map((task) => this.taskView(task)) };
      }

      case "/task/create": {
        const identity = this.caller(body);
        const task = this.createTask(identity, body);
        return { task: this.taskView(task) };
      }

      case "/task/start": {
        const identity = this.caller(body);
        const task = this.tasks.get(String(body.taskId ?? ""));
        if (!task) throw new Error(`unknown task: ${body.taskId}`);
        if (identity.id !== task.assignee) throw new PermissionError(`only ${task.assignee} may start ${task.id}`);
        task.state = "in_progress";
        this.addEvent(task, identity.id, "started", "in_progress", "worker began execution");
        this.store.saveTask(task);
        this.touch(identity.id, "working");
        return { task: this.taskView(task) };
      }

      case "/task/submit": {
        const identity = this.caller(body);
        const task = this.tasks.get(String(body.taskId ?? ""));
        if (!task) throw new Error(`unknown task: ${body.taskId}`);
        if (identity.id !== task.assignee && identity.id !== OPERATOR_ID) throw new PermissionError(`only ${task.assignee} may submit ${task.id}`);
        if (TERMINAL_STATES.includes(task.state)) throw new ConflictError(`task ${task.id} is already ${task.state}`);
        task.result = resultPayload(body);
        task.state = "submitted";
        task.usage = {
          ...task.usage,
          totalTokens: Number(body.totalTokens ?? task.usage.totalTokens) || task.usage.totalTokens,
          inputTokens: Number(body.inputTokens ?? task.usage.inputTokens) || task.usage.inputTokens,
          outputTokens: Number(body.outputTokens ?? task.usage.outputTokens) || task.usage.outputTokens,
          costUSD: Number(body.costUSD ?? task.usage.costUSD) || task.usage.costUSD,
          latencyMs: Date.now() - (task.history.find((event) => event.kind === "assigned")?.ts ?? task.createdAt),
          turns: Math.max(1, task.usage.turns + 1),
        };
        this.addEvent(task, identity.id, "submitted", "submitted", task.result.summary, { changedFiles: task.result.changedFiles, validation: task.result.validation });
        this.touch(identity.id, "idle");
        this.store.saveTask(task);
        if (task.reviewRequired) {
          this.sendForReview(task);
        } else {
          task.reviewerId = task.assigner;
          this.store.saveTask(task);
          this.deliver(this.makeMessage({
            from: identity.id,
            to: task.assigner,
            type: "result",
            subject: `[DONE ${task.id} r${task.round}] ${task.title}`,
            body: `${task.result.summary}\n\nReview with bus_review_work(task_id="${task.id}").`,
            taskId: task.id,
            refs: task.result.artifacts,
          }));
        }
        this.audit("task_submit", { taskId: task.id, actor: identity.id, reviewRequired: task.reviewRequired, reviewer: task.reviewerId });
        return { task: this.taskView(task) };
      }

      case "/task/review": {
        const identity = this.caller(body);
        const task = this.tasks.get(String(body.taskId ?? ""));
        if (!task) throw new Error(`unknown task: ${body.taskId}`);
        const allowed = identity.id === OPERATOR_ID || identity.id === task.assigner || identity.id === task.reviewerId;
        if (!allowed || (!identity.permissions.canReview && identity.id !== OPERATOR_ID)) {
          throw new PermissionError(`only ${task.assigner}, ${task.reviewerId ?? "the designated reviewer"}, or the operator may review ${task.id}`);
        }
        if (task.state !== "submitted") throw new ConflictError(`task ${task.id} is ${task.state}, not submitted`);
        const accepted = Boolean(body.accepted);
        const feedback = boundedString(body.feedback, "feedback", 50_000, true);
        const reviewerFamily = this.agents.get(identity.id)?.family ?? null;
        task.review = { reviewer: identity.id, reviewerFamily, accepted, feedback, reviewedAt: Date.now() };
        if (accepted) {
          task.state = "accepted";
          this.addEvent(task, identity.id, "reviewed", "accepted", feedback);
          this.store.releasePathLeases(task.id);
          const worker = this.agents.get(task.assignee);
          if (worker?.currentTaskId === task.id) {
            worker.currentTaskId = null;
            this.store.saveAgent(worker);
          }
          this.store.recordTaskOutcome(task, "accepted");
          this.deliver(this.makeMessage({
            from: identity.id,
            to: task.assignee,
            type: "feedback",
            subject: `[ACCEPTED ${task.id}] ${task.title}`,
            body: `${feedback}\n\nNo further action is required on this task.`,
            taskId: task.id,
          }));
          if (identity.id !== task.assigner && task.assigner !== task.assignee) {
            this.deliver(this.makeMessage({
              from: identity.id,
              to: task.assigner,
              type: "result",
              subject: `[REVIEW PASSED ${task.id}] ${task.title}`,
              body: feedback,
              taskId: task.id,
            }));
          }
          this.store.saveTask(task);
          this.refreshBlocked(task.runId);
          this.completeRunIfReady(task);
        } else {
          this.store.recordTaskOutcome(task, "rejected");
          task.round += 1;
          task.reviewerId = null;
          if (task.round - 1 > task.maxRetries) {
            task.state = "failed";
            this.addEvent(task, identity.id, "failed", "failed", `review retry limit exceeded: ${feedback}`);
            this.store.releasePathLeases(task.id);
            this.store.recordTaskOutcome(task, "failed");
            this.deliver(this.makeMessage({
              from: identity.id,
              to: task.assigner,
              type: "control",
              subject: `[ESCALATE ${task.id}] review retry limit exceeded`,
              body: feedback,
              taskId: task.id,
            }));
            this.refreshBlocked(task.runId);
          } else {
            task.state = "changes_requested";
            this.addEvent(task, identity.id, "reviewed", "changes_requested", feedback);
            this.deliver(this.makeMessage({
              from: identity.id,
              to: task.assignee,
              type: "feedback",
              subject: `[CHANGES ${task.id} r${task.round}] ${task.title}`,
              body: `${feedback}\n\nRevise the existing work and submit the same task_id again.`,
              taskId: task.id,
            }));
          }
          this.store.saveTask(task);
        }
        this.audit("task_review", { taskId: task.id, actor: identity.id, accepted, round: task.round });
        return { task: this.taskView(task) };
      }

      case "/task/failure": {
        const identity = this.caller(body);
        const task = this.tasks.get(String(body.taskId ?? ""));
        if (!task) throw new Error(`unknown task: ${body.taskId}`);
        if (identity.id !== task.assignee) throw new PermissionError(`only ${task.assignee} may report failure for ${task.id}`);
        task.attempts += 1;
        const note = boundedString(body.error ?? body.summary, "failure", 20_000, true);
        this.addEvent(task, identity.id, "failed", task.state, note, { exitCode: body.exitCode, malformed: body.malformed });
        if (task.attempts <= task.maxRetries) {
          task.state = "assigned";
          this.addEvent(task, "broker", "retry", "assigned", `retry ${task.attempts}/${task.maxRetries} on original worker`);
          this.store.saveTask(task);
          this.deliver(this.makeMessage({
            from: "broker",
            to: task.assignee,
            type: "control",
            subject: `[RETRY ${task.id}] attempt ${task.attempts + 1}`,
            body: `${note}\n\nRetry the original scoped task. Do not broaden scope.`,
            taskId: task.id,
            refs: task.contextRefs,
          }));
        } else {
          const previousAssignee = task.assignee;
          const previousFamily = this.agents.get(previousAssignee)?.family;
          const reroute = this.routing({
            role: task.role,
            complexity: Math.min(5, task.complexity + 1),
            contextTokens: task.estimatedContextTokens,
            writeAccess: !task.readOnly,
            shell: true,
            network: task.role === "research",
            excludedFamilies: previousFamily ? [previousFamily] : undefined,
          });
          if (reroute.selectedAgentId && reroute.selectedAgentId !== previousAssignee) {
            task.assignee = reroute.selectedAgentId;
            task.routing = reroute;
            task.implementationFamily = reroute.selectedFamily;
            task.state = "assigned";
            this.addEvent(task, "router", "rerouted", "assigned", `${previousAssignee} → ${task.assignee}: ${reroute.reason}`);
            this.store.saveRoutingDecision(task.id, task.runId, reroute);
            this.store.saveTask(task);
            this.deliver(this.makeMessage({
              from: task.assigner,
              to: task.assignee,
              type: "task",
              subject: `[REROUTED ${task.id}] ${task.title}`,
              body: `${this.assignmentBody(task)}\n\nPrevious worker failure:\n${note}`,
              taskId: task.id,
              refs: task.contextRefs,
            }));
          } else {
            task.state = "failed";
            this.addEvent(task, "router", "failed", "failed", `no eligible fallback: ${reroute.reason}`);
            this.store.releasePathLeases(task.id);
            this.store.recordTaskOutcome(task, "failed");
            this.store.saveTask(task);
            this.deliver(this.makeMessage({
              from: "broker",
              to: task.assigner,
              type: "control",
              subject: `[ESCALATE ${task.id}] worker and fallback exhausted`,
              body: `${note}\n\nRouting result: ${reroute.reason}`,
              taskId: task.id,
            }));
            this.refreshBlocked(task.runId);
          }
        }
        this.audit("task_failure", { taskId: task.id, actor: identity.id, attempts: task.attempts, assignee: task.assignee, state: task.state });
        return { task: this.taskView(task) };
      }

      case "/task/list": {
        const filterAgent = body.agent ? String(body.agent) : null;
        const runId = body.runId ? String(body.runId) : null;
        const openOnly = body.openOnly !== false;
        const tasks = [...this.tasks.values()]
          .filter((task) => !filterAgent || task.assignee === filterAgent || task.assigner === filterAgent || task.reviewerId === filterAgent)
          .filter((task) => !runId || task.runId === runId)
          .filter((task) => !openOnly || !TERMINAL_STATES.includes(task.state))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((task) => this.taskView(task));
        return { tasks };
      }

      case "/task/detail":
      case "/task/get": {
        const task = this.tasks.get(String(body.taskId ?? ""));
        if (!task) throw new Error(`unknown task: ${body.taskId}`);
        return { task, routingHistory: this.store.routingDecisions(task.id) };
      }

      case "/task/cancel": {
        const identity = this.caller(body);
        const task = this.tasks.get(String(body.taskId ?? ""));
        if (!task) throw new Error(`unknown task: ${body.taskId}`);
        if (identity.id !== OPERATOR_ID && identity.id !== task.assigner) throw new PermissionError(`only ${task.assigner} or operator may cancel ${task.id}`);
        if (TERMINAL_STATES.includes(task.state)) return { task: this.taskView(task) };
        task.state = "cancelled";
        this.addEvent(task, identity.id, "cancelled", "cancelled", boundedString(body.reason, "reason", 20_000) || "cancelled");
        this.store.releasePathLeases(task.id);
        const worker = this.agents.get(task.assignee);
        if (worker?.currentTaskId === task.id) {
          worker.currentTaskId = null;
          this.store.saveAgent(worker);
        }
        this.store.saveTask(task);
        if (task.assignee) {
          this.deliver(this.makeMessage({
            from: identity.id,
            to: task.assignee,
            type: "control",
            subject: `[CANCELLED ${task.id}] ${task.title}`,
            body: `${body.reason ?? "Cancelled by operator."}\n\nStop work and do not submit further changes.`,
            taskId: task.id,
          }));
        }
        this.refreshBlocked(task.runId);
        this.audit("task_cancel", { taskId: task.id, actor: identity.id });
        return { task: this.taskView(task) };
      }

      case "/kill": {
        this.requireOperator(body);
        const target = String(body.agentId ?? "");
        const meta = this.supervisorMeta.get(target);
        if (!meta) throw new Error(`no verified supervisor recorded for ${target}`);
        const verified = verifiedSupervisorProcess({
          busHome: BUS_HOME,
          port: this.instancePort,
          applicationRoot: APPLICATION_ROOT,
          agentId: target,
          pid: meta.pid,
        });
        if (!verified) {
          this.supervisorMeta.delete(target);
          const staleAgent = this.agents.get(target);
          if (staleAgent) {
            staleAgent.status = "offline";
            this.store.saveAgent(staleAgent);
          }
          this.audit("supervisor_stale", { target, pid: meta.pid });
          throw new ConflictError(`supervisor ownership cannot be verified for ${target}`);
        }
        let killed = false;
        if (meta.childPid && processParentPid(meta.childPid) === meta.pid) {
          try { process.kill(-meta.childPid, "SIGTERM"); } catch { try { process.kill(meta.childPid, "SIGTERM"); } catch {} }
        }
        try { process.kill(-meta.pid, "SIGTERM"); killed = true; }
        catch { try { process.kill(meta.pid, "SIGTERM"); killed = true; } catch {} }
        this.supervisorMeta.delete(target);
        const agent = this.agents.get(target);
        if (agent) { agent.status = "offline"; this.store.saveAgent(agent); }
        this.audit("kill", { target, pid: meta.pid, killed, verified: true });
        return { ok: killed, pid: meta.pid };
      }

      case "/snapshot": {
        const since = Math.max(0, Number(body.sinceSeq ?? 0) || 0);
        return {
          roster: this.roster(),
          tasks: [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt),
          runs: [...this.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt),
          messages: this.store.historySince(since),
          seq: this.store.latestSequence(),
          waiting: this.waiters.map((waiter) => waiter.agentId),
          brokerPid: process.pid,
          pathLeases: this.store.pathLeases(),
          revision: this.stateRevision,
          configIdentity: this.configIdentity(),
        };
      }

      case "/state/wait": {
        this.requireOperator(body);
        const sinceRevision = Math.max(0, Number(body.sinceRevision ?? 0) || 0);
        const timeoutMs = Math.max(1, Math.min(MAX_WAIT_MS, Number(body.timeoutMs ?? MAX_WAIT_MS) || MAX_WAIT_MS));
        if (this.stateRevision > sinceRevision) return { revision: this.stateRevision, changed: true };
        return await new Promise<{ revision: number; changed: boolean }>((resolveWait) => {
          const waiter: StateWaiter = {
            sinceRevision,
            resolve: resolveWait,
            timer: setTimeout(() => {
              this.stateWaiters = this.stateWaiters.filter((candidate) => candidate !== waiter);
              resolveWait({ revision: this.stateRevision, changed: false });
            }, timeoutMs),
          };
          this.stateWaiters.push(waiter);
        });
      }

      case "/state":
        return {
          roster: this.roster(),
          tasks: [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt),
          runs: [...this.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt),
          waiting: this.waiters.map((waiter) => waiter.agentId),
          telemetry: this.store.telemetry(),
          pathLeases: this.store.pathLeases(),
          revision: this.stateRevision,
          configIdentity: this.configIdentity(),
        };

      default:
        throw new Error(`no route ${path}`);
    }
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("request body exceeds 2 MiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveBody({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`invalid JSON body: ${(error as Error).message}`));
      }
    });
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export async function startBroker(options: BrokerOptions = {}): Promise<BrokerHandle> {
  const service = new BrokerService(options);
  const host = options.host ?? BUS_HOST;
  const requestedPort = options.port ?? BUS_PORT;
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      return send(res, 200, {
        ok: true,
        pid: process.pid,
        agents: service.agents.size,
        tasks: service.tasks.size,
        runs: service.runs.size,
        durable: true,
      });
    }
    try {
      const body = await readBody(req);
      send(res, 200, await service.handle(path, body));
    } catch (error) {
      const status = error instanceof AuthError ? 401 : error instanceof PermissionError ? 403 : error instanceof ConflictError ? 409 : String((error as Error).message).startsWith("no route") ? 404 : 400;
      send(res, status, { error: (error as Error).message });
    }
  });
  server.headersTimeout = MAX_WAIT_MS + 60_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = MAX_WAIT_MS + 60_000;

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const url = `http://${host}:${port}`;
  process.stderr.write(`agent-bus broker listening on ${url} (SQLite: ${service.store.path})\n`);
  return {
    service,
    server,
    host,
    port,
    url,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => {
        service.close();
        if (error) reject(error); else resolveClose();
      });
    }),
  };
}
