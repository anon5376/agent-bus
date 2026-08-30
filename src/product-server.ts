import { randomBytes } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverHarnessModels, probeHarness } from "./adapters.js";
import {
  BusConfig,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  resolveAgent,
} from "./config.js";
import { stageAgentUpdate, stageConstraintsPatch, stageProviderEnabled, supervisedExecutionConflicts } from "./config-transitions.js";
import { verifiedSupervisorProcess } from "./instance-processes.js";
import { addOrUpdateIntegration, IntegrationInput } from "./integrations.js";
import { Agent, BUS_HOME, BUS_HOST, BUS_PORT, MAX_WAIT_MS, Run, Task } from "./protocol.js";
import { productArtifactManifest, PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";
import {
  OPERATOR_TOKEN_PATH,
  agentTokenPath,
  hashToken,
  readTokenFile,
  writePrivateToken,
} from "./security.js";
import { serveDashboardStatic } from "./static-web.js";
import { BrokerOptions, BrokerService } from "./broker.js";
import { launchSupervisor } from "./supervisor-launch.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = join(ROOT, "cli.js");
const DEFAULT_STATIC_ROOT = join(ROOT, "dist", "web");
const PROJECT_META_KEY = "dashboard.projects";
const SETUP_META_KEY = "dashboard.setup";
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_LOGIN_TICKET_TTL_MS = 60_000;

export const DASHBOARD_URL = `http://${BUS_HOST}:${BUS_PORT}`;

export interface ProductServerOptions extends BrokerOptions {
  staticRoot?: string;
  sessionTtlMs?: number;
  loginTicketTtlMs?: number;
}

export interface ProductServerHandle {
  service: BrokerService;
  server: Server;
  host: string;
  port: number;
  url: string;
  buildId: string;
  close(): Promise<void>;
}

interface ProjectRecord {
  path: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
}

class BrowserAuthError extends Error {}

class BrowserSessions {
  private readonly tickets = new Map<string, number>();
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly sessionTtlMs: number,
    private readonly ticketTtlMs: number,
  ) {}

  private prune(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.tickets) if (expiresAt <= now) this.tickets.delete(key);
    for (const [key, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(key);
  }

  issue(): { ticket: string; expiresInSeconds: number } {
    this.prune();
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, Date.now() + this.ticketTtlMs);
    return { ticket, expiresInSeconds: Math.ceil(this.ticketTtlMs / 1000) };
  }

  exchange(ticket: string): string {
    this.prune();
    const expiresAt = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!expiresAt || expiresAt <= Date.now()) throw new BrowserAuthError("login ticket is invalid or expired");
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(session, Date.now() + this.sessionTtlMs);
    return session;
  }

  valid(session: string): boolean {
    this.prune();
    const expiresAt = this.sessions.get(session);
    return Boolean(expiresAt && expiresAt > Date.now());
  }

  revoke(session: string): void {
    this.sessions.delete(session);
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const piece of (req.headers.cookie ?? "").split(";")) {
    const index = piece.indexOf("=");
    if (index <= 0) continue;
    out[piece.slice(0, index).trim()] = decodeURIComponent(piece.slice(index + 1).trim());
  }
  return out;
}

function requireSession(req: IncomingMessage, sessions: BrowserSessions): string {
  const session = cookies(req).agent_bus_session ?? "";
  if (!session || !sessions.valid(session)) {
    throw new BrowserAuthError("dashboard session missing or expired; run `agent-bus open`");
  }
  return session;
}

function requireSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) throw new BrowserAuthError("same-origin request required");
  if (origin !== `http://${host}` && origin !== `https://${host}`) {
    throw new BrowserAuthError("cross-origin dashboard request rejected");
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("request body exceeds 2 MiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveBody({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`invalid JSON body: ${(error as Error).message}`));
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function errorStatus(error: unknown): number {
  if (error instanceof BrowserAuthError) return 401;
  const message = String((error as Error)?.message ?? error);
  if (message.startsWith("unauthorized")) return 401;
  if (message.includes("not authorized") || message.startsWith("only ")) return 403;
  if (message.startsWith("no route") || message.startsWith("unknown run") || message.startsWith("unknown task")) return 404;
  if (message.includes("already") || message.includes("not submitted") || message.includes("not eligible") || message.includes("stop it before editing") || message.includes("ownership cannot be verified")) return 409;
  return 400;
}

function operatorToken(path: string): string {
  const token = readTokenFile(path);
  if (!token) throw new Error(`operator token missing at ${path}`);
  return token;
}

function verifyOperatorToken(service: BrokerService, token: string): void {
  const identity = token ? service.store.identityByTokenHash(hashToken(token)) : null;
  if (!identity || identity.authority !== "operator") throw new BrowserAuthError("invalid operator credential");
}

function verifiedLiveSupervisor(service: BrokerService, id: string) {
  const meta = service.supervisorMeta.get(id);
  if (!meta) return null;
  const verified = verifiedSupervisorProcess({
    busHome: BUS_HOME,
    port: service.instancePort,
    applicationRoot: ROOT,
    agentId: id,
    pid: meta.pid,
  });
  if (verified) return meta;
  service.supervisorMeta.delete(id);
  const agent = service.agents.get(id);
  if (agent) {
    agent.status = "offline";
    service.store.saveAgent(agent);
  }
  return null;
}

function pruneStaleSupervisors(service: BrokerService): void {
  for (const id of [...service.supervisorMeta.keys()]) verifiedLiveSupervisor(service, id);
}

function assertSafeConfigTransition(service: BrokerService, candidate: BusConfig): void {
  const conflicts = supervisedExecutionConflicts(service.config, candidate, service.supervisorMeta.keys());
  if (conflicts.length) {
    throw new Error(`configuration transition changes supervised agent execution (${conflicts.map((conflict) => conflict.agentId).join(", ")}); stop it before editing configuration`);
  }
}

function applyConfig(service: BrokerService, config: BusConfig): void {
  Object.assign(service.config, config);
  const configured = new Set(Object.keys(config.agents));
  for (const [id, definition] of Object.entries(config.agents)) {
    const resolved = resolveAgent(config, id);
    const previous = service.agents.get(id);
    const agent: Agent = {
      id,
      role: definition.role,
      model: resolved.modelDefinition.id,
      family: resolved.modelDefinition.family,
      provider: resolved.modelDefinition.provider,
      harness: resolved.harnessDefinition.id,
      description: definition.description,
      auth: resolved.providerDefinition.authSource,
      authority: definition.authority,
      permissions: definition.permissions,
      status: previous?.status ?? "offline",
      currentTaskId: previous?.currentTaskId ?? null,
      registeredAt: previous?.registeredAt ?? 0,
      lastSeen: previous?.lastSeen ?? 0,
    };
    service.agents.set(id, agent);
    service.store.saveAgent(agent);
    const identity = service.store.identityById(id);
    if (identity) service.store.upsertIdentity({ ...identity, authority: definition.authority, permissions: definition.permissions, updatedAt: Date.now() });
  }
  for (const [id, agent] of service.agents) {
    if (id !== "operator" && !configured.has(id)) {
      agent.status = "offline";
      service.store.saveAgent(agent);
    }
  }
}
function storedProjects(service: BrokerService): ProjectRecord[] {
  try { return JSON.parse(service.store.getMeta(PROJECT_META_KEY) ?? "[]") as ProjectRecord[]; }
  catch { return []; }
}

function projects(service: BrokerService): ProjectRecord[] {
  const map = new Map<string, ProjectRecord>();
  for (const project of storedProjects(service)) map.set(project.path, project);
  for (const run of service.runs.values()) {
    const previous = map.get(run.projectRoot);
    map.set(run.projectRoot, {
      path: run.projectRoot,
      name: previous?.name ?? (basename(run.projectRoot) || run.projectRoot),
      createdAt: previous?.createdAt ?? run.createdAt,
      lastUsedAt: Math.max(previous?.lastUsedAt ?? 0, run.updatedAt),
    });
  }
  return [...map.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

interface SetupRecord {
  completed: boolean;
  completedAt: number | null;
}

function setupRecord(service: BrokerService): SetupRecord {
  try {
    const parsed = JSON.parse(service.store.getMeta(SETUP_META_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && parsed.completed) {
      return { completed: true, completedAt: Number(parsed.completedAt) || null };
    }
  } catch { /* treat missing or corrupt setup meta as incomplete */ }
  return { completed: false, completedAt: null };
}

function setupStatus(service: BrokerService): SetupRecord & { required: boolean } {
  const record = setupRecord(service);
  return { ...record, required: !record.completed && service.runs.size === 0 };
}

function persistLiveConfig(service: BrokerService, configPath: string | null, config: BusConfig): void {
  if (!configPath) throw new Error("configuration editing is unavailable with an in-memory config");
  assertSafeConfigTransition(service, config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  applyConfig(service, config);
}

function rememberProject(service: BrokerService, value: unknown): ProjectRecord {
  const path = resolve(String(value ?? "").trim());
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new Error(`project root is not a directory: ${path}`);
  const now = Date.now();
  const list = storedProjects(service);
  const previous = list.find((item) => item.path === path);
  const project = {
    path,
    name: previous?.name ?? (basename(path) || path),
    createdAt: previous?.createdAt ?? now,
    lastUsedAt: now,
  };
  service.store.setMeta(PROJECT_META_KEY, JSON.stringify([project, ...list.filter((item) => item.path !== path)].slice(0, 100)));
  return project;
}

async function ensureAgentToken(service: BrokerService, operatorTokenPath: string, id: string): Promise<string> {
  const path = agentTokenPath(id);
  const existing = readTokenFile(path);
  if (existing) return existing;
  const token = operatorToken(operatorTokenPath);
  let result = await service.handle("/agent/provision", { token, id, rotate: false }) as { token: string | null };
  if (!result.token) result = await service.handle("/agent/provision", { token, id, rotate: true }) as { token: string | null };
  if (!result.token) throw new Error(`could not provision ${id}`);
  writePrivateToken(path, result.token);
  return result.token;
}

async function startAgent(service: BrokerService, operatorTokenPath: string, configPath: string | null, id: string, requested?: string): Promise<Record<string, unknown>> {
  if (!configPath) throw new Error("agent supervision is unavailable with an in-memory config");
  const definition = service.config.agents[id];
  if (!definition) throw new Error(`unknown configured agent: ${id}`);
  if (!definition.enabled) throw new Error(`agent ${id} is disabled`);
  const live = verifiedLiveSupervisor(service, id);
  if (live) return { id, started: false, pid: live.pid, message: "already supervised" };
  const latestRun = [...service.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const latestProject = projects(service)[0];
  const projectRoot = resolve(String(requested || latestRun?.projectRoot || latestProject?.path || ""));
  if (!projectRoot || !existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    throw new Error("a valid projectRoot is required to start an agent");
  }
  await ensureAgentToken(service, operatorTokenPath, id);
  const launched = launchSupervisor({
    agentId: id,
    projectRoot,
    configPath,
    busHome: BUS_HOME,
    port: BUS_PORT,
  });
  return { id, started: true, pid: launched.pid, projectRoot };
}

async function stopRun(service: BrokerService, token: string, runId: string, reason: string): Promise<{ run: Run; tasks: Task[] }> {
  const run = service.runs.get(runId);
  if (!run) throw new Error(`unknown run: ${runId}`);
  if (run.status === "active") {
    run.status = "cancelled";
    run.updatedAt = Date.now();
    service.store.saveRun(run);
    const openTasks = [...service.tasks.values()].filter((task) => task.runId === runId && !["accepted", "failed", "cancelled"].includes(task.state));
    for (const task of openTasks) await service.handle("/task/cancel", { token, taskId: task.id, reason });
    run.updatedAt = Date.now();
    service.store.saveRun(run);
  }
  return { run, tasks: [...service.tasks.values()].filter((task) => task.runId === runId) };
}

async function providerStatus(service: BrokerService, discover: boolean): Promise<Record<string, unknown>[]> {
  const config = service.config;
  const harnessRows = new Map<string, Record<string, unknown>>();
  for (const harness of Object.values(config.harnesses)) {
    const agentDefinition = Object.values(config.agents).find((agent) => config.models[agent.model]?.harness === harness.id);
    let cliFound = false;
    let version: string | null = null;
    let error: string | null = harness.enabled ? "no configured agent uses this harness" : "disabled";
    let discoveredModels: string[] = [];
    if (harness.enabled && agentDefinition) {
      const resolved = resolveAgent(config, agentDefinition.id);
      const probe = await probeHarness(resolved);
      cliFound = probe.available;
      version = probe.version;
      error = probe.error;
      if (discover && probe.available && harness.modelDiscovery) {
        const discovery = await discoverHarnessModels(resolved);
        discoveredModels = discovery.models;
        if (discovery.error) error = discovery.error;
      }
    }
    harnessRows.set(harness.id, {
      id: harness.id,
      configured: harness.enabled,
      command: harness.command,
      cliFound,
      version,
      error,
      liveVerification: harness.id === "fake" ? "not-required" : "unknown",
      discoveredModels,
    });
  }
  return Object.values(config.providers).map((provider) => {
    const harnesses = Object.values(config.harnesses)
      .filter((harness) => harness.providers.includes(provider.id))
      .map((harness) => harnessRows.get(harness.id));
    return {
      id: provider.id,
      displayName: provider.displayName,
      configured: provider.enabled && harnesses.some((harness) => Boolean(harness?.configured)),
      cliFound: harnesses.some((harness) => Boolean(harness?.cliFound)),
      authKind: provider.authKind,
      authSource: provider.authSource,
      subscriptionBacked: provider.subscriptionBacked,
      liveVerification: provider.id === "fake" ? "not-required" : "unknown",
      harnesses,
    };
  });
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  params: URLSearchParams,
  service: BrokerService,
  sessions: BrowserSessions,
  operatorTokenPath: string,
  configPath: string | null,
  sessionTtlMs: number,
  eventStreams: Set<ServerResponse>,
): Promise<void> {
  if (pathname === "/api/session" && req.method === "POST") {
    requireSameOrigin(req);
    const body = await readJson(req);
    const session = sessions.exchange(String(body.ticket ?? ""));
    return sendJson(res, 200, { authenticated: true }, {
      "set-cookie": `agent_bus_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(sessionTtlMs / 1000)}`,
    });
  }

  const session = requireSession(req, sessions);
  if (req.method && req.method !== "GET" && req.method !== "HEAD") requireSameOrigin(req);

  if (pathname === "/api/session" && req.method === "GET") return sendJson(res, 200, { authenticated: true });
  if (pathname === "/api/session/logout" && req.method === "POST") {
    sessions.revoke(session);
    return sendJson(res, 200, { authenticated: false }, {
      "set-cookie": "agent_bus_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    });
  }
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    eventStreams.add(res);
    let since = Math.max(0, Number(params.get("since") ?? 0) || 0);
    let closed = false;
    let running = false;
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      eventStreams.delete(res);
    };
    const tick = async () => {
      if (closed || running) return;
      running = true;
      try {
        pruneStaleSupervisors(service);
        const snapshot = service.snapshot(since);
        since = snapshot.seq;
        if (!closed) res.write(`event: snapshot\ndata: ${JSON.stringify({ ...snapshot, incremental: true })}\n\n`);
      } catch (error) {
        if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: (error as Error).message })}\n\n`);
      } finally {
        running = false;
      }
    };
    req.once("close", cleanup);
    res.once("close", cleanup);
    await tick();
    if (!closed) {
      timer = setInterval(tick, 800);
      timer.unref();
    }
    return;
  }
  if (pathname === "/api/state" && req.method === "GET") {
    pruneStaleSupervisors(service);
    return sendJson(res, 200, service.snapshot(0));
  }
  if (pathname === "/api/catalog" && req.method === "GET") return sendJson(res, 200, await service.handle("/catalog", {}));
  if (pathname === "/api/setup" && req.method === "GET") return sendJson(res, 200, setupStatus(service));
  if (pathname === "/api/setup" && req.method === "POST") {
    const body = await readJson(req);
    const completed = body.completed === undefined ? true : Boolean(body.completed);
    const record: SetupRecord = completed
      ? { completed: true, completedAt: Date.now() }
      : { completed: false, completedAt: null };
    service.store.setMeta(SETUP_META_KEY, JSON.stringify(record));
    return sendJson(res, 200, setupStatus(service));
  }
  if (pathname === "/api/projects" && req.method === "GET") return sendJson(res, 200, { projects: projects(service) });
  if (pathname === "/api/projects" && req.method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, { project: rememberProject(service, body.path ?? body.projectRoot) });
  }
  if (pathname === "/api/providers/status" && req.method === "GET") {
    return sendJson(res, 200, { providers: await providerStatus(service, params.get("discover") === "1") });
  }
  if (pathname === "/api/runs" && req.method === "GET") return sendJson(res, 200, await service.handle("/run/list", {}));
  if (pathname === "/api/runs" && req.method === "POST") {
    const body = await readJson(req);
    rememberProject(service, body.projectRoot);
    return sendJson(res, 200, await service.handle("/run/create", { ...body, token: operatorToken(operatorTokenPath) }));
  }
  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && req.method === "GET") return sendJson(res, 200, await service.handle("/run/get", { runId: decodeURIComponent(runMatch[1]) }));
  const stopRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
  if (stopRunMatch && req.method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await stopRun(service, operatorToken(operatorTokenPath), decodeURIComponent(stopRunMatch[1]), String(body.reason ?? "Run stopped by operator.")));
  }
  if (pathname === "/api/messages" && req.method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await service.handle("/send", { ...body, token: operatorToken(operatorTokenPath) }));
  }
  if (pathname === "/api/tasks" && req.method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await service.handle("/task/create", { ...body, token: operatorToken(operatorTokenPath) }));
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(review|cancel)$/);
  if (taskMatch && req.method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await service.handle(taskMatch[2] === "review" ? "/task/review" : "/task/cancel", {
      ...body,
      taskId: decodeURIComponent(taskMatch[1]),
      token: operatorToken(operatorTokenPath),
    }));
  }
  if (pathname === "/api/providers" && req.method === "POST") {
    const body = await readJson(req);
    const result = stageProviderEnabled(loadConfig(configPath || undefined), body);
    persistLiveConfig(service, configPath, result.config);
    return sendJson(res, 200, { provider: result.provider, applied: true });
  }
  if (pathname === "/api/constraints" && req.method === "POST") {
    const body = await readJson(req);
    const result = stageConstraintsPatch(loadConfig(configPath || undefined), body);
    persistLiveConfig(service, configPath, result.config);
    return sendJson(res, 200, { constraints: result.constraints, applied: true });
  }
  if (pathname === "/api/agents" && req.method === "POST") {
    const body = await readJson(req);
    const result = stageAgentUpdate(loadConfig(configPath || undefined), body);
    persistLiveConfig(service, configPath, result.config);
    return sendJson(res, 200, { agent: result.agent, applied: true });
  }
  if (pathname === "/api/integrations" && req.method === "POST") {
    if (!configPath) throw new Error("integration editing is unavailable with an in-memory config");
    const input = await readJson(req) as unknown as IntegrationInput;
    const result = addOrUpdateIntegration(configPath, input, { persist: false });
    assertSafeConfigTransition(service, result.config);
    writeFileSync(configPath, `${JSON.stringify(result.config, null, 2)}\n`, "utf8");
    applyConfig(service, result.config);
    return sendJson(res, 200, {
      provider: result.provider,
      harness: result.harness,
      model: result.model,
      agent: result.agent,
      applied: true,
    });
  }
  if (pathname === "/api/agents/stop-all" && req.method === "POST") {
    const token = operatorToken(operatorTokenPath);
    const results: Record<string, unknown>[] = [];
    for (const [id] of [...service.supervisorMeta]) {
      try { results.push({ id, ...await service.handle("/kill", { token, agentId: id }) as Record<string, unknown> }); }
      catch (error) { results.push({ id, ok: false, error: (error as Error).message }); }
    }
    return sendJson(res, 200, { results });
  }
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)\/(start|stop)$/);
  if (agentMatch && req.method === "POST") {
    const id = decodeURIComponent(agentMatch[1]);
    if (agentMatch[2] === "start") {
      const body = await readJson(req);
      return sendJson(res, 200, await startAgent(service, operatorTokenPath, configPath, id, body.projectRoot ? String(body.projectRoot) : undefined));
    }
    return sendJson(res, 200, await service.handle("/kill", { token: operatorToken(operatorTokenPath), agentId: id }));
  }
  return sendJson(res, 404, { error: "dashboard route not found" });
}

export async function startProductServer(options: ProductServerOptions = {}): Promise<ProductServerHandle> {
  const service = new BrokerService(options);
  const host = options.host ?? BUS_HOST;
  const requestedPort = options.port ?? BUS_PORT;
  const operatorTokenPath = options.operatorTokenPath ?? OPERATOR_TOKEN_PATH;
  const configPath = options.configPath ?? (options.config ? null : (process.env.AGENT_BUS_CONFIG ?? DEFAULT_CONFIG_PATH));
  const staticRoot = options.staticRoot ?? DEFAULT_STATIC_ROOT;
  const sessionTtlMs = Math.max(1000, options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);
  const ticketTtlMs = Math.max(20, options.loginTicketTtlMs ?? DEFAULT_LOGIN_TICKET_TTL_MS);
  const sessions = new BrowserSessions(sessionTtlMs, ticketTtlMs);
  const eventStreams = new Set<ServerResponse>();
  const artifact = productArtifactManifest(staticRoot);
  const buildId = artifact.buildId;
  const runtime = {
    pid: process.pid,
    busHome: resolve(BUS_HOME),
    applicationRoot: resolve(ROOT),
    staticRoot: resolve(staticRoot),
    entrypoint: resolve(process.argv[1] ?? CLI_PATH),
    modulePath: fileURLToPath(import.meta.url),
    launcherPath: process.env.AGENT_BUS_LAUNCHER_PATH ?? null,
    installRoot: process.env.AGENT_BUS_INSTALL_ROOT ?? null,
    nodePath: process.execPath,
    nodeVersion: process.version,
    cwd: process.cwd(),
    argv: process.argv.slice(1),
    ui: { index: artifact.index, scripts: artifact.scripts, styles: artifact.styles },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${requestedPort}`}`);
    const pathname = url.pathname;
    if (pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        product: PRODUCT_NAME,
        productProtocol: PRODUCT_PROTOCOL_VERSION,
        buildId,
        pid: process.pid,
        agents: service.agents.size,
        tasks: service.tasks.size,
        runs: service.runs.size,
        durable: true,
        dashboard: true,
        uiBuilt: artifact.uiBuilt,
        runtime,
      });
    }
    if (pathname === "/diagnostics/runtime" && (req.method === "GET" || req.method === "HEAD")) {
      return sendJson(res, 200, { ok: true, product: PRODUCT_NAME, productProtocol: PRODUCT_PROTOCOL_VERSION, buildId, runtime });
    }

    try {
      if (pathname === "/dashboard/login" && req.method === "POST") {
        const body = await readJson(req);
        verifyOperatorToken(service, String(body.token ?? ""));
        return sendJson(res, 200, { ...sessions.issue(), dashboardUrl: DASHBOARD_URL });
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        return await handleApi(req, res, pathname, url.searchParams, service, sessions, operatorTokenPath, configPath, sessionTtlMs, eventStreams);
      }
      if ((req.method === "GET" || req.method === "HEAD") && !pathname.startsWith("/agent/") && pathname !== "/register") {
        return serveDashboardStatic(req, res, staticRoot, pathname);
      }
      if (req.method !== "POST") return sendJson(res, 405, { error: "legacy broker routes require POST" });
      return sendJson(res, 200, await service.handle(pathname, await readJson(req)));
    } catch (error) {
      return sendJson(res, errorStatus(error), { error: (error as Error).message });
    }
  });

  server.headersTimeout = MAX_WAIT_MS + 60_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = MAX_WAIT_MS + 60_000;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const url = `http://${host}:${port}`;
  process.stderr.write(`agent-bus listening on ${url} (dashboard + API + broker, SQLite: ${service.store.path})\n`);
  return {
    service,
    server,
    host,
    port,
    url,
    buildId,
    close: () => new Promise<void>((resolveClose, reject) => {
      for (const stream of eventStreams) {
        try { stream.end(); } catch {}
      }
      server.close((error) => {
        service.close();
        if (error) reject(error); else resolveClose();
      });
    }),
  };
}
