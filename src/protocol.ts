import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentPermissions, Authority, ResolvedAgent } from "./config.js";
import type { CandidateScore, RoutingDecision } from "./router.js";

export function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function defaultProductHome(): string {
  const next = join(homedir(), ".qagent");
  const previous = join(homedir(), ".agent-bus");
  if (existsSync(next) || !existsSync(previous)) return next;
  return previous;
}

export const BUS_HOME = envValue("QAGENT_HOME", "AGENT_BUS_HOME") ?? defaultProductHome();
export const BUS_PORT = Number(envValue("QAGENT_PORT", "AGENT_BUS_PORT") ?? 11511);
export const BUS_HOST = envValue("QAGENT_HOST", "AGENT_BUS_HOST") ?? "127.0.0.1";
export const BUS_URL = envValue("QAGENT_URL", "AGENT_BUS_URL") ?? `http://${BUS_HOST}:${BUS_PORT}`;

export function productEnvBindings(options: {
  home?: string;
  host?: string;
  port?: number | string;
  url?: string;
  config?: string;
  applicationRoot?: string;
  launcherPath?: string | null;
  installRoot?: string | null;
} = {}): Record<string, string> {
  const home = options.home ?? BUS_HOME;
  const host = options.host ?? BUS_HOST;
  const port = String(options.port ?? BUS_PORT);
  const url = options.url ?? BUS_URL;
  const env: Record<string, string> = {
    QAGENT_HOME: home,
    AGENT_BUS_HOME: home,
    QAGENT_HOST: host,
    AGENT_BUS_HOST: host,
    QAGENT_PORT: port,
    AGENT_BUS_PORT: port,
    QAGENT_URL: url,
    AGENT_BUS_URL: url,
  };
  if (options.config) {
    env.QAGENT_CONFIG = options.config;
    env.AGENT_BUS_CONFIG = options.config;
  }
  if (options.applicationRoot) {
    env.QAGENT_APPLICATION_ROOT = options.applicationRoot;
    env.AGENT_BUS_APPLICATION_ROOT = options.applicationRoot;
  }
  if (options.launcherPath) {
    env.QAGENT_LAUNCHER_PATH = options.launcherPath;
    env.AGENT_BUS_LAUNCHER_PATH = options.launcherPath;
  }
  if (options.installRoot) {
    env.QAGENT_INSTALL_ROOT = options.installRoot;
    env.AGENT_BUS_INSTALL_ROOT = options.installRoot;
  }
  return env;
}
export const MAX_WAIT_MS = 240_000;
export const DEFAULT_WAIT_MS = 180_000;
export const DEFAULT_BLOCK_MS = Number(envValue("QAGENT_BLOCK_SEC", "AGENT_BUS_BLOCK_SEC") ?? 900) * 1000;
export const MAX_BLOCK_MS = 3_600_000;
export const STALE_AGENT_MS = 15 * 60_000;

export type MessageType = "task" | "result" | "feedback" | "question" | "answer" | "info" | "control";
export type AgentStatus = "idle" | "working" | "waiting" | "offline" | "failed";
export type TaskState =
  | "blocked"
  | "ready"
  | "assigned"
  | "in_progress"
  | "submitted"
  | "changes_requested"
  | "accepted"
  | "failed"
  | "cancelled";
export type ContextReferenceType = "path" | "artifact" | "summary" | "commit" | "url";

export interface ContextReference {
  type: ContextReferenceType;
  value: string;
  description?: string;
  digest?: string;
}

export interface Agent {
  id: string;
  role: string;
  model: string;
  family: string;
  provider: string;
  harness: string;
  description: string;
  auth: string;
  authority: Authority;
  permissions: AgentPermissions;
  status: AgentStatus;
  currentTaskId: string | null;
  registeredAt: number;
  lastSeen: number;
}

export interface Message {
  id: string;
  seq: number;
  ts: number;
  from: string;
  to: string;
  type: MessageType;
  subject: string;
  body: string;
  taskId: string | null;
  refs: ContextReference[];
}

