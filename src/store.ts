import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { AgentPermissions, Authority } from "./config.js";
import type { RoutingDecision } from "./router.js";
import type { Agent, Message, ModelTelemetry, Run, Task, UsageMetrics } from "./protocol.js";

interface IdentityRow {
  id: string;
  token_hash: string;
  authority: Authority;
  permissions_json: string;
  created_at: number;
  updated_at: number;
}

interface JsonRow { json: string }
interface MessageRow { seq: number; json: string }
interface LeaseRow { task_id: string; path: string }

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function average(previous: number, count: number, next: number): number {
  if (count <= 1) return next;
  return ((previous * (count - 1)) + next) / count;
}

export interface StoredIdentity {
  id: string;
  tokenHash: string;
  authority: Authority;
  permissions: AgentPermissions;
  createdAt: number;
  updatedAt: number;
}

export class StateStore {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identities (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        authority TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        to_agent TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_pending_idx ON messages(to_agent, delivered, seq);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        state TEXT NOT NULL,
        assignee TEXT NOT NULL,
        parent_task_id TEXT,
        updated_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_run_idx ON tasks(run_id, state, updated_at);
      CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks(assignee, state, updated_at);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        run_id TEXT,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        agent_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telemetry (
        agent_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS path_leases (
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(task_id, path)
      );
      CREATE INDEX IF NOT EXISTS leases_run_idx ON path_leases(run_id, path);
    `);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  upsertIdentity(identity: StoredIdentity): void {
    this.db.prepare(`
      INSERT INTO identities(id, token_hash, authority, permissions_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        token_hash = excluded.token_hash,
        authority = excluded.authority,
        permissions_json = excluded.permissions_json,
        updated_at = excluded.updated_at
    `).run(
      identity.id,
      identity.tokenHash,
      identity.authority,
      stringify(identity.permissions),
      identity.createdAt,
      identity.updatedAt,
    );
  }

  identityById(id: string): StoredIdentity | null {
    const row = this.db.prepare("SELECT * FROM identities WHERE id = ?").get(id) as IdentityRow | undefined;
    return row ? this.identityFromRow(row) : null;
  }

  identityByTokenHash(tokenHash: string): StoredIdentity | null {
    const row = this.db.prepare("SELECT * FROM identities WHERE token_hash = ?").get(tokenHash) as IdentityRow | undefined;
    return row ? this.identityFromRow(row) : null;
  }

  private identityFromRow(row: IdentityRow): StoredIdentity {
    return {
      id: row.id,
      tokenHash: row.token_hash,
      authority: row.authority,
      permissions: parse<AgentPermissions>(row.permissions_json),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  saveAgent(agent: Agent): void {
    this.db.prepare(`
      INSERT INTO agents(id, json, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `).run(agent.id, stringify(agent), Date.now());
  }

  loadAgents(): Agent[] {
    const rows = this.db.prepare("SELECT json FROM agents ORDER BY id").all() as unknown as JsonRow[];
    return rows.map((row) => parse<Agent>(row.json));
  }

  appendMessage(message: Message): Message {
    return this.transaction(() => {
      const placeholder = { ...message, seq: 0 };
      const result = this.db.prepare(`
        INSERT INTO messages(id, to_agent, delivered, json, created_at) VALUES(?, ?, 0, ?, ?)
      `).run(message.id, message.to, stringify(placeholder), message.ts);
      const seq = Number(result.lastInsertRowid);
      const stored = { ...message, seq };
      this.db.prepare("UPDATE messages SET json = ? WHERE seq = ?").run(stringify(stored), seq);
      return stored;
    });
  }

  pendingMessages(agentId: string): Message[] {
    const rows = this.db.prepare(`
      SELECT seq, json FROM messages WHERE to_agent = ? AND delivered = 0 ORDER BY seq
    `).all(agentId) as unknown as MessageRow[];
    return rows.map((row) => ({ ...parse<Message>(row.json), seq: Number(row.seq) }));
  }

  markMessagesDelivered(ids: string[]): void {
    if (!ids.length) return;
    const statement = this.db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?");
    this.transaction(() => {
      for (const id of ids) statement.run(id);
    });
  }

  latestSequence(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages").get() as { seq: number };
    return Number(row.seq);
  }

  historySince(seq: number, limit = 5000): Message[] {
    const rows = this.db.prepare(`
      SELECT seq, json FROM messages WHERE seq > ? ORDER BY seq LIMIT ?
    `).all(seq, limit) as unknown as MessageRow[];
    return rows.map((row) => ({ ...parse<Message>(row.json), seq: Number(row.seq) }));
  }

  saveTask(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks(id, run_id, state, assignee, parent_task_id, updated_at, json)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        run_id = excluded.run_id,
        state = excluded.state,
        assignee = excluded.assignee,
        parent_task_id = excluded.parent_task_id,
        updated_at = excluded.updated_at,
        json = excluded.json
    `).run(task.id, task.runId, task.state, task.assignee, task.parentTaskId, task.updatedAt, stringify(task));
  }

  loadTasks(): Task[] {
    const rows = this.db.prepare("SELECT json FROM tasks ORDER BY updated_at DESC").all() as unknown as JsonRow[];
    return rows.map((row) => parse<Task>(row.json));
  }

  task(id: string): Task | null {
    const row = this.db.prepare("SELECT json FROM tasks WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? parse<Task>(row.json) : null;
  }

  saveRun(run: Run): void {
    this.db.prepare(`
      INSERT INTO runs(id, status, updated_at, json) VALUES(?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, json = excluded.json
    `).run(run.id, run.status, run.updatedAt, stringify(run));
  }

  loadRuns(): Run[] {
    const rows = this.db.prepare("SELECT json FROM runs ORDER BY updated_at DESC").all() as unknown as JsonRow[];
    return rows.map((row) => parse<Run>(row.json));
  }

  saveRoutingDecision(taskId: string | null, runId: string | null, decision: RoutingDecision): void {
    this.db.prepare("INSERT INTO routing_decisions(task_id, run_id, created_at, json) VALUES(?, ?, ?, ?)")
      .run(taskId, runId, decision.createdAt, stringify(decision));
  }

  routingDecisions(taskId?: string): RoutingDecision[] {
    const rows = taskId
      ? this.db.prepare("SELECT json FROM routing_decisions WHERE task_id = ? ORDER BY id").all(taskId)
      : this.db.prepare("SELECT json FROM routing_decisions ORDER BY id").all();
    return (rows as unknown as JsonRow[]).map((row) => parse<RoutingDecision>(row.json));
  }

  saveUsage(agentId: string, usage: UsageMetrics): void {
    this.db.prepare(`
      INSERT INTO usage(agent_id, json, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `).run(agentId, stringify(usage), Date.now());
  }

  usage(agentId: string): UsageMetrics | null {
    const row = this.db.prepare("SELECT json FROM usage WHERE agent_id = ?").get(agentId) as JsonRow | undefined;
    return row ? parse<UsageMetrics>(row.json) : null;
  }

  allUsage(): Record<string, UsageMetrics> {
    const rows = this.db.prepare("SELECT agent_id, json FROM usage").all() as unknown as { agent_id: string; json: string }[];
    return Object.fromEntries(rows.map((row) => [row.agent_id, parse<UsageMetrics>(row.json)]));
  }

  telemetry(): ModelTelemetry[] {
    const rows = this.db.prepare("SELECT json FROM telemetry ORDER BY agent_id").all() as unknown as JsonRow[];
    return rows.map((row) => parse<ModelTelemetry>(row.json));
  }

  recordTaskOutcome(task: Task, outcome: "accepted" | "failed" | "rejected"): void {
    if (!task.assignee) return;
    const existing = this.db.prepare("SELECT json FROM telemetry WHERE agent_id = ?").get(task.assignee) as JsonRow | undefined;
    const previous = existing ? parse<ModelTelemetry>(existing.json) : {
      agentId: task.assignee,
      taskCount: 0,
      acceptedCount: 0,
      failedCount: 0,
      reviewRejectedCount: 0,
      averageLatencyMs: 0,
      averageTokens: 0,
      updatedAt: Date.now(),
    };
    const taskCount = outcome === "rejected" ? previous.taskCount : previous.taskCount + 1;
    const next: ModelTelemetry = {
      ...previous,
      taskCount,
      acceptedCount: previous.acceptedCount + (outcome === "accepted" ? 1 : 0),
      failedCount: previous.failedCount + (outcome === "failed" ? 1 : 0),
      reviewRejectedCount: previous.reviewRejectedCount + (outcome === "rejected" ? 1 : 0),
      averageLatencyMs: outcome === "rejected" ? previous.averageLatencyMs : average(previous.averageLatencyMs, taskCount, task.usage.latencyMs),
      averageTokens: outcome === "rejected" ? previous.averageTokens : average(previous.averageTokens, taskCount, task.usage.totalTokens),
      updatedAt: Date.now(),
    };
    this.db.prepare(`
      INSERT INTO telemetry(agent_id, json, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `).run(next.agentId, stringify(next), next.updatedAt);
  }

  normalizeScope(projectRoot: string, scope: string): string {
    const root = resolve(projectRoot);
    const absolute = resolve(root, scope || ".");
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new Error(`path scope escapes project root: ${scope}`);
    }
    const rel = relative(root, absolute).split(sep).join("/");
    return rel || ".";
  }

  acquirePathLeases(taskId: string, runId: string, projectRoot: string, scopes: string[]): { acquired: boolean; conflicts: { taskId: string; path: string }[]; normalized: string[] } {
    const normalized = [...new Set(scopes.map((scope) => this.normalizeScope(projectRoot, scope)))].sort();
    if (!normalized.length) return { acquired: true, conflicts: [], normalized };
    return this.transaction(() => {
      const active = this.db.prepare("SELECT task_id, path FROM path_leases WHERE run_id = ? AND task_id != ?")
        .all(runId, taskId) as unknown as LeaseRow[];
      const conflicts: { taskId: string; path: string }[] = [];
      const overlaps = (a: string, b: string) => a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
      for (const wanted of normalized) {
        for (const lease of active) {
          if (overlaps(wanted, lease.path)) conflicts.push({ taskId: lease.task_id, path: lease.path });
        }
      }
      if (conflicts.length) return { acquired: false, conflicts, normalized };
      const insert = this.db.prepare("INSERT OR REPLACE INTO path_leases(task_id, run_id, path, created_at) VALUES(?, ?, ?, ?)");
      for (const path of normalized) insert.run(taskId, runId, path, Date.now());
      return { acquired: true, conflicts: [], normalized };
    });
  }

  releasePathLeases(taskId: string): void {
    this.db.prepare("DELETE FROM path_leases WHERE task_id = ?").run(taskId);
  }

  pathLeases(runId?: string): { taskId: string; runId: string; path: string; createdAt: number }[] {
    const rows = runId
      ? this.db.prepare("SELECT task_id, run_id, path, created_at FROM path_leases WHERE run_id = ? ORDER BY path").all(runId)
      : this.db.prepare("SELECT task_id, run_id, path, created_at FROM path_leases ORDER BY run_id, path").all();
    return (rows as unknown as { task_id: string; run_id: string; path: string; created_at: number }[]).map((row) => ({
      taskId: row.task_id,
      runId: row.run_id,
      path: row.path,
      createdAt: Number(row.created_at),
    }));
  }
}
