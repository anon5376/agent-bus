import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentPermissions, Authority } from "./config.js";
import type { RoutingDecision } from "./router.js";

export const BUS_HOME = process.env.AGENT_BUS_HOME ?? join(homedir(), ".agent-bus");
export const BUS_PORT = Number(process.env.AGENT_BUS_PORT ?? 7717);
export const BUS_HOST = process.env.AGENT_BUS_HOST ?? "127.0.0.1";
export const BUS_URL = process.env.AGENT_BUS_URL ?? `http://${BUS_HOST}:${BUS_PORT}`;
export const MAX_WAIT_MS = 240_000;
export const DEFAULT_WAIT_MS = 180_000;
export const DEFAULT_BLOCK_MS = Number(process.env.AGENT_BUS_BLOCK_SEC ?? 900) * 1000;
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
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Actually billed. Zero when the model runs on a flat-rate plan. */
  costUSD: number;
  /** What the same tokens would cost metered, regardless of plan. */
  notionalUSD: number;
  latencyMs: number;
}

/**
 * One append-only ledger entry. The broker writes these; nothing rewrites them.
 * Rollups in `UsageMetrics` are derived and can always be rebuilt from the events,
 * which is what makes a windowed view (last 5h, last week) possible at all.
 */
export interface UsageEvent {
  id: string;
  ts: number;
  agentId: string;
  taskId: string | null;
  runId: string | null;
  /** Config model id, e.g. `opus-current`. */
  modelId: string;
  /** Wire model name the harness actually called, e.g. `claude-opus-4-8`. */
  model: string;
  provider: string;
  harness: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUSD: number;
  notionalUSD: number;
  billing: "metered" | "subscription" | "local";
  pricingSource: "config" | "table" | "unknown";
  latencyMs: number;
  /** How the numbers arrived: self-reported by the agent, or derived by the broker. */
  source: "agent" | "task_submit" | "harness" | "operator";
}

export interface UsageBucket {
  key: string;
  label: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUSD: number;
  notionalUSD: number;
}

export interface UsageSummary {
  windowMs: number;
  since: number;
  until: number;
  totals: UsageBucket;
  byAgent: UsageBucket[];
  byModel: UsageBucket[];
  byProvider: UsageBucket[];
  /** Evenly spaced buckets across the window, oldest first, for sparklines. */
  series: { ts: number; totalTokens: number; costUSD: number; notionalUSD: number }[];
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

export function emptyUsage(): UsageMetrics {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    notionalUSD: 0,
    latencyMs: 0,
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export async function brokerCall<T = any>(path: string, payload: unknown, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(`${BUS_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`broker ${path} -> ${res.status}: ${text.slice(0, 800)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function brokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BUS_URL}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}