export interface ValidationRequirement {
  id: string;
  description: string;
  command?: string;
  required: boolean;
}

export interface ValidationObservation {
  requirementId?: string;
  command?: string;
  passed: boolean;
  summary: string;
  artifact?: string;
}

export interface TaskResult {
  summary: string;
  details: string;
  changedFiles: string[];
  artifacts: ContextReference[];
  validation: ValidationObservation[];
  completedAt: number;
}

export interface TaskReview {
  reviewer: string;
  reviewerFamily: string | null;
  accepted: boolean;
  feedback: string;
  reviewedAt: number;
}

export interface UsageMetrics {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  latencyMs: number;
}

export interface TaskEvent {
  ts: number;
  actor: string;
  kind:
    | "created"
    | "blocked"
    | "assigned"
    | "started"
    | "submitted"
    | "reviewed"
    | "retry"
    | "rerouted"
    | "failed"
    | "cancelled"
    | "dependency_released";
  state: TaskState;
  note: string;
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  runId: string | null;
  parentTaskId: string | null;
  childTaskIds: string[];
  dependencyIds: string[];
  title: string;
  brief: string;
  /** Compatibility summary. Detailed context should use refs. */
  context: string;
  contextRefs: ContextReference[];
  assigner: string;
  assignee: string;
  role: string;
  complexity: number;
  estimatedContextTokens: number;
  readOnly: boolean;
  pathScopes: string[];
  validationRequirements: ValidationRequirement[];
  state: TaskState;
  round: number;
  attempts: number;
  maxRetries: number;
  depth: number;
  reviewRequired: boolean;
  implementationFamily: string | null;
  reviewerId: string | null;
  routing: RoutingDecision | null;
  reviewRouting: RoutingDecision | null;
  result: TaskResult | null;
  review: TaskReview | null;
  usage: UsageMetrics;
  createdAt: number;
  updatedAt: number;
  history: TaskEvent[];
}

