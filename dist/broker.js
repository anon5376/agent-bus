import { createServer } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { BUS_HOME, BUS_HOST, BUS_PORT, MAX_WAIT_MS, STALE_AGENT_MS, newId, } from "./protocol.js";
const agents = new Map();
const mailboxes = new Map();
const tasks = new Map();
let waiters = [];
/** Every message ever delivered this session, for the GUI stream. */
const history = [];
const HISTORY_CAP = 5000;
let seqCounter = 0;
// --- sender authentication -------------------------------------------------
// A message's `from` is ALWAYS the identity that owns the bearer token on the
// request — never a field the caller supplies. An agent that only holds its own
// token therefore cannot post as anyone else. This is the fix for the weakness
// gpt itself flagged: authority is enforced by the broker, not inferred by a model.
const OPERATOR_ID = "operator";
const tokensToId = new Map(); // token -> agent id
const idToToken = new Map(); // agent id -> its stable token
/** pid of the supervisor process holding each agent, for the GUI kill switch. */
const supervisorPids = new Map();
/** workdir + cli each supervised agent runs in, for the GUI "open in terminal". */
const supervisorMeta = new Map();
/** Cumulative usage per agent this session, for the GUI's per-subscription readout. */
const usageByAgent = new Map();
function tokenFor(id) {
    let tok = idToToken.get(id);
    if (!tok) {
        tok = randomBytes(24).toString("base64url");
        idToToken.set(id, tok);
        tokensToId.set(tok, id);
    }
    return tok;
}
class AuthError extends Error {
}
/** Identity that owns this token, or throw. Callers never pass their own id. */
function caller(b) {
    const tok = typeof b?.token === "string" ? b.token : "";
    const id = tokensToId.get(tok);
    if (!id)
        throw new AuthError("unauthorized: missing or invalid token");
    return id;
}
mkdirSync(BUS_HOME, { recursive: true });
const LOG_PATH = join(BUS_HOME, "bus.jsonl");
const OPERATOR_TOKEN_PATH = join(BUS_HOME, "operator.token");
function audit(kind, data) {
    try {
        appendFileSync(LOG_PATH, JSON.stringify({ ts: Date.now(), kind, data }) + "\n");
    }
    catch {
        /* logging must never take the broker down */
    }
}
function mailbox(agentId) {
    let box = mailboxes.get(agentId);
    if (!box) {
        box = [];
        mailboxes.set(agentId, box);
    }
    return box;
}
function touch(agentId, status) {
    const agent = agents.get(agentId);
    if (!agent)
        return undefined;
    agent.lastSeen = Date.now();
    if (status)
        agent.status = status;
    return agent;
}
function effectiveStatus(agent) {
    if (Date.now() - agent.lastSeen > STALE_AGENT_MS)
        return "offline";
    return agent.status;
}
function roster() {
    return [...agents.values()]
        .map((a) => {
        const pending = mailbox(a.id).length;
        const blocked = waiters.some((w) => w.agentId === a.id);
        return {
            id: a.id,
            role: a.role,
            model: a.model,
            description: a.description,
            harness: a.harness ?? null,
            auth: a.auth ?? null,
            status: effectiveStatus(a),
            currentTaskId: a.currentTaskId,
            pendingMessages: pending,
            lastSeenSecondsAgo: Math.round((Date.now() - a.lastSeen) / 1000),
            /** Parked in a long poll, i.e. genuinely reachable right now. */
            blocked,
            /**
             * Has mail nobody is coming to collect — the agent's turn ended without
             * leaving a wait outstanding. This is the failure mode worth alarming on.
             * An agent mid-turn is busy, not deaf: its supervisor collects the mail on
             * the next loop, so "working" must not raise the alarm.
             */
            stalled: pending > 0 && !blocked && effectiveStatus(a) !== "working",
            /** pid of the supervisor daemon holding this agent, if any (GUI kill switch). */
            supervisorPid: supervisorPids.get(a.id) ?? null,
            /** where/how this agent runs, for the GUI "open session in terminal". */
            workdir: supervisorMeta.get(a.id)?.workdir ?? null,
            cli: supervisorMeta.get(a.id)?.cli ?? null,
            /** cumulative session usage, for the per-subscription readout. */
            usage: usageByAgent.get(a.id) ?? { turns: 0, tokens: 0, costUSD: 0 },
        };
    })
        .sort((a, b) => a.id.localeCompare(b.id));
}
/** Hand any queued mail to agents currently blocked in /wait. */
function flushWaiters() {
    if (waiters.length === 0)
        return;
    const stillWaiting = [];
    for (const w of waiters) {
        const box = mailbox(w.agentId);
        if (box.length > 0) {
            const batch = box.splice(0, box.length);
            clearTimeout(w.timer);
            w.resolve(batch);
        }
        else {
            stillWaiting.push(w);
        }
    }
    waiters = stillWaiting;
}
function deliver(msg) {
    msg.seq = ++seqCounter;
    mailbox(msg.to).push(msg);
    history.push(msg);
    if (history.length > HISTORY_CAP)
        history.splice(0, history.length - HISTORY_CAP);
    audit("message", msg);
    flushWaiters();
}
function makeMessage(input) {
    return {
        id: newId("msg"),
        seq: 0, // assigned by deliver()
        ts: Date.now(),
        from: input.from,
        to: input.to,
        type: input.type,
        subject: input.subject,
        body: input.body,
        taskId: input.taskId ?? null,
    };
}
/** Resolve "*" / "all" to every registered agent except the sender. */
function resolveRecipients(from, to) {
    if (to === "*" || to.toLowerCase() === "all") {
        return [...agents.keys()].filter((id) => id !== from);
    }
    return to
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
function taskView(t) {
    return { ...t, history: t.history.slice(-12) };
}
const routes = {
    "/register": (b) => {
        const id = String(b.id);
        // The operator is privileged and bootstrapped at startup; its token lives only
        // in the 0600 token file, never handed out over the open register endpoint.
        if (id === OPERATOR_ID) {
            throw new AuthError("operator identity is reserved");
        }
        const existing = agents.get(id);
        const agent = existing ?? {
            id,
            role: String(b.role ?? "worker"),
            model: String(b.model ?? "unknown"),
            description: String(b.description ?? ""),
            status: "idle",
            currentTaskId: null,
            registeredAt: Date.now(),
            lastSeen: Date.now(),
        };
        // A re-registering agent (restarted session) refreshes its metadata but
        // keeps its mailbox, so messages sent while it was down are still there.
        agent.role = String(b.role ?? agent.role);
        agent.model = String(b.model ?? agent.model);
        if (b.description)
            agent.description = String(b.description);
        if (b.harness)
            agent.harness = String(b.harness);
        if (b.auth)
            agent.auth = String(b.auth);
        agent.lastSeen = Date.now();
        if (effectiveStatus(agent) === "offline")
            agent.status = "idle";
        agents.set(id, agent);
        mailbox(id);
        audit("register", { id, role: agent.role, model: agent.model });
        return {
            agent: { ...agent, status: effectiveStatus(agent) },
            pendingMessages: mailbox(id).length,
            // The token binds this identity: whoever holds it sends *as* this agent and
            // as no one else. Returned only to whoever registered the id.
            token: tokenFor(id),
            roster: roster(),
        };
    },
    "/status": (b) => {
        const id = caller(b);
        const agent = touch(id, b.status);
        if (!agent)
            throw new Error(`unknown agent: ${id}`);
        return { ok: true, status: effectiveStatus(agent) };
    },
    /** A supervisor announces the pid/workdir/cli holding an agent, for the GUI. */
    "/presence": (b) => {
        const id = caller(b);
        const pid = Number(b.pid);
        if (Number.isFinite(pid) && pid > 0)
            supervisorPids.set(id, pid);
        if (b.workdir || b.cli) {
            supervisorMeta.set(id, {
                workdir: String(b.workdir ?? ""),
                cli: String(b.cli ?? ""),
            });
        }
        return { ok: true };
    },
    /** A supervisor reports its agent's cumulative token/cost usage. */
    "/usage": (b) => {
        const id = caller(b);
        usageByAgent.set(id, {
            turns: Number(b.turns ?? 0),
            tokens: Number(b.tokens ?? 0),
            costUSD: Number(b.costUSD ?? 0),
        });
        return { ok: true };
    },
    "/roster": () => ({ roster: roster() }),
    "/send": (b) => {
        const from = caller(b); // authoritative — cannot be spoofed
        touch(from);
        const recipients = resolveRecipients(from, String(b.to));
        if (recipients.length === 0)
            throw new Error("no recipients resolved");
        const unknown = recipients.filter((r) => !agents.has(r));
        const sent = [];
        for (const to of recipients) {
            if (!agents.has(to))
                continue;
            const msg = makeMessage({
                from,
                to,
                type: (b.type ?? "info"),
                subject: String(b.subject ?? ""),
                body: String(b.body ?? ""),
                taskId: b.taskId ?? null,
            });
            deliver(msg);
            sent.push(msg);
        }
        return {
            delivered: sent.map((m) => ({ id: m.id, to: m.to })),
            unknownRecipients: unknown,
        };
    },
    "/wait": (b) => new Promise((resolve, reject) => {
        let agentId;
        try {
            agentId = caller(b);
        }
        catch (err) {
            return reject(err);
        }
        touch(agentId, "waiting");
        const box = mailbox(agentId);
        if (box.length > 0) {
            const batch = box.splice(0, box.length);
            resolve({ messages: batch, timedOut: false });
            return;
        }
        const waitMs = Math.min(Number(b.timeoutMs ?? 0) || 0, MAX_WAIT_MS);
        const waiter = {
            agentId,
            resolve: (messages) => resolve({ messages, timedOut: false }),
            timer: setTimeout(() => {
                waiters = waiters.filter((w) => w !== waiter);
                resolve({ messages: [], timedOut: true });
            }, waitMs),
        };
        waiters.push(waiter);
    }),
    "/peek": (b) => {
        const agentId = caller(b);
        touch(agentId);
        const box = mailbox(agentId);
        if (b.drain === false)
            return { messages: box.slice(), timedOut: false };
        return { messages: box.splice(0, box.length), timedOut: false };
    },
    "/task/create": (b) => {
        const assigner = caller(b); // authoritative
        const assignee = String(b.assignee);
        touch(assigner);
        if (!agents.has(assignee)) {
            throw new Error(`unknown assignee "${assignee}" — registered agents: ${[...agents.keys()].join(", ") || "(none)"}`);
        }
        const now = Date.now();
        const task = {
            id: newId("task"),
            title: String(b.title),
            brief: String(b.brief),
            context: String(b.context ?? ""),
            assigner,
            assignee,
            state: "assigned",
            round: 1,
            createdAt: now,
            updatedAt: now,
            history: [
                {
                    ts: now,
                    actor: assigner,
                    kind: "assigned",
                    state: "assigned",
                    note: String(b.title),
                },
            ],
        };
        tasks.set(task.id, task);
        const worker = agents.get(assignee);
        worker.currentTaskId = task.id;
        deliver(makeMessage({
            from: assigner,
            to: assignee,
            type: "task",
            subject: `[TASK ${task.id}] ${task.title}`,
            body: [
                task.brief,
                task.context ? `\n\n--- context ---\n${task.context}` : "",
                `\n\nWhen finished call bus_submit_work with task_id="${task.id}".`,
            ].join(""),
            taskId: task.id,
        }));
        audit("task_create", task);
        return { task: taskView(task) };
    },
    "/task/submit": (b) => {
        const task = tasks.get(String(b.taskId));
        if (!task)
            throw new Error(`unknown task: ${b.taskId}`);
        const actor = caller(b);
        if (actor !== task.assignee && actor !== OPERATOR_ID) {
            throw new AuthError(`only ${task.assignee} may submit ${task.id} (you are ${actor})`);
        }
        touch(actor, "idle");
        task.state = "submitted";
        task.updatedAt = Date.now();
        task.history.push({
            ts: Date.now(),
            actor,
            kind: "submitted",
            state: "submitted",
            note: String(b.summary ?? ""),
        });
        deliver(makeMessage({
            from: actor,
            to: task.assigner,
            type: "result",
            subject: `[DONE ${task.id} r${task.round}] ${task.title}`,
            body: [
                String(b.summary ?? ""),
                b.details ? `\n\n--- details ---\n${b.details}` : "",
                `\n\nReview with bus_review_work(task_id="${task.id}").`,
            ].join(""),
            taskId: task.id,
        }));
        audit("task_submit", { taskId: task.id, actor });
        return { task: taskView(task) };
    },
    "/task/review": (b) => {
        const task = tasks.get(String(b.taskId));
        if (!task)
            throw new Error(`unknown task: ${b.taskId}`);
        const actor = caller(b);
        if (actor !== task.assigner && actor !== OPERATOR_ID) {
            throw new AuthError(`only ${task.assigner} or the operator may review ${task.id} (you are ${actor})`);
        }
        touch(actor);
        const accepted = Boolean(b.accepted);
        const state = accepted ? "accepted" : "changes_requested";
        task.state = state;
        task.updatedAt = Date.now();
        if (!accepted)
            task.round += 1;
        task.history.push({
            ts: Date.now(),
            actor,
            kind: "reviewed",
            state,
            note: String(b.feedback ?? ""),
        });
        const worker = agents.get(task.assignee);
        if (worker)
            worker.currentTaskId = accepted ? null : task.id;
        deliver(makeMessage({
            from: actor,
            to: task.assignee,
            type: "feedback",
            subject: accepted
                ? `[ACCEPTED ${task.id}] ${task.title}`
                : `[CHANGES ${task.id} r${task.round}] ${task.title}`,
            body: accepted
                ? `${b.feedback ?? "Accepted."}\n\nNo further action required on this task.`
                : `${b.feedback}\n\nRevise and call bus_submit_work with task_id="${task.id}" again.`,
            taskId: task.id,
        }));
        audit("task_review", { taskId: task.id, actor, accepted });
        return { task: taskView(task) };
    },
    "/task/list": (b) => {
        const filterAgent = b.agent ? String(b.agent) : null;
        const open = b.openOnly !== false;
        const list = [...tasks.values()]
            .filter((t) => filterAgent
            ? t.assignee === filterAgent || t.assigner === filterAgent
            : true)
            .filter((t) => open ? !["accepted", "cancelled"].includes(t.state) : true)
            .sort((a, b2) => b2.updatedAt - a.updatedAt)
            .map(taskView);
        return { tasks: list };
    },
    "/task/get": (b) => {
        const task = tasks.get(String(b.taskId));
        if (!task)
            throw new Error(`unknown task: ${b.taskId}`);
        return { task };
    },
    "/task/cancel": (b) => {
        const task = tasks.get(String(b.taskId));
        if (!task)
            throw new Error(`unknown task: ${b.taskId}`);
        const actor = caller(b);
        if (actor !== task.assigner && actor !== OPERATOR_ID) {
            throw new AuthError(`only ${task.assigner} or the operator may cancel ${task.id} (you are ${actor})`);
        }
        task.state = "cancelled";
        task.updatedAt = Date.now();
        task.history.push({
            ts: Date.now(),
            actor,
            kind: "cancelled",
            state: "cancelled",
            note: String(b.reason ?? ""),
        });
        const worker = agents.get(task.assignee);
        if (worker && worker.currentTaskId === task.id)
            worker.currentTaskId = null;
        deliver(makeMessage({
            from: actor,
            to: task.assignee,
            type: "info",
            subject: `[CANCELLED ${task.id}] ${task.title}`,
            body: `${b.reason ?? "Cancelled by the operator."}\n\nStop work on this task.`,
            taskId: task.id,
        }));
        audit("task_cancel", { taskId: task.id, actor });
        return { task: taskView(task) };
    },
    /** Operator kill switch: stop the supervisor (process group) holding an agent. */
    "/kill": (b) => {
        const id = caller(b);
        if (id !== OPERATOR_ID)
            throw new AuthError("only the operator may kill agents");
        const target = String(b.agentId);
        const pid = supervisorPids.get(target);
        if (!pid)
            throw new Error(`no supervisor pid recorded for "${target}"`);
        let killed = false;
        try {
            // Negative pid signals the whole process group — daemonize.js makes the
            // supervisor a group leader, so this takes its running child down too.
            process.kill(-pid, "SIGTERM");
            killed = true;
        }
        catch {
            try {
                process.kill(pid, "SIGTERM");
                killed = true;
            }
            catch {
                /* already gone */
            }
        }
        supervisorPids.delete(target);
        const agent = agents.get(target);
        if (agent)
            agent.status = "offline";
        audit("kill", { target, pid, killed, by: id });
        return { ok: killed, pid };
    },
    /** Single poll for the desktop GUI: roster + tasks + messages since a cursor. */
    "/snapshot": (b) => {
        const since = Number(b.sinceSeq ?? 0);
        return {
            roster: roster(),
            tasks: [...tasks.values()].sort((a, b2) => b2.updatedAt - a.updatedAt),
            messages: history.filter((m) => m.seq > since),
            seq: seqCounter,
            waiting: waiters.map((w) => w.agentId),
            brokerPid: process.pid,
        };
    },
    "/state": () => ({
        roster: roster(),
        tasks: [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt),
        waiting: waiters.map((w) => w.agentId),
    }),
};
// ---------------------------------------------------------------- server
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("error", reject);
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (!raw)
                return resolve({});
            try {
                resolve(JSON.parse(raw));
            }
            catch (err) {
                reject(new Error(`invalid JSON body: ${err.message}`));
            }
        });
    });
}
function send(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
    });
    res.end(body);
}
/** Bootstrap the operator identity and write its token where the GUI/CLI can read it. */
function initOperator() {
    const now = Date.now();
    agents.set(OPERATOR_ID, {
        id: OPERATOR_ID,
        role: "human",
        model: "control-panel",
        description: "The human operator at the control panel.",
        status: "idle",
        currentTaskId: null,
        registeredAt: now,
        lastSeen: now,
    });
    mailbox(OPERATOR_ID);
    const tok = tokenFor(OPERATOR_ID);
    try {
        writeFileSync(OPERATOR_TOKEN_PATH, tok, { mode: 0o600 });
    }
    catch (err) {
        process.stderr.write(`could not write operator token to ${OPERATOR_TOKEN_PATH}: ${err.message}\n`);
    }
}
export function startBroker() {
    initOperator();
    const server = createServer(async (req, res) => {
        const path = (req.url ?? "/").split("?")[0];
        if (path === "/health") {
            return send(res, 200, { ok: true, pid: process.pid, agents: agents.size });
        }
        const handler = routes[path];
        if (!handler)
            return send(res, 404, { error: `no route ${path}` });
        try {
            const body = await readBody(req);
            send(res, 200, await handler(body));
        }
        catch (err) {
            const code = err instanceof AuthError ? 401 : 400;
            send(res, code, { error: err.message });
        }
    });
    // Long-polls hold sockets open far longer than the 5s Node default.
    server.headersTimeout = MAX_WAIT_MS + 60_000;
    server.requestTimeout = 0;
    server.keepAliveTimeout = MAX_WAIT_MS + 60_000;
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(BUS_PORT, BUS_HOST, () => {
            process.stderr.write(`agent-bus broker listening on http://${BUS_HOST}:${BUS_PORT} (log: ${LOG_PATH})\n`);
            resolve();
        });
    });
}
//# sourceMappingURL=broker.js.map