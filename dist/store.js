import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
function parse(value) {
    return JSON.parse(value);
}
function stringify(value) {
    return JSON.stringify(value);
}
function round6(value) {
    return Math.round(value * 1e6) / 1e6;
}
function emptyBucket(key, label) {
    return {
        key,
        label,
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        costUSD: 0,
        notionalUSD: 0,
    };
}
function bucketFor(map, key, label) {
    const existing = map.get(key);
    if (existing)
        return existing;
    const created = emptyBucket(key, label);
    map.set(key, created);
    return created;
}
function accumulate(bucket, event) {
    bucket.events += 1;
    bucket.inputTokens += event.inputTokens;
    bucket.outputTokens += event.outputTokens;
    bucket.cacheReadTokens += event.cacheReadTokens;
    bucket.cacheWriteTokens += event.cacheWriteTokens;
    bucket.reasoningTokens += event.reasoningTokens;
    bucket.totalTokens += event.totalTokens;
    bucket.costUSD = round6(bucket.costUSD + event.costUSD);
    bucket.notionalUSD = round6(bucket.notionalUSD + event.notionalUSD);
}
function average(previous, count, next) {
    if (count <= 1)
        return next;
    return ((previous * (count - 1)) + next) / count;
}
export class StateStore {
    path;
    db;
    constructor(path) {
        this.path = path;
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
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        model_id TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        total_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        notional_usd REAL NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_events_ts_idx ON usage_events(ts);
      CREATE INDEX IF NOT EXISTS usage_events_agent_idx ON usage_events(agent_id, ts);
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
    close() {
        this.db.close();
    }
    transaction(fn) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const value = fn();
            this.db.exec("COMMIT");
            return value;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    getMeta(key) {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
        return row?.value ?? null;
    }
    setMeta(key, value) {
        this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    }
    upsertIdentity(identity) {
        this.db.prepare(`
      INSERT INTO identities(id, token_hash, authority, permissions_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        token_hash = excluded.token_hash,
        authority = excluded.authority,
        permissions_json = excluded.permissions_json,
        updated_at = excluded.updated_at
    `).run(identity.id, identity.tokenHash, identity.authority, stringify(identity.permissions), identity.createdAt, identity.updatedAt);
    }
    identityById(id) {
        const row = this.db.prepare("SELECT * FROM identities WHERE id = ?").get(id);
        return row ? this.identityFromRow(row) : null;
    }
    identityByTokenHash(tokenHash) {
        const row = this.db.prepare("SELECT * FROM identities WHERE token_hash = ?").get(tokenHash);
        return row ? this.identityFromRow(row) : null;
    }
    identityFromRow(row) {
        return {
            id: row.id,
            tokenHash: row.token_hash,
            authority: row.authority,
            permissions: parse(row.permissions_json),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        };
    }
    saveAgent(agent) {
        this.db.prepare(`
      INSERT INTO agents(id, json, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `).run(agent.id, stringify(agent), Date.now());
    }
    loadAgents() {
        const rows = this.db.prepare("SELECT json FROM agents ORDER BY id").all();
        return rows.map((row) => parse(row.json));
    }
    appendMessage(message) {
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
    pendingMessages(agentId) {
        const rows = this.db.prepare(`
      SELECT seq, json FROM messages WHERE to_agent = ? AND delivered = 0 ORDER BY seq
    `).all(agentId);
        return rows.map((row) => ({ ...parse(row.json), seq: Number(row.seq) }));
    }
    markMessagesDelivered(ids) {
        if (!ids.length)
            return;
        const statement = this.db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?");
        this.transaction(() => {
            for (const id of ids)
                statement.run(id);
        });
    }
    latestSequence() {
        const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages").get();
        return Number(row.seq);
    }
    historySince(seq, limit = 5000) {
        const rows = this.db.prepare(`
      SELECT seq, json FROM messages WHERE seq > ? ORDER BY seq LIMIT ?
    `).all(seq, limit);
        return rows.map((row) => ({ ...parse(row.json), seq: Number(row.seq) }));
    }
    saveTask(task) {
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
    loadTasks() {
        const rows = this.db.prepare("SELECT json FROM tasks ORDER BY updated_at DESC").all();
        return rows.map((row) => parse(row.json));
    }
    task(id) {
        const row = this.db.prepare("SELECT json FROM tasks WHERE id = ?").get(id);
        return row ? parse(row.json) : null;
    }
    saveRun(run) {
        this.db.prepare(`
      INSERT INTO runs(id, status, updated_at, json) VALUES(?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, json = excluded.json
    `).run(run.id, run.status, run.updatedAt, stringify(run));
    }
    loadRuns() {
        const rows = this.db.prepare("SELECT json FROM runs ORDER BY updated_at DESC").all();
        return rows.map((row) => parse(row.json));
    }
    saveRoutingDecision(taskId, runId, decision) {
        this.db.prepare("INSERT INTO routing_decisions(task_id, run_id, created_at, json) VALUES(?, ?, ?, ?)")
            .run(taskId, runId, decision.createdAt, stringify(decision));
    }
    routingDecisions(taskId) {
        const rows = taskId
            ? this.db.prepare("SELECT json FROM routing_decisions WHERE task_id = ? ORDER BY id").all(taskId)
            : this.db.prepare("SELECT json FROM routing_decisions ORDER BY id").all();
        return rows.map((row) => parse(row.json));
    }
    saveUsage(agentId, usage) {
        this.db.prepare(`
      INSERT INTO usage(agent_id, json, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `).run(agentId, stringify(usage), Date.now());
    }
    usage(agentId) {
        const row = this.db.prepare("SELECT json FROM usage WHERE agent_id = ?").get(agentId);
        return row ? parse(row.json) : null;
    }
    allUsage() {
        const rows = this.db.prepare("SELECT agent_id, json FROM usage").all();
        return Object.fromEntries(rows.map((row) => [row.agent_id, parse(row.json)]));
    }
    appendUsageEvent(event) {
        this.db.prepare(`
      INSERT OR IGNORE INTO usage_events(
        id, ts, agent_id, task_id, run_id, model_id, model, provider, total_tokens, cost_usd, notional_usd, json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, event.ts, event.agentId, event.taskId, event.runId, event.modelId, event.model, event.provider, event.totalTokens, event.costUSD, event.notionalUSD, stringify(event));
    }
    usageEvents(sinceTs, limit = 20_000) {
        const rows = this.db
            .prepare("SELECT json FROM usage_events WHERE ts >= ? ORDER BY ts ASC LIMIT ?")
            .all(sinceTs, limit);
        return rows.map((row) => parse(row.json));
    }
    /**
     * Roll the ledger up over a trailing window. Recomputed on demand rather than
     * maintained incrementally: the event count over any window a human cares about
     * is small, and a derived-on-read summary can never drift from the events.
     */
    usageSummary(windowMs, now = Date.now(), bucketCount = 24) {
        const since = now - windowMs;
        const events = this.usageEvents(since);
        const totals = emptyBucket("total", "total");
        const byAgent = new Map();
        const byModel = new Map();
        const byProvider = new Map();
        const width = Math.max(1, Math.floor(windowMs / Math.max(1, bucketCount)));
        const series = Array.from({ length: bucketCount }, (_, index) => ({
            ts: since + index * width,
            totalTokens: 0,
            costUSD: 0,
            notionalUSD: 0,
        }));
        for (const event of events) {
            accumulate(totals, event);
            accumulate(bucketFor(byAgent, event.agentId, event.agentId), event);
            accumulate(bucketFor(byModel, event.modelId || event.model, event.model || event.modelId), event);
            accumulate(bucketFor(byProvider, event.provider || "unknown", event.provider || "unknown"), event);
            const slot = Math.min(bucketCount - 1, Math.max(0, Math.floor((event.ts - since) / width)));
            series[slot].totalTokens += event.totalTokens;
            series[slot].costUSD = round6(series[slot].costUSD + event.costUSD);
            series[slot].notionalUSD = round6(series[slot].notionalUSD + event.notionalUSD);
        }
        const rank = (buckets) => [...buckets.values()].sort((a, b) => b.totalTokens - a.totalTokens);
        return {
            windowMs,
            since,
            until: now,
            totals,
            byAgent: rank(byAgent),
            byModel: rank(byModel),
            byProvider: rank(byProvider),
            series,
        };
    }
    /** Trim the ledger. Rollups in `usage` are unaffected, so lifetime totals survive. */
    pruneUsageEvents(olderThanTs) {
        const before = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get();
        this.db.prepare("DELETE FROM usage_events WHERE ts < ?").run(olderThanTs);
        const after = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get();
        return before.n - after.n;
    }
    telemetry() {
        const rows = this.db.prepare("SELECT json FROM telemetry ORDER BY agent_id").all();
        return rows.map((row) => parse(row.json));
    }
    recordTaskOutcome(task, outcome) {
        if (!task.assignee)
            return;
        const existing = this.db.prepare("SELECT json FROM telemetry WHERE agent_id = ?").get(task.assignee);
        const previous = existing ? parse(existing.json) : {
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
        const next = {
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
    normalizeScope(projectRoot, scope) {
        const root = resolve(projectRoot);
        const absolute = resolve(root, scope || ".");
        if (absolute !== root && !absolute.startsWith(root + sep)) {
            throw new Error(`path scope escapes project root: ${scope}`);
        }
        const rel = relative(root, absolute).split(sep).join("/");
        return rel || ".";
    }
    acquirePathLeases(taskId, runId, projectRoot, scopes) {
        const normalized = [...new Set(scopes.map((scope) => this.normalizeScope(projectRoot, scope)))].sort();
        if (!normalized.length)
            return { acquired: true, conflicts: [], normalized };
        return this.transaction(() => {
            const active = this.db.prepare("SELECT task_id, path FROM path_leases WHERE run_id = ? AND task_id != ?")
                .all(runId, taskId);
            const conflicts = [];
            const overlaps = (a, b) => a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
            for (const wanted of normalized) {
                for (const lease of active) {
                    if (overlaps(wanted, lease.path))
                        conflicts.push({ taskId: lease.task_id, path: lease.path });
                }
            }
            if (conflicts.length)
                return { acquired: false, conflicts, normalized };
            const insert = this.db.prepare("INSERT OR REPLACE INTO path_leases(task_id, run_id, path, created_at) VALUES(?, ?, ?, ?)");
            for (const path of normalized)
                insert.run(taskId, runId, path, Date.now());
            return { acquired: true, conflicts: [], normalized };
        });
    }
    releasePathLeases(taskId) {
        this.db.prepare("DELETE FROM path_leases WHERE task_id = ?").run(taskId);
    }
    pathLeases(runId) {
        const rows = runId
            ? this.db.prepare("SELECT task_id, run_id, path, created_at FROM path_leases WHERE run_id = ? ORDER BY path").all(runId)
            : this.db.prepare("SELECT task_id, run_id, path, created_at FROM path_leases ORDER BY run_id, path").all();
        return rows.map((row) => ({
            taskId: row.task_id,
            runId: row.run_id,
            path: row.path,
            createdAt: Number(row.created_at),
        }));
    }
}
//# sourceMappingURL=store.js.map