export interface Run {
  id: string;
  goal: string;
  projectRoot: string;
  status: "active" | "completed" | "failed" | "cancelled";
  rootTaskId: string | null;
  createdBy: string;
  constraints: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ModelTelemetry {
  agentId: string;
  taskCount: number;
  acceptedCount: number;
  failedCount: number;
  reviewRejectedCount: number;
  averageLatencyMs: number;
  averageTokens: number;
  updatedAt: number;
}

export interface PathLease {
  taskId: string;
  runId: string;
  path: string;
  createdAt: number;
}

export interface ConfigIdentity {
  path: string | null;
  digest: string;
}

/** Wire view of one agent on /state, /roster, /agents, and /snapshot. */
export interface RosterEntry {
  id: string;
  role: string;
  model: string;
  family: string;
  provider: string;
  description: string;
  harness: string;
  auth: string;
  authority: Authority;
  permissions: AgentPermissions;
  status: AgentStatus;
  currentTaskId: string | null;
  pendingMessages: number;
  lastSeenSecondsAgo: number;
  blocked: boolean;
  stalled: boolean;
  supervisorPid: number | null;
  workdir: string | null;
  cli: string | null;
  usage: UsageMetrics;
}

/** POST /state — the CLI status/watch/usage body. */
export interface BusState {
  roster: RosterEntry[];
  tasks: Task[];
  runs: Run[];
  waiting: string[];
  telemetry: ModelTelemetry[];
  pathLeases: PathLease[];
  revision: number;
  configIdentity: ConfigIdentity;
}

/** POST /snapshot and GET /api/state — dashboard live view. */
export interface BusSnapshot extends BusState {
  messages: Message[];
  seq: number;
  brokerPid: number;
}

export interface RosterResponse {
  roster: RosterEntry[];
}

export interface RoutePreviewResponse {
  decision: RoutingDecision;
}

export interface SendResponse {
  delivered: { id: string; to: string }[];
  unknownRecipients: string[];
}

export interface ProvisionResponse {
  id?: string;
  provisioned?: boolean;
  rotated?: boolean;
  token: string | null;
  message?: string;
}

export interface RunCreateResponse {
  run: Run;
  rootTask: Task;
}

export interface RunGetResponse {
  run: Run;
  tasks?: Task[];
}

export interface WaitResponse {
  messages: Message[];
  timedOut: boolean;
}

export interface PeekResponse {
  messages: Message[];
  timedOut?: boolean;
}

export interface TaskEnvelope {
  task: Task;
}

export interface TaskListResponse {
  tasks: Task[];
}

export interface TaskGetResponse {
  task: Task;
  routingHistory: RoutingDecision[];
}

export interface RegisterResponse {
  agent: Agent;
  pendingMessages: number;
  roster: RosterEntry[];
}

export interface StatusResponse {
  ok: boolean;
  status: AgentStatus;
}

export interface PresenceResponse {
  ok: boolean;
  supervisorVerified: boolean;
}

export interface OkResponse {
  ok: boolean;
}

export interface ExecutionConfigResponse {
  agent: ResolvedAgent;
  configIdentity: ConfigIdentity;
}

export interface StateWaitResponse {
  revision: number;
  changed?: boolean;
}

export class ProtocolError extends Error {
  constructor(readonly field: string, endpoint?: string) {
    super(endpoint
      ? `malformed broker ${endpoint} response: missing field ${field}`
      : `malformed broker response: missing field ${field}`);
    this.name = "ProtocolError";
  }
}

const AGENT_STATUSES = ["idle", "working", "waiting", "offline", "failed"] as const;
const TASK_STATES = ["blocked", "ready", "assigned", "in_progress", "submitted", "changes_requested", "accepted", "failed", "cancelled"] as const;
const RUN_STATUSES = ["active", "completed", "failed", "cancelled"] as const;
const AUTHORITIES = ["operator", "manager", "worker"] as const;
const MESSAGE_TYPES = ["task", "result", "feedback", "question", "answer", "info", "control"] as const;
const CONTEXT_TYPES = ["path", "artifact", "summary", "commit", "url"] as const;
const TASK_EVENT_KINDS = ["created", "blocked", "assigned", "started", "submitted", "reviewed", "retry", "rerouted", "failed", "cancelled", "dependency_released"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(field: string): never {
  throw new ProtocolError(field);
}

function rec(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(field);
  return value;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field);
  return value;
}

function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(field);
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field);
  return value;
}

function nul<T>(value: unknown, field: string, inner: (value: unknown, field: string) => T): T | null {
  if (value === null) return null;
  return inner(value, field);
}

function arr<T>(value: unknown, field: string, item: (value: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) fail(field);
  return value.map((entry, index) => item(entry, `${field}[${index}]`));
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(field);
  return value as T;
}

export function emptyUsage(): UsageMetrics {
  return { turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, latencyMs: 0 };
}

/** Coerce persisted or legacy usage blobs onto the wire UsageMetrics shape. Producer-side only. */
export function normalizeUsageMetrics(value: unknown): UsageMetrics {
  const row = isRecord(value) ? value : {};
  return {
    turns: Number(row.turns ?? 0) || 0,
    inputTokens: Number(row.inputTokens ?? 0) || 0,
    outputTokens: Number(row.outputTokens ?? 0) || 0,
    totalTokens: Number(row.totalTokens ?? row.tokens ?? 0) || 0,
    costUSD: Number(row.costUSD ?? 0) || 0,
    latencyMs: Number(row.latencyMs ?? 0) || 0,
  };
}

export function parseUsageMetrics(value: unknown, field = "usage"): UsageMetrics {
  const row = rec(value, field);
  return {
    turns: num(row.turns, `${field}.turns`),
    inputTokens: num(row.inputTokens, `${field}.inputTokens`),
    outputTokens: num(row.outputTokens, `${field}.outputTokens`),
    totalTokens: num(row.totalTokens, `${field}.totalTokens`),
    costUSD: num(row.costUSD, `${field}.costUSD`),
    latencyMs: num(row.latencyMs, `${field}.latencyMs`),
  };
}

