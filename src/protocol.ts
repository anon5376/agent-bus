import { homedir } from "node:os";
import { join } from "node:path";

export const BUS_HOME =
  process.env.AGENT_BUS_HOME ?? join(homedir(), ".agent-bus");

export const BUS_PORT = Number(process.env.AGENT_BUS_PORT ?? 7717);
export const BUS_HOST = "127.0.0.1";
export const BUS_URL = `http://${BUS_HOST}:${BUS_PORT}`;

/** Longest a single broker long-poll may block. Under undici's 300s header timeout. */
export const MAX_WAIT_MS = 240_000;
export const DEFAULT_WAIT_MS = 180_000;

/**
 * How long `bus_wait` blocks overall. The MCP shim re-issues broker polls back to
 * back for this long, so the agent gets one uninterrupted call rather than a string
 * of empty timeouts it might decide to stop re-calling. Must stay under the host
 * CLI's own MCP tool timeout, which the launcher raises to an hour.
 */
export const DEFAULT_BLOCK_MS = Number(process.env.AGENT_BUS_BLOCK_SEC ?? 900) * 1000;
export const MAX_BLOCK_MS = 3_600_000;

/** An agent is considered offline if it hasn't touched the broker in this long. */
export const STALE_AGENT_MS = 15 * 60_000;

export type MessageType =
  | "task"
  | "result"
  | "feedback"
  | "question"
  | "answer"
  | "info";

export type AgentStatus = "idle" | "working" | "waiting" | "offline";

export interface Agent {
  id: string;
  /** Bearer token proving this identity; held only by the agent's own processes. */
  token?: string;
  role: string;
  model: string;
  description: string;
  /** Which CLI harness runs this agent (claude, codex, opencode, kimi, grok…). */
  harness?: string;
  /** Human-readable auth source, for display (subscription vs credits). */
  auth?: string;
  status: AgentStatus;
  currentTaskId: string | null;
  registeredAt: number;
  lastSeen: number;
}

export interface Message {
  id: string;
  /** Monotonic delivery counter — the GUI uses it as a poll cursor. */
  seq: number;
  ts: number;
  from: string;
  to: string;
  type: MessageType;
  subject: string;
  body: string;
  taskId: string | null;
}

export type TaskState =
  | "assigned"
  | "in_progress"
  | "submitted"
  | "changes_requested"
  | "accepted"
  | "cancelled";

export interface Task {
  id: string;
  title: string;
  brief: string;
  context: string;
  assigner: string;
  assignee: string;
  state: TaskState;
  round: number;
  createdAt: number;
  updatedAt: number;
  /** Every submission and review, oldest first. */
  history: TaskEvent[];
}

export interface TaskEvent {
  ts: number;
  actor: string;
  kind: "assigned" | "submitted" | "reviewed" | "cancelled";
  state: TaskState;
  note: string;
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now()
    .toString(36)
    .slice(-4)}`;
}

/** POST JSON to the broker and parse the reply. Throws on non-2xx. */
export async function brokerCall<T = any>(
  path: string,
  payload: unknown,
  timeoutMs = 20_000,
): Promise<T> {
  const res = await fetch(`${BUS_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`broker ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function brokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BUS_URL}/health`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}
