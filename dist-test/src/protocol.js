import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
export const BUS_HOME = process.env.AGENT_BUS_HOME ?? join(homedir(), ".agent-bus");
export const BUS_PORT = Number(process.env.AGENT_BUS_PORT ?? 11511);
export const BUS_HOST = process.env.AGENT_BUS_HOST ?? "127.0.0.1";
export const BUS_URL = process.env.AGENT_BUS_URL ?? `http://${BUS_HOST}:${BUS_PORT}`;
export const MAX_WAIT_MS = 240_000;
export const DEFAULT_WAIT_MS = 180_000;
export const DEFAULT_BLOCK_MS = Number(process.env.AGENT_BUS_BLOCK_SEC ?? 900) * 1000;
export const MAX_BLOCK_MS = 3_600_000;
export const STALE_AGENT_MS = 15 * 60_000;
export class ProtocolError extends Error {
    field;
    constructor(field, endpoint) {
        super(endpoint
            ? `malformed broker ${endpoint} response: missing field ${field}`
            : `malformed broker response: missing field ${field}`);
        this.field = field;
        this.name = "ProtocolError";
    }
}
const AGENT_STATUSES = ["idle", "working", "waiting", "offline", "failed"];
const TASK_STATES = ["blocked", "ready", "assigned", "in_progress", "submitted", "changes_requested", "accepted", "failed", "cancelled"];
const RUN_STATUSES = ["active", "completed", "failed", "cancelled"];
const AUTHORITIES = ["operator", "manager", "worker"];
const MESSAGE_TYPES = ["task", "result", "feedback", "question", "answer", "info", "control"];
const CONTEXT_TYPES = ["path", "artifact", "summary", "commit", "url"];
const TASK_EVENT_KINDS = ["created", "blocked", "assigned", "started", "submitted", "reviewed", "retry", "rerouted", "failed", "cancelled", "dependency_released"];
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function fail(field) {
    throw new ProtocolError(field);
}
function rec(value, field) {
    if (!isRecord(value))
        fail(field);
    return value;
}
function str(value, field) {
    if (typeof value !== "string")
        fail(field);
    return value;
}
function num(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value))
        fail(field);
    return value;
}
function bool(value, field) {
    if (typeof value !== "boolean")
        fail(field);
    return value;
}
function nul(value, field, inner) {
    if (value === null)
        return null;
    return inner(value, field);
}
function arr(value, field, item) {
    if (!Array.isArray(value))
        fail(field);
    return value.map((entry, index) => item(entry, `${field}[${index}]`));
}
function oneOf(value, field, allowed) {
    if (typeof value !== "string" || !allowed.includes(value))
        fail(field);
    return value;
}
export function emptyUsage() {
    return { turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, latencyMs: 0 };
}
/** Coerce persisted or legacy usage blobs onto the wire UsageMetrics shape. Producer-side only. */
export function normalizeUsageMetrics(value) {
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
export function parseUsageMetrics(value, field = "usage") {
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
function parsePermissions(value, field) {
    const row = rec(value, field);
    const filesystem = str(row.filesystem, `${field}.filesystem`);
    if (filesystem !== "none" && filesystem !== "read" && filesystem !== "write")
        fail(`${field}.filesystem`);
    return {
        canDelegate: bool(row.canDelegate, `${field}.canDelegate`),
        canReview: bool(row.canReview, `${field}.canReview`),
        filesystem,
        shell: bool(row.shell, `${field}.shell`),
        network: bool(row.network, `${field}.network`),
        maxDelegationDepth: num(row.maxDelegationDepth, `${field}.maxDelegationDepth`),
        allowedPaths: row.allowedPaths === undefined ? undefined : arr(row.allowedPaths, `${field}.allowedPaths`, str),
    };
}
export function parseRosterEntry(value, field = "roster[]") {
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
function parseContextReference(value, field) {
    const row = rec(value, field);
    return {
        type: oneOf(row.type, `${field}.type`, CONTEXT_TYPES),
        value: str(row.value, `${field}.value`),
        description: row.description === undefined ? undefined : str(row.description, `${field}.description`),
        digest: row.digest === undefined ? undefined : str(row.digest, `${field}.digest`),
    };
}
function parseMessage(value, field) {
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
function parseRun(value, field) {
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
function parseCandidate(value, field) {
    const row = rec(value, field);
    const componentsRow = rec(row.components, `${field}.components`);
    const components = {};
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
export function parseRoutingDecision(value, field = "decision") {
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
function parseTaskEvent(value, field) {
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
function parseValidationRequirement(value, field) {
    const row = rec(value, field);
    return {
        id: str(row.id, `${field}.id`),
        description: str(row.description, `${field}.description`),
        command: row.command === undefined ? undefined : str(row.command, `${field}.command`),
        required: bool(row.required, `${field}.required`),
    };
}
function parseTaskResult(value, field) {
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
function parseTaskReview(value, field) {
    const row = rec(value, field);
    return {
        reviewer: str(row.reviewer, `${field}.reviewer`),
        reviewerFamily: nul(row.reviewerFamily, `${field}.reviewerFamily`, str),
        accepted: bool(row.accepted, `${field}.accepted`),
        feedback: str(row.feedback, `${field}.feedback`),
        reviewedAt: num(row.reviewedAt, `${field}.reviewedAt`),
    };
}
export function parseTask(value, field = "task") {
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
function parseTelemetry(value, field) {
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
function parsePathLease(value, field) {
    const row = rec(value, field);
    return {
        taskId: str(row.taskId, `${field}.taskId`),
        runId: str(row.runId, `${field}.runId`),
        path: str(row.path, `${field}.path`),
        createdAt: num(row.createdAt, `${field}.createdAt`),
    };
}
function parseConfigIdentity(value, field) {
    const row = rec(value, field);
    return {
        path: nul(row.path, `${field}.path`, str),
        digest: str(row.digest, `${field}.digest`),
    };
}
export function parseBusState(value) {
    const row = rec(value, "(root)");
    for (const key of ["roster", "tasks", "runs", "waiting", "telemetry", "pathLeases", "revision", "configIdentity"]) {
        if (!(key in row))
            fail(key);
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
export function parseBusSnapshot(value) {
    const state = parseBusState(value);
    const row = rec(value, "(root)");
    return {
        ...state,
        messages: arr(row.messages, "messages", parseMessage),
        seq: num(row.seq, "seq"),
        brokerPid: num(row.brokerPid, "brokerPid"),
    };
}
export function parseRosterResponse(value) {
    const row = rec(value, "(root)");
    return { roster: arr(row.roster, "roster", parseRosterEntry) };
}
export function parseRoutePreview(value) {
    const row = rec(value, "(root)");
    return { decision: parseRoutingDecision(row.decision, "decision") };
}
export function parseSendResponse(value) {
    const row = rec(value, "(root)");
    return {
        delivered: arr(row.delivered, "delivered", (entry, field) => {
            const item = rec(entry, field);
            return { id: str(item.id, `${field}.id`), to: str(item.to, `${field}.to`) };
        }),
        unknownRecipients: arr(row.unknownRecipients, "unknownRecipients", str),
    };
}
export function parseProvisionResponse(value) {
    const row = rec(value, "(root)");
    return {
        id: row.id === undefined ? undefined : str(row.id, "id"),
        provisioned: row.provisioned === undefined ? undefined : bool(row.provisioned, "provisioned"),
        rotated: row.rotated === undefined ? undefined : bool(row.rotated, "rotated"),
        token: nul(row.token, "token", str),
        message: row.message === undefined ? undefined : str(row.message, "message"),
    };
}
export function parseRunCreateResponse(value) {
    const row = rec(value, "(root)");
    return { run: parseRun(row.run, "run"), rootTask: parseTask(row.rootTask, "rootTask") };
}
export function parseWaitResponse(value) {
    const row = rec(value, "(root)");
    return {
        messages: arr(row.messages, "messages", parseMessage),
        timedOut: bool(row.timedOut, "timedOut"),
    };
}
export function parsePeekResponse(value) {
    const row = rec(value, "(root)");
    return {
        messages: arr(row.messages, "messages", parseMessage),
        timedOut: row.timedOut === undefined ? undefined : bool(row.timedOut, "timedOut"),
    };
}
export function parseTaskEnvelope(value) {
    const row = rec(value, "(root)");
    return { task: parseTask(row.task, "task") };
}
export function parseTaskListResponse(value) {
    const row = rec(value, "(root)");
    return { tasks: arr(row.tasks, "tasks", parseTask) };
}
export function parseTaskGetResponse(value) {
    const row = rec(value, "(root)");
    return {
        task: parseTask(row.task, "task"),
        routingHistory: arr(row.routingHistory, "routingHistory", parseRoutingDecision),
    };
}
function parseAgent(value, field) {
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
export function parseRegisterResponse(value) {
    const row = rec(value, "(root)");
    return {
        agent: parseAgent(row.agent, "agent"),
        pendingMessages: num(row.pendingMessages, "pendingMessages"),
        roster: arr(row.roster, "roster", parseRosterEntry),
    };
}
export function parseStatusResponse(value) {
    const row = rec(value, "(root)");
    return { ok: bool(row.ok, "ok"), status: oneOf(row.status, "status", AGENT_STATUSES) };
}
export function parsePresenceResponse(value) {
    const row = rec(value, "(root)");
    return { ok: bool(row.ok, "ok"), supervisorVerified: bool(row.supervisorVerified, "supervisorVerified") };
}
export function parseOkResponse(value) {
    const row = rec(value, "(root)");
    return { ok: bool(row.ok, "ok") };
}
export function parseExecutionConfig(value) {
    const row = rec(value, "(root)");
    const agent = rec(row.agent, "agent");
    str(agent.id, "agent.id");
    bool(agent.enabled, "agent.enabled");
    rec(agent.harnessDefinition, "agent.harnessDefinition");
    str(agent.harnessDefinition.id, "agent.harnessDefinition.id");
    str(agent.harnessDefinition.adapter, "agent.harnessDefinition.adapter");
    rec(agent.modelDefinition, "agent.modelDefinition");
    return { agent: agent, configIdentity: parseConfigIdentity(row.configIdentity, "configIdentity") };
}
export function parseStateWaitResponse(value) {
    const row = rec(value, "(root)");
    return {
        revision: num(row.revision, "revision"),
        changed: row.changed === undefined ? undefined : bool(row.changed, "changed"),
    };
}
export function newId(prefix) {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
export async function brokerCall(path, payload, parse, timeoutMs = 20_000) {
    const res = await fetch(`${BUS_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`broker ${path} -> ${res.status}: ${text.slice(0, 800)}`);
    let json;
    try {
        json = text ? JSON.parse(text) : {};
    }
    catch {
        throw new ProtocolError("JSON", path);
    }
    try {
        return parse(json);
    }
    catch (error) {
        if (error instanceof ProtocolError)
            throw new ProtocolError(error.field, path);
        throw error;
    }
}
export async function brokerAlive() {
    try {
        const res = await fetch(`${BUS_URL}/health`, { signal: AbortSignal.timeout(1200) });
        return res.ok;
    }
    catch {
        return false;
    }
}