function parsePermissions(value: unknown, field: string): AgentPermissions {
  const row = rec(value, field);
  const filesystem = str(row.filesystem, `${field}.filesystem`);
  if (filesystem !== "none" && filesystem !== "read" && filesystem !== "write") fail(`${field}.filesystem`);
  return {
    canDelegate: bool(row.canDelegate, `${field}.canDelegate`),
    canReview: bool(row.canReview, `${field}.canReview`),
    filesystem,
    shell: bool(row.shell, `${field}.shell`),
    network: bool(row.network, `${field}.network`),
    maxDelegationDepth: num(row.maxDelegationDepth, `${field}.maxDelegationDepth`),
    allowedPaths: row.allowedPaths === undefined ? undefined : arr(row.allowedPaths, `${field}.allowedPaths`, str),
    allowedChildAgentIds: row.allowedChildAgentIds === undefined ? undefined : arr(row.allowedChildAgentIds, `${field}.allowedChildAgentIds`, str),
  };
}

export function parseRosterEntry(value: unknown, field = "roster[]"): RosterEntry {
  const row = rec(value, field);
  return {
    id: str(row.id, `${field}.id`),
    role: str(row.role, `${field}.role`),
    model: str(row.model, `${field}.model`),
    family: str(row.family, `${field}.family`),
    provider: str(row.provider, `${field}.provider`),
    description: str(row.description, `${field}.description`),
    harness: str(row.harness, `${field}.harness`),
    auth: str(row.auth, `${field}.auth`),
    authority: oneOf(row.authority, `${field}.authority`, AUTHORITIES),
    permissions: parsePermissions(row.permissions, `${field}.permissions`),
    status: oneOf(row.status, `${field}.status`, AGENT_STATUSES),
    currentTaskId: nul(row.currentTaskId, `${field}.currentTaskId`, str),
    pendingMessages: num(row.pendingMessages, `${field}.pendingMessages`),
    lastSeenSecondsAgo: num(row.lastSeenSecondsAgo, `${field}.lastSeenSecondsAgo`),
    blocked: bool(row.blocked, `${field}.blocked`),
    stalled: bool(row.stalled, `${field}.stalled`),
    supervisorPid: nul(row.supervisorPid, `${field}.supervisorPid`, num),
    workdir: nul(row.workdir, `${field}.workdir`, str),
    cli: nul(row.cli, `${field}.cli`, str),
    usage: parseUsageMetrics(row.usage, `${field}.usage`),
  };
}

function parseContextReference(value: unknown, field: string): ContextReference {
  const row = rec(value, field);
  return {
    type: oneOf(row.type, `${field}.type`, CONTEXT_TYPES),
    value: str(row.value, `${field}.value`),
    description: row.description === undefined ? undefined : str(row.description, `${field}.description`),
    digest: row.digest === undefined ? undefined : str(row.digest, `${field}.digest`),
  };
}

function parseMessage(value: unknown, field: string): Message {
  const row = rec(value, field);
  return {
    id: str(row.id, `${field}.id`),
    seq: num(row.seq, `${field}.seq`),
    ts: num(row.ts, `${field}.ts`),
    from: str(row.from, `${field}.from`),
    to: str(row.to, `${field}.to`),
    type: oneOf(row.type, `${field}.type`, MESSAGE_TYPES),
    subject: str(row.subject, `${field}.subject`),
    body: str(row.body, `${field}.body`),
    taskId: nul(row.taskId, `${field}.taskId`, str),
    refs: arr(row.refs, `${field}.refs`, parseContextReference),
  };
}

