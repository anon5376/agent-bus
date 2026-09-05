import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterContext, HarnessInvocation, NormalizedHarnessResult, getHarnessAdapter } from "./adapters.js";
import { ResolvedAgent } from "./config.js";
import {
  BUS_HOME,
  MAX_WAIT_MS,
  Message,
  brokerAlive,
  brokerCall,
  envValue,
  parseExecutionConfig,
  parseOkResponse,
  parsePresenceResponse,
  parseRegisterResponse,
  parseStatusResponse,
  parseTaskEnvelope,
  parseWaitResponse,
} from "./protocol.js";
import { agentTokenPath, readTokenFile } from "./security.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SERVER = join(ROOT, "dist", "mcp-server.js");
const FAKE_HARNESS = join(ROOT, "dist", "fake-harness.js");
const LOG_DIR = join(BUS_HOME, "logs");
const TRANSCRIPT_DIR = join(BUS_HOME, "transcripts");
const SESSION_DIR = join(BUS_HOME, "sessions");

interface SessionRecord {
  sessionId: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  latencyMs: number;
}

export interface ProcessResult {
  code: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

function log(agentId: string, line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  process.stdout.write(stamped + "\n");
  try { appendFileSync(join(LOG_DIR, `${agentId}.log`), stamped + "\n"); } catch { /* logging is best effort */ }
}

function sessionPath(agentId: string): string {
  return join(SESSION_DIR, `${agentId}.json`);
}

function readSession(agentId: string): SessionRecord {
  try {
    const parsed = JSON.parse(readFileSync(sessionPath(agentId), "utf8")) as Partial<SessionRecord>;
    return {
      sessionId: parsed.sessionId ?? null,
      turns: Number(parsed.turns ?? 0),
      inputTokens: Number(parsed.inputTokens ?? 0),
      outputTokens: Number(parsed.outputTokens ?? 0),
      totalTokens: Number(parsed.totalTokens ?? 0),
      costUSD: Number(parsed.costUSD ?? 0),
      latencyMs: Number(parsed.latencyMs ?? 0),
    };
  } catch {
    return { sessionId: null, turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, latencyMs: 0 };
  }
}

function writeSession(agentId: string, session: SessionRecord): void {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(sessionPath(agentId), JSON.stringify(session, null, 2));
}

export function buildSupervisorPrompt(messages: Message[], agent: ResolvedAgent): string {
  const rendered = messages.map((message) => [
    `── from ${message.from} · ${message.type}${message.taskId ? ` · ${message.taskId}` : ""}`,
    message.subject,
    "",
    message.body,
    message.refs.length ? `\nReferences:\n${message.refs.map((ref) => `- ${ref.type}: ${ref.value}`).join("\n")}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");

  return [
    `=== agent-bus: ${messages.length} new message(s) for ${agent.id} ===`,
    `Role: ${agent.role}; model: ${agent.modelDefinition.id}; family: ${agent.modelDefinition.family}; harness: ${agent.harnessDefinition.id}.`,
    `Permissions: filesystem=${agent.permissions.filesystem}, shell=${agent.permissions.shell}, network=${agent.permissions.network}, delegate=${agent.permissions.canDelegate}, review=${agent.permissions.canReview}.`,
    "",
    rendered,
    "",
    "=== end of scoped messages ===",
    "",
    "Do the actual work now. Retrieve only the files or evidence needed for this task.",
    "Use file paths and artifacts for handoff instead of pasting large outputs into messages.",
    "Use bus_submit_work, bus_review_work, bus_send, or bus_assign_task as authorized.",
    "Do NOT call bus_wait: the supervisor owns the blocking wait and will wake you again.",
    "End the turn after reporting the result or question.",
  ].join("\n");
}

function sanitizedEnvironment(agent: ResolvedAgent, additions: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...additions, MCP_TOOL_TIMEOUT: "3600000" };
  if (envValue("QAGENT_ALLOW_API_KEY", "AGENT_BUS_ALLOW_API_KEY") === "1" || !agent.providerDefinition.subscriptionBacked) return env;
  const providerKeys: Record<string, string[]> = {
    anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    openai: ["OPENAI_API_KEY"],
    google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    moonshot: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    xai: ["XAI_API_KEY"],
  };
  for (const key of providerKeys[agent.modelDefinition.provider] ?? []) delete env[key];
  return env;
}

export function retryDelayMs(consecutiveFailures: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, consecutiveFailures - 1));
}

export function resumedUnexpectedSession(pinnedSessionId: string | null, observedSessionId: string | null): boolean {
  return Boolean(pinnedSessionId && observedSessionId && pinnedSessionId !== observedSessionId);
}

export function runHarnessProcess(
  invocation: HarnessInvocation,
  agent: ResolvedAgent,
  workdir: string,
  onSpawn?: (pid: number | null) => void,
): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: workdir,
      env: sanitizedEnvironment(agent, invocation.environment),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    onSpawn?.(child.pid ?? null);
    let output = "";
    let settled = false;
    let timedOut = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onSpawn?.(null);
      resolve({ code, output, durationMs: Date.now() - started, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      } else {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (!settled && child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      }, 3_000).unref();
    }, invocation.timeoutMs);
    child.stdout.on("data", (data) => {
      output += data.toString();
      process.stdout.write(data);
    });
    child.stderr.on("data", (data) => {
      output += data.toString();
      process.stderr.write(data);
    });
    child.on("error", (error) => {
      output += `\nspawn error: ${error.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

function appendTranscript(
  agent: ResolvedAgent,
  turn: number,
  messages: Message[],
  result: NormalizedHarnessResult,
  processResult: ProcessResult,
): void {
  const received = messages.map((message) =>
    `**${message.from} → ${agent.id}** (${message.type}${message.taskId ? ` · ${message.taskId}` : ""})\n${message.subject}\n\n${message.body}`,
  ).join("\n\n");
  const block = [
    "\n---\n",
    `### Turn ${turn} · ${new Date().toLocaleString()}${processResult.code === 0 ? "" : ` · exit ${processResult.code}`}`,
    "",
    "#### Received",
    received,
    "",
    `#### ${agent.id} replied`,
    result.text,
    "",
    `Usage: ${result.usage.totalTokens.toLocaleString()} tokens · ${processResult.durationMs} ms${result.usage.costUSD ? ` · $${result.usage.costUSD.toFixed(4)}` : ""}`,
    "",
  ].join("\n");
  try { appendFileSync(join(TRANSCRIPT_DIR, `${agent.id}.md`), block); } catch { /* best effort */ }
}

function taskMessages(messages: Message[]): Message[] {
  return messages.filter((message) => message.taskId && (message.type === "task" || message.type === "feedback" || message.type === "control"));
}

function cancellationOnly(messages: Message[]): boolean {
  return messages.length > 0 && messages.every((message) => message.type === "control" && message.subject.startsWith("[CANCELLED"));
}

function structuredArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function reportPresence(token: string, agent: ResolvedAgent, workdir: string, childPid: number | null): Promise<void> {
  await brokerCall("/presence", {
    token,
    pid: process.pid,
    childPid,
    workdir,
    cli: agent.harnessDefinition.id,
  }, parsePresenceResponse).catch(() => {});
}

export async function supervise(agentId: string, workdir: string): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  mkdirSync(SESSION_DIR, { recursive: true });
  if (!(await brokerAlive())) throw new Error("broker is not running — start it with: qagent broker");

  const token = readTokenFile(agentTokenPath(agentId));
  if (!token) {
    throw new Error(`no token for ${agentId}; provision it explicitly with: agent-bus provision ${agentId}`);
  }
  const preflight = await brokerCall("/agent/execution-config", { token, id: agentId }, parseExecutionConfig);
  if (!preflight.agent.enabled) throw new Error(`agent ${agentId} is disabled in the running broker configuration`);
  await brokerCall("/register", { token, id: agentId, pid: process.pid, workdir, cli: preflight.agent.harnessDefinition.id }, parseRegisterResponse);
  // Registration establishes verified live-supervisor ownership. Resolve once more
  // from the broker so any edit that raced startup is either rejected by the
  // config-transition guard or reflected in the execution config used here.
  const resolved = await brokerCall("/agent/execution-config", { token, id: agentId }, parseExecutionConfig);
  const agent = resolved.agent;
  if (!agent.enabled) throw new Error(`agent ${agentId} was disabled while the supervisor was starting`);
  await reportPresence(token, agent, workdir, null);

  const adapter = getHarnessAdapter(agent.harnessDefinition.adapter);
  let session = readSession(agentId);
  const pinnedSessionId = agent.resumeSessionId?.trim() || null;
  if (pinnedSessionId && session.sessionId !== pinnedSessionId) {
    session.sessionId = pinnedSessionId;
    writeSession(agentId, session);
  }
  let consecutiveFailures = 0;

  try {
    appendFileSync(
      join(TRANSCRIPT_DIR, `${agentId}.md`),
      `\n\n# Session started ${new Date().toLocaleString()} — ${agent.id} (${agent.role}, ${agent.modelDefinition.id}, ${agent.harnessDefinition.id})\n`,
    );
  } catch { /* best effort */ }
  log(agentId, `supervising ${agent.id} via ${agent.harnessDefinition.id} in ${workdir}`);

  for (;;) {
    await brokerCall("/status", { token, status: "waiting" }, parseStatusResponse);
    const response = await brokerCall(
      "/wait",
      { token, timeoutMs: MAX_WAIT_MS, reason: "supervisor holds the wait" },
      parseWaitResponse,
      MAX_WAIT_MS + 15_000,
    ).catch((error) => {
      log(agentId, `broker wait failed: ${error.message}`);
      return { messages: [] as Message[], timedOut: true };
    });
    if (!response.messages.length) continue;
    if (cancellationOnly(response.messages)) {
      log(agentId, `received cancellation control; no model turn started`);
      continue;
    }

    const relevantTasks = taskMessages(response.messages).filter((message) => !message.subject.startsWith("[CANCELLED"));
    for (const message of relevantTasks) {
      if (message.taskId && (message.type === "task" || message.subject.startsWith("[RETRY") || message.subject.startsWith("[REROUTED"))) {
        await brokerCall("/task/start", { token, taskId: message.taskId }, parseTaskEnvelope).catch(() => {});
      }
    }
    await brokerCall("/status", { token, status: "working" }, parseStatusResponse);
    const prompt = buildSupervisorPrompt(response.messages, agent);
    const context: AdapterContext = {
      agent,
      prompt,
      sessionId: session.sessionId,
      pinnedSessionId,
      workdir,
      mcpServerPath: MCP_SERVER,
      fakeHarnessPath: FAKE_HARNESS,
      busEnvironment: { AGENT_TOKEN: token, QAGENT_BLOCK_SEC: agent.harnessDefinition.id === "claude" ? "900" : "240", AGENT_BUS_BLOCK_SEC: agent.harnessDefinition.id === "claude" ? "900" : "240" },
    };
    await adapter.prepare?.(context);
    const invocation = adapter.build(context);
    const processResult = await runHarnessProcess(invocation, agent, workdir, (childPid) => {
      void reportPresence(token, agent, workdir, childPid);
    });
    const normalized = adapter.parse(processResult.output, processResult.code);
    const sessionMismatch = resumedUnexpectedSession(pinnedSessionId, normalized.sessionId);
    session.turns += 1;
    session.inputTokens += normalized.usage.inputTokens;
    session.outputTokens += normalized.usage.outputTokens;
    session.totalTokens += normalized.usage.totalTokens;
    session.costUSD += normalized.usage.costUSD;
    session.latencyMs += processResult.durationMs;
    if (pinnedSessionId) session.sessionId = pinnedSessionId;
    else if (normalized.sessionId) session.sessionId = normalized.sessionId;
    writeSession(agentId, session);
    appendTranscript(agent, session.turns, response.messages, normalized, processResult);
    await brokerCall("/usage", { token, ...session }, parseOkResponse).catch(() => {});

    const failed = processResult.code !== 0 || processResult.timedOut || normalized.malformed || sessionMismatch;
    if (failed) {
      consecutiveFailures += 1;
      const error = processResult.timedOut
        ? `harness timed out after ${processResult.durationMs} ms`
        : sessionMismatch
          ? `harness resumed unexpected session ${normalized.sessionId}; expected ${pinnedSessionId}`
          : normalized.malformed
            ? "harness returned malformed output"
            : `harness exited ${processResult.code}`;
      for (const message of relevantTasks) {
        if (!message.taskId) continue;
        await brokerCall("/task/failure", {
          token,
          taskId: message.taskId,
          error,
          exitCode: processResult.code,
          malformed: normalized.malformed,
        }, parseTaskEnvelope).catch((brokerError) => log(agentId, `failure report rejected: ${brokerError.message}`));
      }
      const delay = retryDelayMs(consecutiveFailures);
      log(agentId, `${error}; broker owns retry/reroute policy; backing off ${delay / 1000}s`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      continue;
    }

    consecutiveFailures = 0;
    if (invocation.autoReport) {
      const structured = normalized.structured ?? {};
      for (const message of relevantTasks) {
        if (!message.taskId || message.type === "feedback" && message.subject.startsWith("[REVIEW")) continue;
        await brokerCall("/task/submit", {
          token,
          taskId: message.taskId,
          summary: normalized.text.slice(0, 20_000),
          details: "auto-submitted by a harness adapter without native bus tool calls",
          changedFiles: structuredArray(structured.changedFiles),
          artifacts: structuredArray(structured.artifacts),
          validation: structuredArray(structured.validation),
          inputTokens: normalized.usage.inputTokens,
          outputTokens: normalized.usage.outputTokens,
          totalTokens: normalized.usage.totalTokens,
          costUSD: normalized.usage.costUSD,
        }, parseTaskEnvelope).catch((error) => log(agentId, `auto-submit failed for ${message.taskId}: ${error.message}`));
      }
    }
    log(agentId, `turn complete in ${processResult.durationMs} ms`);
  }
}
