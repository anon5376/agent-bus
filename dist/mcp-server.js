#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BUS_HOME, DEFAULT_BLOCK_MS, MAX_BLOCK_MS, MAX_WAIT_MS, brokerAlive, brokerCall, } from "./protocol.js";
const AGENT_ID = process.env.AGENT_ID;
if (!AGENT_ID) {
    process.stderr.write("agent-bus: AGENT_ID env var is required (e.g. AGENT_ID=fable5).\n");
    process.exit(1);
}
const AGENT_ROLE = process.env.AGENT_ROLE ?? "worker";
const AGENT_MODEL = process.env.AGENT_MODEL ?? "unknown";
const AGENT_DESC = process.env.AGENT_DESC ?? "";
const DEFAULT_BLOCK_SEC = DEFAULT_BLOCK_MS / 1000;
// ------------------------------------------------------------- bootstrap
/**
 * Start the broker if nobody has yet. Every agent shim races to do this on
 * launch; the losers get EADDRINUSE from the broker process and exit, which is
 * harmless because the winner is already serving.
 */
async function ensureBroker() {
    if (await brokerAlive())
        return;
    const cli = join(fileURLToPath(new URL(".", import.meta.url)), "cli.js");
    const log = openSync(join(BUS_HOME, "broker.log"), "a");
    spawn(process.execPath, [cli, "broker"], {
        detached: true,
        stdio: ["ignore", log, log],
    }).unref();
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 150));
        if (await brokerAlive())
            return;
    }
    throw new Error(`could not reach the agent-bus broker; see ${join(BUS_HOME, "broker.log")}`);
}
let registered = false;
/** This process's bearer token. Every mutating call carries it; it is what makes
 * `from` un-spoofable — we can only ever act as AGENT_ID. */
let authToken = "";
async function ensureRegistered() {
    if (registered)
        return;
    await ensureBroker();
    const res = await brokerCall("/register", {
        id: AGENT_ID,
        role: AGENT_ROLE,
        model: AGENT_MODEL,
        description: AGENT_DESC,
        harness: process.env.AGENT_HARNESS ?? "",
        auth: process.env.AGENT_AUTH ?? "",
    });
    authToken = res.token ?? "";
    registered = true;
}
/** brokerCall with our token attached — use for anything that acts as this agent. */
function authCall(path, payload, timeoutMs) {
    return brokerCall(path, { ...payload, token: authToken }, timeoutMs);
}
// ------------------------------------------------------------- rendering
function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60)
        return `${s}s ago`;
    if (s < 3600)
        return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}