function parseRun(value: unknown, field: string): Run {
  const row = rec(value, field);
  return {
    id: str(row.id, `${field}.id`),
    goal: str(row.goal, `${field}.goal`),
    projectRoot: str(row.projectRoot, `${field}.projectRoot`),
    status: oneOf(row.status, `${field}.status`, RUN_STATUSES),
    rootTaskId: nul(row.rootTaskId, `${field}.rootTaskId`, str),
    createdBy: str(row.createdBy, `${field}.createdBy`),
    constraints: rec(row.constraints, `${field}.constraints`),
    createdAt: num(row.createdAt, `${field}.createdAt`),
    updatedAt: num(row.updatedAt, `${field}.updatedAt`),
  };
}

function parseCandidate(value: unknown, field: string): CandidateScore {
  const row = rec(value, field);
  const componentsRow = rec(row.components, `${field}.components`);
  const components: Record<string, number> = {};
  for (const [key, entry] of Object.entries(componentsRow)) {
    components[key] = num(entry, `${field}.components.${key}`);
  }
  return {
    agentId: str(row.agentId, `${field}.agentId`),
    model: str(row.model, `${field}.model`),
    family: str(row.family, `${field}.family`),
    provider: str(row.provider, `${field}.provider`),
    harness: str(row.harness, `${field}.harness`),
    score: num(row.score, `${field}.score`),
    eligible: bool(row.eligible, `${field}.eligible`),
    reasons: arr(row.reasons, `${field}.reasons`, str),
    rejectedBy: arr(row.rejectedBy, `${field}.rejectedBy`, str),
    components,
  };
}

export function parseRoutingDecision(value: unknown, field = "decision"): RoutingDecision {
  const row = rec(value, field);
  return {
    selectedAgentId: nul(row.selectedAgentId, `${field}.selectedAgentId`, str),
    selectedModel: nul(row.selectedModel, `${field}.selectedModel`, str),
    selectedFamily: nul(row.selectedFamily, `${field}.selectedFamily`, str),
    selectedProvider: nul(row.selectedProvider, `${field}.selectedProvider`, str),
    selectedHarness: nul(row.selectedHarness, `${field}.selectedHarness`, str),
    role: str(row.role, `${field}.role`),
    usedFallbackRole: nul(row.usedFallbackRole, `${field}.usedFallbackRole`, str),
    reason: str(row.reason, `${field}.reason`),
    candidates: arr(row.candidates, `${field}.candidates`, parseCandidate),
    createdAt: num(row.createdAt, `${field}.createdAt`),
  };
}

function parseTaskEvent(value: unknown, field: string): TaskEvent {
  const row = rec(value, field);
  return {
    ts: num(row.ts, `${field}.ts`),
    actor: str(row.actor, `${field}.actor`),
    kind: oneOf(row.kind, `${field}.kind`, TASK_EVENT_KINDS),
    state: oneOf(row.state, `${field}.state`, TASK_STATES),
    note: str(row.note, `${field}.note`),
    metadata: row.metadata === undefined ? undefined : rec(row.metadata, `${field}.metadata`),
  };
}

function parseValidationRequirement(value: unknown, field: string): ValidationRequirement {
  const row = rec(value, field);
  return {
    id: str(row.id, `${field}.id`),
    description: str(row.description, `${field}.description`),
    command: row.command === undefined ? undefined : str(row.command, `${field}.command`),
    required: bool(row.required, `${field}.required`),
  };
}

function parseTaskResult(value: unknown, field: string): TaskResult {
  const row = rec(value, field);
  return {
    summary: str(row.summary, `${field}.summary`),
    details: str(row.details, `${field}.details`),
    changedFiles: arr(row.changedFiles, `${field}.changedFiles`, str),
    artifacts: arr(row.artifacts, `${field}.artifacts`, parseContextReference),
    validation: arr(row.validation, `${field}.validation`, (entry, nested) => {
      const item = rec(entry, nested);
      return {
        requirementId: item.requirementId === undefined ? undefined : str(item.requirementId, `${nested}.requirementId`),
        command: item.command === undefined ? undefined : str(item.command, `${nested}.command`),
        passed: bool(item.passed, `${nested}.passed`),
        summary: str(item.summary, `${nested}.summary`),
        artifact: item.artifact === undefined ? undefined : str(item.artifact, `${nested}.artifact`),
      };
    }),
    completedAt: num(row.completedAt, `${field}.completedAt`),
  };
}

