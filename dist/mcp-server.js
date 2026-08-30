#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BUS_HOME, DEFAULT_BLOCK_MS, MAX_BLOCK_MS, MAX_WAIT_MS, brokerAlive, brokerCall, parsePeekResponse, parseRegisterResponse, parseRosterResponse, parseRoutePreview, parseSendResponse, parseStatusResponse, parseTaskEnvelope, parseTaskGetResponse, parseTaskListResponse, parseWaitResponse, } from "./protocol.js";
const AGENT_ID = process.env.AGENT_ID;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
if (!AGENT_ID || !AGENT_TOKEN) {
    process.stderr.write("agent-bus: AGENT_ID and AGENT_TOKEN are required. Provision through `agent-bus provision <id>`.\n");
    process.exit(1);
}
const AGENT_ROLE = process.env.AGENT_ROLE ?? "worker";
const AGENT_MODEL = process.env.AGENT_MODEL ?? "unknown";
const DEFAULT_BLOCK_SEC = DEFAULT_BLOCK_MS / 1000;
async function ensureBroker() {
    if (await brokerAlive())
        return;
    mkdirSync(BUS_HOME, { recursive: true });
    const cli = join(fileURLToPath(new URL(".", import.meta.url)), "cli.js");
    const log = openSync(join(BUS_HOME, "broker.log"), "a");
    spawn(process.execPath, [cli, "broker"], { detached: true, stdio: ["ignore", log, log] }).unref();
    for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (await brokerAlive())
            return;
    }
    throw new Error(`could not reach the broker; see ${join(BUS_HOME, "broker.log")}`);
}
let registered = false;
async function ensureRegistered() {
    if (registered)
        return;
    await ensureBroker();
    await brokerCall("/register", { token: AGENT_TOKEN, id: AGENT_ID }, parseRegisterResponse);
    registered = true;
}
function authCall(path, payload, parse, timeoutMs) {
    return brokerCall(path, { ...payload, token: AGENT_TOKEN }, parse, timeoutMs);
}
function text(value) {
    return { content: [{ type: "text", text: value }] };
}
async function guarded(fn) {
    try {
        await ensureRegistered();
        return text(await fn());
    }
    catch (error) {
        return {
            content: [{ type: "text", text: `agent-bus error: ${error.message}` }],
            isError: true,
        };
    }
}
function ago(ts) {
    const seconds = Math.round((Date.now() - ts) / 1000);
    if (seconds < 60)
        return `${seconds}s ago`;
    if (seconds < 3600)
        return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
}
function renderMessage(message) {
    return [
        `── from ${message.from} · ${message.type}${message.taskId ? ` · ${message.taskId}` : ""} · ${ago(message.ts)}`,
        message.subject,
        "",
        message.body,
        message.refs.length ? `\nReferences:\n${message.refs.map((ref) => `- ${ref.type}: ${ref.value}`).join("\n")}` : "",
    ].filter(Boolean).join("\n");
}
function renderMessages(messages, timedOut) {
    if (!messages.length)
        return timedOut
            ? "Nothing arrived before the timeout. Call bus_wait again if work is still outstanding."
            : "Inbox is empty.";
    return `${messages.length} message(s):\n\n${messages.map(renderMessage).join("\n\n")}`;
}
function renderTask(task) {
    const deps = task.dependencyIds.length ? ` · deps ${task.dependencyIds.join(",")}` : "";
    const route = task.routing?.selectedAgentId ? ` · routed ${task.routing.selectedAgentId}` : "";
    return `${task.id} [${task.state}] ${task.assigner} → ${task.assignee || "unassigned"} · ${task.role} · c${task.complexity} · r${task.round}${deps}${route} · ${task.title}`;
}
async function inferredParentTaskId() {
    const { roster } = await brokerCall("/roster", {}, parseRosterResponse);
    return roster.find((agent) => agent.id === AGENT_ID)?.currentTaskId ?? null;
}
const contextRefSchema = z.object({
    type: z.enum(["path", "artifact", "summary", "commit", "url"]),
    value: z.string(),
    description: z.string().optional(),
    digest: z.string().optional(),
});
const validationRequirementSchema = z.object({
    id: z.string().optional(),
    description: z.string(),
    command: z.string().optional(),
    required: z.boolean().default(true),
});
const validationObservationSchema = z.object({
    requirementId: z.string().optional(),
    command: z.string().optional(),
    passed: z.boolean(),
    summary: z.string(),
    artifact: z.string().optional(),
});
const server = new McpServer({ name: "agent-bus", version: "0.2.0" });
server.tool("bus_whoami", "Show your broker-enforced identity, authority, permissions, model/provider/harness and the live roster.", {}, async () => guarded(async () => {
    const { roster } = await brokerCall("/roster", {}, parseRosterResponse);
    const me = roster.find((agent) => agent.id === AGENT_ID);
    const lines = roster.map((agent) => `  ${agent.id === AGENT_ID ? "*" : " "} ${agent.id} (${agent.role}; ${agent.family}/${agent.model} via ${agent.harness}) — ${agent.status}` +
        `${agent.currentTaskId ? ` on ${agent.currentTaskId}` : ""}${agent.pendingMessages ? ` · ${agent.pendingMessages} unread` : ""}`);
    return [
        `You are ${AGENT_ID} (role ${AGENT_ROLE}, model ${AGENT_MODEL}).`,
        `Authority: ${me?.authority ?? "unknown"}. Permissions: ${JSON.stringify(me?.permissions ?? {})}.`,
        "",
        "Roster:",
        ...lines,
    ].join("\n");
}));
server.tool("bus_send", "Send a concise question, answer, or status note. Use context references rather than pasting large artifacts.", {
    to: z.string().describe("Recipient id, comma-separated ids, or '*'"),
    subject: z.string(),
    body: z.string(),
    type: z.enum(["info", "question", "answer"]).default("info"),
    task_id: z.string().optional(),
    refs: z.array(contextRefSchema).optional(),
}, async ({ to, subject, body, type, task_id, refs }) => guarded(async () => {
    const response = await authCall("/send", { to, subject, body, type, taskId: task_id, refs: refs ?? [] }, parseSendResponse);
    const delivered = response.delivered.map((item) => item.to).join(", ") || "nobody";
    const unknown = response.unknownRecipients?.length ? `; unknown: ${response.unknownRecipients.join(", ")}` : "";
    return `Delivered to ${delivered}${unknown}.`;
}));
server.tool("bus_wait", "Block without consuming model tokens until mail arrives. Do not use under a supervisor prompt; the supervisor owns the wait there.", {
    timeout_sec: z.number().int().min(1).max(MAX_BLOCK_MS / 1000).optional(),
    reason: z.string().optional(),
}, async ({ timeout_sec, reason }) => guarded(async () => {
    const totalMs = Math.min((timeout_sec ?? DEFAULT_BLOCK_SEC) * 1000, MAX_BLOCK_MS);
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
        const chunk = Math.min(MAX_WAIT_MS, deadline - Date.now());
        const response = await authCall("/wait", { timeoutMs: chunk, reason: reason ?? "" }, parseWaitResponse, chunk + 15_000);
        if (response.messages.length) {
            await authCall("/status", { status: "idle" }, parseStatusResponse);
            return renderMessages(response.messages, false);
        }
    }
    return renderMessages([], true);
}));
server.tool("bus_peek", "Read and drain your inbox without blocking.", {}, async () => guarded(async () => {
    const response = await authCall("/peek", {}, parsePeekResponse);
    return renderMessages(response.messages, false);
}));
server.tool("bus_route_task", "Preview the deterministic routing decision and all candidate rejection reasons before creating a task.", {
    role: z.string(),
    complexity: z.number().int().min(1).max(5),
    context_tokens: z.number().int().min(0).default(8000),
    write_access: z.boolean().default(false),
    shell: z.boolean().default(false),
    network: z.boolean().default(false),
    families: z.array(z.string()).optional(),
    providers: z.array(z.string()).optional(),
    exact_model: z.string().optional(),
    exact_agent: z.string().optional(),
    implementation_family: z.string().optional(),
}, async (input) => guarded(async () => {
    const { decision } = await brokerCall("/route/preview", {
        role: input.role,
        complexity: input.complexity,
        contextTokens: input.context_tokens,
        writeAccess: input.write_access,
        shell: input.shell,
        network: input.network,
        families: input.families,
        providers: input.providers,
        exactModel: input.exact_model,
        exactAgent: input.exact_agent,
        implementationFamily: input.implementation_family,
    }, parseRoutePreview);
    return [
        decision.reason,
        "",
        ...decision.candidates.map((candidate) => `${candidate.eligible ? "ELIGIBLE" : "REJECTED"} ${candidate.agentId} score=${candidate.score.toFixed(3)}${candidate.rejectedBy.length ? ` — ${candidate.rejectedBy.join("; ")}` : ""}`),
    ].join("\n");
}));
server.tool("bus_assign_task", "Create a dependency-aware child task. Omit `to` to let the router choose. The current task is used as parent unless explicitly overridden.", {
    to: z.string().optional(),
    title: z.string(),
    brief: z.string().describe("Scoped objective and definition of done; assume the worker has no other context"),
    role: z.string().default("implementation"),
    complexity: z.number().int().min(1).max(5).default(3),
    context: z.string().optional(),
    context_refs: z.array(contextRefSchema).optional(),
    parent_task_id: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    path_scopes: z.array(z.string()).optional(),
    read_only: z.boolean().optional(),
    estimated_context_tokens: z.number().int().min(0).optional(),
    validation_requirements: z.array(validationRequirementSchema).optional(),
    review_required: z.boolean().optional(),
    families: z.array(z.string()).optional(),
    providers: z.array(z.string()).optional(),
    exact_model: z.string().optional(),
}, async (input) => guarded(async () => {
    const parentTaskId = input.parent_task_id ?? await inferredParentTaskId();
    const { task } = await authCall("/task/create", {
        assignee: input.to,
        title: input.title,
        brief: input.brief,
        role: input.role,
        complexity: input.complexity,
        context: input.context ?? "",
        contextRefs: input.context_refs ?? [],
        parentTaskId,
        dependencies: input.dependencies ?? [],
        pathScopes: input.path_scopes ?? [],
        readOnly: input.read_only,
        estimatedContextTokens: input.estimated_context_tokens,
        validationRequirements: input.validation_requirements ?? [],
        reviewRequired: input.review_required,
        families: input.families ?? [],
        providers: input.providers ?? [],
        exactModel: input.exact_model,
    }, parseTaskEnvelope);
    return `${renderTask(task)}\nRouting: ${task.routing?.reason ?? "not available"}.`;
}));
server.tool("bus_submit_work", "Submit structured work: concise summary, changed files/artifacts and reproducible validation observations.", {
    task_id: z.string(),
    summary: z.string(),
    details: z.string().optional(),
    changed_files: z.array(z.string()).optional(),
    artifacts: z.array(contextRefSchema).optional(),
    validation: z.array(validationObservationSchema).optional(),
}, async ({ task_id, summary, details, changed_files, artifacts, validation }) => guarded(async () => {
    const { task } = await authCall("/task/submit", {
        taskId: task_id,
        summary,
        details: details ?? "",
        changedFiles: changed_files ?? [],
        artifacts: artifacts ?? [],
        validation: validation ?? [],
    }, parseTaskEnvelope);
    return `Submitted ${task.id} round ${task.round}. Reviewer: ${task.reviewerId ?? task.assigner}.`;
}));
server.tool("bus_review_work", "Accept submitted work or request a bounded revision. Broker authorization and independent-family rules are enforced.", {
    task_id: z.string(),
    accepted: z.boolean(),
    feedback: z.string(),
}, async ({ task_id, accepted, feedback }) => guarded(async () => {
    const { task } = await authCall("/task/review", { taskId: task_id, accepted, feedback }, parseTaskEnvelope);
    return accepted ? `Accepted ${task.id}.` : `Requested changes on ${task.id}; round ${task.round}.`;
}));
server.tool("bus_task_board", "List the durable task graph, including blocked dependencies and routing assignments.", {
    mine_only: z.boolean().default(true),
    include_closed: z.boolean().default(false),
    run_id: z.string().optional(),
}, async ({ mine_only, include_closed, run_id }) => guarded(async () => {
    const { tasks } = await brokerCall("/task/list", {
        agent: mine_only ? AGENT_ID : null,
        openOnly: !include_closed,
        runId: run_id,
    }, parseTaskListResponse);
    return tasks.length ? tasks.map(renderTask).join("\n") : "No matching tasks.";
}));
server.tool("bus_task_detail", "Show one task's graph links, scoped context, routing rationale, result, review and complete retry history.", { task_id: z.string() }, async ({ task_id }) => guarded(async () => {
    const { task, routingHistory } = await brokerCall("/task/get", { taskId: task_id }, parseTaskGetResponse);
    const history = task.history.map((event) => `  ${new Date(event.ts).toISOString()} ${event.actor} ${event.kind} → ${event.state}\n    ${event.note.replace(/\n/g, "\n    ")}`).join("\n");
    return [
        renderTask(task),
        `Parent: ${task.parentTaskId ?? "none"}; children: ${task.childTaskIds.join(", ") || "none"}; dependencies: ${task.dependencyIds.join(", ") || "none"}.`,
        `Routing: ${task.routing?.reason ?? "none"}.`,
        routingHistory.length > 1 ? `Routing attempts: ${routingHistory.map((decision) => decision.reason).join(" | ")}` : "",
        `\nBrief:\n${task.brief}`,
        task.context ? `\nContext summary:\n${task.context}` : "",
        task.result ? `\nResult:\n${task.result.summary}` : "",
        task.review ? `\nReview by ${task.review.reviewer}: ${task.review.accepted ? "accepted" : "changes requested"}\n${task.review.feedback}` : "",
        `\nHistory:\n${history}`,
    ].filter(Boolean).join("\n");
}));
async function main() {
    await ensureRegistered().catch((error) => process.stderr.write(`agent-bus: ${error.message}\n`));
    await server.connect(new StdioServerTransport());
}
main().catch((error) => {
    process.stderr.write(`agent-bus fatal: ${error?.stack ?? error}\n`);
    process.exit(1);
});
//# sourceMappingURL=mcp-server.js.map