function renderMessage(m) {
    return [
        `── from ${m.from} · ${m.type}${m.taskId ? ` · ${m.taskId}` : ""} · ${ago(m.ts)}`,
        m.subject,
        "",
        m.body,
    ].join("\n");
}
function renderMessages(messages, timedOut) {
    if (messages.length === 0) {
        return timedOut
            ? "No messages arrived before the timeout. Call bus_wait again to keep waiting."
            : "Inbox is empty.";
    }
    return (`${messages.length} message(s):\n\n` +
        messages.map(renderMessage).join("\n\n"));
}
function renderTask(t) {
    return `${t.id} [${t.state}] "${t.title}" ${t.assigner} → ${t.assignee} (round ${t.round}, updated ${ago(t.updatedAt)})`;
}
function text(s) {
    return { content: [{ type: "text", text: s }] };
}
async function guarded(fn) {
    try {
        await ensureRegistered();
        return text(await fn());
    }
    catch (err) {
        return {
            content: [
                { type: "text", text: `agent-bus error: ${err.message}` },
            ],
            isError: true,
        };
    }
}
// ------------------------------------------------------------- tools
const server = new McpServer({ name: "agent-bus", version: "0.1.0" });
server.tool("bus_whoami", "Your identity on the agent bus plus the current roster of agents, their status and pending mail. Call this first to learn who you can talk to.", {}, async () => guarded(async () => {
    const { roster } = await brokerCall("/roster", {});
    const lines = roster.map((a) => `  ${a.id === AGENT_ID ? "*" : " "} ${a.id} (${a.role}, ${a.model}) — ${a.status}` +
        `${a.currentTaskId ? ` on ${a.currentTaskId}` : ""}` +
        `${a.pendingMessages ? ` · ${a.pendingMessages} unread` : ""}` +
        `${a.description ? `\n      ${a.description}` : ""}`);
    return `You are "${AGENT_ID}" (role: ${AGENT_ROLE}, model: ${AGENT_MODEL}).\n\nRoster:\n${lines.join("\n")}`;
}));
server.tool("bus_send", "Send a free-form message to another agent (or to '*' for everyone). Use for questions, answers and status notes. For handing out work use bus_assign_task instead.", {
    to: z
        .string()
        .describe("Recipient agent id, a comma-separated list, or '*' for all"),
    subject: z.string().describe("One-line subject"),
    body: z.string().describe("Message body"),
    type: z
        .enum(["info", "question", "answer"])
        .default("info")
        .describe("Message kind"),
    task_id: z
        .string()
        .optional()
        .describe("Task this message relates to, if any"),
}, async ({ to, subject, body, type, task_id }) => guarded(async () => {
    const res = await authCall("/send", {
        from: AGENT_ID,
        to,
        subject,
        body,
        type,
        taskId: task_id ?? null,
    });
    const delivered = res.delivered.map((d) => d.to).join(", ") || "nobody";
    const unknown = res.unknownRecipients?.length
        ? `\nNot registered (undelivered): ${res.unknownRecipients.join(", ")}`
        : "";
    return `Delivered to: ${delivered}${unknown}`;
}));
server.tool("bus_wait", "BLOCK until another agent sends you something. This is how you idle between tasks — it costs no tokens while blocked, and it will not return until real mail arrives. Call it whenever you have nothing left to do; never end your turn with unfinished work and no wait outstanding.", {
    timeout_sec: z
        .number()
        .int()
        .min(1)
        .max(MAX_BLOCK_MS / 1000)
        .optional()
        .describe(`How long to block. Default ${DEFAULT_BLOCK_SEC}s.`),
    reason: z
        .string()
        .optional()
        .describe("What you are waiting for, shown in the monitor"),
}, async ({ timeout_sec, reason }) => guarded(async () => {
    const totalMs = Math.min((timeout_sec ?? DEFAULT_BLOCK_SEC) * 1000, MAX_BLOCK_MS);
    const deadline = Date.now() + totalMs;
    // Re-issue broker polls back to back. Each is capped by undici's header
    // timeout, but the agent sees a single long block and is never handed an
    // empty result it might choose not to follow up on.
    while (Date.now() < deadline) {
        const chunk = Math.min(MAX_WAIT_MS, deadline - Date.now());
        const res = await authCall("/wait", { agentId: AGENT_ID, timeoutMs: chunk, reason: reason ?? "" }, chunk + 15_000);
        if (res.messages.length > 0) {
            await authCall("/status", { status: "idle" });
            return renderMessages(res.messages, false);
        }
    }
    return `Nothing arrived in ${Math.round(totalMs / 1000)}s. If you are still waiting on another agent, call bus_wait again now.`;
}));
server.tool("bus_peek", "Read and clear your inbox without blocking. Use when you want to check for mail mid-task; use bus_wait when you have nothing else to do.", {}, async () => guarded(async () => {
    const res = await authCall("/peek", {
        agentId: AGENT_ID,
    });
    return renderMessages(res.messages, false);
}));
server.tool("bus_assign_task", "Hand a unit of work to another agent. Creates a tracked task and notifies them. After assigning everything, call bus_wait to sleep until a worker reports back.", {
    to: z.string().describe("Agent id of the worker"),
    title: z.string().describe("Short task title"),
    brief: z
        .string()
        .describe("What to do and what 'done' looks like. Be explicit — the worker has none of your context."),
    context: z
        .string()
        .optional()
        .describe("Files, constraints, prior decisions the worker needs"),
}, async ({ to, title, brief, context }) => guarded(async () => {
    const { task } = await authCall("/task/create", {
        assigner: AGENT_ID,
        assignee: to,
        title,
        brief,
        context: context ?? "",
    });
    return `Assigned ${task.id} to ${to}: "${title}".\nThey have been notified. Call bus_wait to sleep until they report back.`;
}));
server.tool("bus_submit_work", "Report a finished (or revised) task back to whoever assigned it, then wait for their review. Call this when you have actually completed the work.", {
    task_id: z.string().describe("Task id from the assignment message"),
    summary: z.string().describe("What you did, in a few lines"),
    details: z
        .string()
        .optional()
        .describe("Files changed, commands run, test output, caveats"),
}, async ({ task_id, summary, details }) => guarded(async () => {
    const { task } = await authCall("/task/submit", {
        taskId: task_id,
        actor: AGENT_ID,
        summary,
        details: details ?? "",
    });
    return `Submitted ${task.id} (round ${task.round}) to ${task.assigner}.\nCall bus_wait to sleep until their feedback arrives.`;
}));
server.tool("bus_review_work", "Accept a submitted task or send it back with concrete changes. Only the agent who assigned the task should call this.", {
    task_id: z.string().describe("Task id being reviewed"),
    accepted: z
        .boolean()
        .describe("true to close the task, false to request another round"),
    feedback: z
        .string()
        .describe("Your review. If rejecting, list exactly what must change."),
}, async ({ task_id, accepted, feedback }) => guarded(async () => {
    const { task } = await authCall("/task/review", {
        taskId: task_id,
        actor: AGENT_ID,
        accepted,
        feedback,
    });
    return accepted
        ? `Accepted ${task.id}. ${task.assignee} has been notified and is now free.`
        : `Sent ${task.id} back to ${task.assignee} for round ${task.round}.`;
}));
server.tool("bus_task_board", "List tasks on the bus so you can see what is outstanding and who owns it.", {
    mine_only: z
        .boolean()
        .default(true)
        .describe("Only tasks you assigned or were assigned"),
    include_closed: z
        .boolean()
        .default(false)
        .describe("Include accepted and cancelled tasks"),
}, async ({ mine_only, include_closed }) => guarded(async () => {
    const { tasks } = await brokerCall("/task/list", {
        agent: mine_only ? AGENT_ID : null,
        openOnly: !include_closed,
    });
    if (tasks.length === 0)
        return "No matching tasks.";
    return tasks.map(renderTask).join("\n");
}));
server.tool("bus_task_detail", "Full record of one task including every submission and review round.", { task_id: z.string() }, async ({ task_id }) => guarded(async () => {
    const { task } = await brokerCall("/task/get", {
        taskId: task_id,
    });
    const history = task.history
        .map((h) => `  ${new Date(h.ts).toLocaleTimeString()} ${h.actor} ${h.kind} → ${h.state}\n    ${h.note.replace(/\n/g, "\n    ")}`)
        .join("\n");
    return `${renderTask(task)}\n\nBrief:\n${task.brief}\n${task.context ? `\nContext:\n${task.context}\n` : ""}\nHistory:\n${history}`;
}));
// ------------------------------------------------------------- start
async function main() {
    await ensureRegistered().catch((err) => {
        // Don't die: the tools report the error and the session stays usable.
        process.stderr.write(`agent-bus: ${err.message}\n`);
    });
    await server.connect(new StdioServerTransport());
}
main().catch((err) => {
    process.stderr.write(`agent-bus fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
});
//# sourceMappingURL=mcp-server.js.map