function parseTaskReview(value: unknown, field: string): TaskReview {
  const row = rec(value, field);
  return {
    reviewer: str(row.reviewer, `${field}.reviewer`),
    reviewerFamily: nul(row.reviewerFamily, `${field}.reviewerFamily`, str),
    accepted: bool(row.accepted, `${field}.accepted`),
    feedback: str(row.feedback, `${field}.feedback`),
    reviewedAt: num(row.reviewedAt, `${field}.reviewedAt`),
  };
}

export function parseTask(value: unknown, field = "task"): Task {
  const row = rec(value, field);
  return {
    id: str(row.id, `${field}.id`),
    runId: nul(row.runId, `${field}.runId`, str),
    parentTaskId: nul(row.parentTaskId, `${field}.parentTaskId`, str),
    childTaskIds: arr(row.childTaskIds, `${field}.childTaskIds`, str),
    dependencyIds: arr(row.dependencyIds, `${field}.dependencyIds`, str),
    title: str(row.title, `${field}.title`),
    brief: str(row.brief, `${field}.brief`),
    context: str(row.context, `${field}.context`),
    contextRefs: arr(row.contextRefs, `${field}.contextRefs`, parseContextReference),
    assigner: str(row.assigner, `${field}.assigner`),
    assignee: str(row.assignee, `${field}.assignee`),
    role: str(row.role, `${field}.role`),
    complexity: num(row.complexity, `${field}.complexity`),
    estimatedContextTokens: num(row.estimatedContextTokens, `${field}.estimatedContextTokens`),
    readOnly: bool(row.readOnly, `${field}.readOnly`),
    pathScopes: arr(row.pathScopes, `${field}.pathScopes`, str),
    validationRequirements: arr(row.validationRequirements, `${field}.validationRequirements`, parseValidationRequirement),
    state: oneOf(row.state, `${field}.state`, TASK_STATES),
    round: num(row.round, `${field}.round`),
    attempts: num(row.attempts, `${field}.attempts`),
    maxRetries: num(row.maxRetries, `${field}.maxRetries`),
    depth: num(row.depth, `${field}.depth`),
    reviewRequired: bool(row.reviewRequired, `${field}.reviewRequired`),
    implementationFamily: nul(row.implementationFamily, `${field}.implementationFamily`, str),
    reviewerId: nul(row.reviewerId, `${field}.reviewerId`, str),
    routing: nul(row.routing, `${field}.routing`, parseRoutingDecision),
    reviewRouting: nul(row.reviewRouting, `${field}.reviewRouting`, parseRoutingDecision),
    result: nul(row.result, `${field}.result`, parseTaskResult),
    review: nul(row.review, `${field}.review`, parseTaskReview),
    usage: parseUsageMetrics(row.usage, `${field}.usage`),
    createdAt: num(row.createdAt, `${field}.createdAt`),
    updatedAt: num(row.updatedAt, `${field}.updatedAt`),
    history: arr(row.history, `${field}.history`, parseTaskEvent),
  };
}

function parseTelemetry(value: unknown, field: string): ModelTelemetry {
  const row = rec(value, field);
  return {
    agentId: str(row.agentId, `${field}.agentId`),
    taskCount: num(row.taskCount, `${field}.taskCount`),
    acceptedCount: num(row.acceptedCount, `${field}.acceptedCount`),
    failedCount: num(row.failedCount, `${field}.failedCount`),
    reviewRejectedCount: num(row.reviewRejectedCount, `${field}.reviewRejectedCount`),
    averageLatencyMs: num(row.averageLatencyMs, `${field}.averageLatencyMs`),
    averageTokens: num(row.averageTokens, `${field}.averageTokens`),
    updatedAt: num(row.updatedAt, `${field}.updatedAt`),
  };
}

function parsePathLease(value: unknown, field: string): PathLease {
  const row = rec(value, field);
  return {
    taskId: str(row.taskId, `${field}.taskId`),
    runId: str(row.runId, `${field}.runId`),
    path: str(row.path, `${field}.path`),
    createdAt: num(row.createdAt, `${field}.createdAt`),
  };
}

function parseConfigIdentity(value: unknown, field: string): ConfigIdentity {
  const row = rec(value, field);
  return {
    path: nul(row.path, `${field}.path`, str),
    digest: str(row.digest, `${field}.digest`),
  };
}

export function parseBusState(value: unknown): BusState {
  const row = rec(value, "(root)");
  for (const key of ["roster", "tasks", "runs", "waiting", "telemetry", "pathLeases", "revision", "configIdentity"] as const) {
    if (!(key in row)) fail(key);
  }
  return {
    roster: arr(row.roster, "roster", parseRosterEntry),
    tasks: arr(row.tasks, "tasks", parseTask),
    runs: arr(row.runs, "runs", parseRun),
    waiting: arr(row.waiting, "waiting", str),
    telemetry: arr(row.telemetry, "telemetry", parseTelemetry),
    pathLeases: arr(row.pathLeases, "pathLeases", parsePathLease),
    revision: num(row.revision, "revision"),
    configIdentity: parseConfigIdentity(row.configIdentity, "configIdentity"),
  };
}

export function parseBusSnapshot(value: unknown): BusSnapshot {
  const state = parseBusState(value);
  const row = rec(value, "(root)");
  return {
    ...state,
    messages: arr(row.messages, "messages", parseMessage),
    seq: num(row.seq, "seq"),
    brokerPid: num(row.brokerPid, "brokerPid"),
  };
}

export function parseRosterResponse(value: unknown): RosterResponse {
  const row = rec(value, "(root)");
  return { roster: arr(row.roster, "roster", parseRosterEntry) };
}

export function parseRoutePreview(value: unknown): RoutePreviewResponse {
  const row = rec(value, "(root)");
  return { decision: parseRoutingDecision(row.decision, "decision") };
}

export function parseSendResponse(value: unknown): SendResponse {
  const row = rec(value, "(root)");
  return {
    delivered: arr(row.delivered, "delivered", (entry, field) => {
      const item = rec(entry, field);
      return { id: str(item.id, `${field}.id`), to: str(item.to, `${field}.to`) };
    }),
    unknownRecipients: arr(row.unknownRecipients, "unknownRecipients", str),
  };
}

export function parseProvisionResponse(value: unknown): ProvisionResponse {
  const row = rec(value, "(root)");
  return {
    id: row.id === undefined ? undefined : str(row.id, "id"),
    provisioned: row.provisioned === undefined ? undefined : bool(row.provisioned, "provisioned"),
    rotated: row.rotated === undefined ? undefined : bool(row.rotated, "rotated"),
    token: nul(row.token, "token", str),
    message: row.message === undefined ? undefined : str(row.message, "message"),
  };
}

export function parseRunCreateResponse(value: unknown): RunCreateResponse {
  const row = rec(value, "(root)");
  return { run: parseRun(row.run, "run"), rootTask: parseTask(row.rootTask, "rootTask") };
}

export function parseWaitResponse(value: unknown): WaitResponse {
  const row = rec(value, "(root)");
  return {
    messages: arr(row.messages, "messages", parseMessage),
    timedOut: bool(row.timedOut, "timedOut"),
  };
}

export function parsePeekResponse(value: unknown): PeekResponse {
  const row = rec(value, "(root)");
  return {
    messages: arr(row.messages, "messages", parseMessage),
    timedOut: row.timedOut === undefined ? undefined : bool(row.timedOut, "timedOut"),
  };
}

export function parseTaskEnvelope(value: unknown): TaskEnvelope {
  const row = rec(value, "(root)");
  return { task: parseTask(row.task, "task") };
}

export function parseTaskListResponse(value: unknown): TaskListResponse {
  const row = rec(value, "(root)");
  return { tasks: arr(row.tasks, "tasks", parseTask) };
}

export function parseTaskGetResponse(value: unknown): TaskGetResponse {
  const row = rec(value, "(root)");
  return {
    task: parseTask(row.task, "task"),
    routingHistory: arr(row.routingHistory, "routingHistory", parseRoutingDecision),
  };
}

function parseAgent(value: unknown, field: string): Agent {
  const row = rec(value, field);
  return {
    id: str(row.id, `${field}.id`),
    role: str(row.role, `${field}.role`),
    model: str(row.model, `${field}.model`),
    family: str(row.family, `${field}.family`),
    provider: str(row.provider, `${field}.provider`),
    harness: str(row.harness, `${field}.harness`),
    description: str(row.description, `${field}.description`),
    auth: str(row.auth, `${field}.auth`),
    authority: oneOf(row.authority, `${field}.authority`, AUTHORITIES),
    permissions: parsePermissions(row.permissions, `${field}.permissions`),
    status: oneOf(row.status, `${field}.status`, AGENT_STATUSES),
    currentTaskId: nul(row.currentTaskId, `${field}.currentTaskId`, str),
    registeredAt: num(row.registeredAt, `${field}.registeredAt`),
    lastSeen: num(row.lastSeen, `${field}.lastSeen`),
  };
}

export function parseRegisterResponse(value: unknown): RegisterResponse {
  const row = rec(value, "(root)");
  return {
    agent: parseAgent(row.agent, "agent"),
    pendingMessages: num(row.pendingMessages, "pendingMessages"),
    roster: arr(row.roster, "roster", parseRosterEntry),
  };
}

export function parseStatusResponse(value: unknown): StatusResponse {
  const row = rec(value, "(root)");
  return { ok: bool(row.ok, "ok"), status: oneOf(row.status, "status", AGENT_STATUSES) };
}

export function parsePresenceResponse(value: unknown): PresenceResponse {
  const row = rec(value, "(root)");
  return { ok: bool(row.ok, "ok"), supervisorVerified: bool(row.supervisorVerified, "supervisorVerified") };
}

export function parseOkResponse(value: unknown): OkResponse {
  const row = rec(value, "(root)");
  return { ok: bool(row.ok, "ok") };
}

export function parseExecutionConfig(value: unknown): ExecutionConfigResponse {
  const row = rec(value, "(root)");
  const agent = rec(row.agent, "agent");
  str(agent.id, "agent.id");
  bool(agent.enabled, "agent.enabled");
  rec(agent.harnessDefinition, "agent.harnessDefinition");
  str((agent.harnessDefinition as Record<string, unknown>).id, "agent.harnessDefinition.id");
  str((agent.harnessDefinition as Record<string, unknown>).adapter, "agent.harnessDefinition.adapter");
  rec(agent.modelDefinition, "agent.modelDefinition");
  return { agent: agent as unknown as ResolvedAgent, configIdentity: parseConfigIdentity(row.configIdentity, "configIdentity") };
}

export function parseStateWaitResponse(value: unknown): StateWaitResponse {
  const row = rec(value, "(root)");
  return {
    revision: num(row.revision, "revision"),
    changed: row.changed === undefined ? undefined : bool(row.changed, "changed"),
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export async function brokerCall<T>(
  path: string,
  payload: unknown,
  parse: (value: unknown) => T,
  timeoutMs = 20_000,
): Promise<T> {
  const res = await fetch(`${BUS_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`broker ${path} -> ${res.status}: ${text.slice(0, 800)}`);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ProtocolError("JSON", path);
  }
  try {
    return parse(json);
  } catch (error) {
    if (error instanceof ProtocolError) throw new ProtocolError(error.field, path);
    throw error;
  }
}

export async function brokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BUS_URL}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}
