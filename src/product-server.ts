import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverHarnessModels, probeHarness } from "./adapters.js";
import {
  AgentDefinition,
  BusConfig,
  DEFAULT_CONFIG_PATH,
  enabledAgents,
  loadConfig,
  resolveAgent,
  validateConfig,
} from "./config.js";
import { addOrUpdateIntegration, IntegrationInput } from "./integrations.js";
import {
  Agent,
  BUS_HOME,
  BUS_HOST,
  BUS_PORT,
  MAX_WAIT_MS,
  Run,
  Task,
} from "./protocol.js";
import {
  OPERATOR_TOKEN_PATH,
  agentTokenPath,
  hashToken,
  readTokenFile,
  writePrivateToken,
} from "./security.js";
import { BrokerOptions, BrokerService } from "./broker.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = join(ROOT, "cli.js");
const DEFAULT_STATIC_ROOT = join(ROOT, "dist", "web");
const PROJECT_META_KEY = "dashboard.projects";
const SESSION_TTL_MS = 24 * 60 * 60_000;
const LOGIN_TICKET_TTL_MS = 60_000;

export const DASHBOARD_URL = `http://${BUS_HOST}:${BUS_PORT}`;

export interface ProductServerOptions extends BrokerOptions {
  staticRoot?: string;
}

export interface ProductServerHandle {
  service: BrokerService;
  server: Server;
  host: string;
  port: number;
  url: string;
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

  private prune(): void {
    const now = Date.now();
    for (const [ticket, expiresAt] of this.tickets) if (expiresAt <= now) this.tickets.delete(ticket);
    for (const [session, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(session);
  }

  issueTicket(): { ticket: string; expiresInSeconds: number } {
    this.prune();
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, Date.now() + LOGIN_TICKET_TTL_MS);
    return { ticket, expiresInSeconds: Math.round(LOGIN_TICKET_TTL_MS / 1000) };
  }

  exchange(ticket: string): string {
    this.prune();
    const expiresAt = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!expiresAt || expiresAt <= Date.now()) throw new BrowserAuthError("login ticket is invalid or expired");
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(session, Date.now() + SESSION_TTL_MS);
    return session;
  }

  revoke(session: string): void {
    this.sessions.delete(session);
  }

  valid(session: string): boolean {
    this.prune();
    const expiresAt = this.sessions.get(session);
    return Boolean(expiresAt && expiresAt > Date.now());
  }
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  const out: Record<string, string> = {};
  for (const piece of header.split(";")) {
    const index = piece.indexOf("=");
    if (index <= 0) continue;
    out[piece.slice(0, index).trim()] = decodeURIComponent(piece.slice(index + 1).trim());
  }
  return out;
}

function browserSession(req: IncomingMessage): string {
  return parseCookies(req).agent_bus_session ?? "";
}

function requireBrowserSession(req: IncomingMessage, sessions: BrowserSessions): string {
  const session = browserSession(req);
  if (!session || !sessions.valid(session)) throw new BrowserAuthError("dashboard session missing or expired; run `agent-bus open`");
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
  if (message.includes("already") || message.includes("not submitted") || message.includes("not eligible")) return 409;
  return 400;
}

function contentType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".woff2") return "font/woff2";
  return "text/html; charset=utf-8";
}

function serveStatic(req: IncomingMessage, res: ServerResponse, staticRoot: string, pathname: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
  const root = resolve(staticRoot);
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  let target = resolve(root, requested);
  if (target !== root && !target.startsWith(root + sep)) return sendJson(res, 404, { error: "not found" });
  if (!existsSync(target) || !statSync(target).isFile()) target = join(root, "index.html");
  if (!existsSync(target) || !statSync(target).isFile()) {
    return sendJson(res, 503, { error: "dashboard build missing; run `npm run build`" });
  }
  const body = readFileSync(target);
  res.writeHead(200, {
    "content-type": contentType(target),
    "content-length": String(body.length),
    "cache-control": target.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (req.method === "HEAD") res.end(); else res.end(body);
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

function normalizePermissions(
  value: unknown,
  fallback?: AgentDefinition["permissions"],
): AgentDefinition["permissions"] {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const filesystem = ["none", "read", "write"].includes(String(row.filesystem))
    ? String(row.filesystem) as "none" | "read" | "write"
    : fallback?.filesystem ?? "read";
  return {
    canDelegate: row.canDelegate === undefined ? fallback?.canDelegate ?? false : Boolean(row.canDelegate),
    canReview: row.canReview === undefined ? fallback?.canReview ?? false : Boolean(row.canReview),
    filesystem,
    shell: row.shell === undefined ? fallback?.shell ?? false : Boolean(row.shell),
    network: row.network === undefined ? fallback?.network ?? false : Boolean(row.network),
    maxDelegationDepth: Math.max(0, Number(row.maxDelegationDepth ?? fallback?.maxDelegationDepth ?? 0) || 0),
    allowedPaths: Array.isArray(row.allowedPaths)
      ? row.allowedPaths.map(String).filter(Boolean)
      : fallback?.allowedPaths ?? ["."],
  };
}

function safeAgentId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new Error("agent id must be 1-64 safe characters");
  return id;
}

function saveAgentConfig(configPath: string, body: Record<string, unknown>): { agent: AgentDefinition; config: BusConfig } {
  const config = structuredClone(loadConfig(configPath));
  const id = safeAgentId(body.id);
  const existing = config.agents[id];
  const modelId = String(body.model ?? existing?.model ?? "");
  const role = String(body.role ?? existing?.role ?? "");
  const model = config.models[modelId];
  if (!model) throw new Error(`unknown model: ${modelId}`);
  if (!config.roles[role]) throw new Error(`unknown role: ${role}`);

  if (body.modelFamily !== undefined) model.family = String(body.modelFamily).trim() || model.family;
  if (body.exactModel !== undefined) {
    const exactModel = String(body.exactModel).trim();
    if (exactModel) model.exactModel = exactModel; else delete model.exactModel;
  }

  const authority = String(body.authority ?? existing?.authority ?? (role === "manager" ? "manager" : "worker"));
  if (authority !== "manager" && authority !== "worker") throw new Error("agent authority must be manager or worker");
  const harnessOptions: Record<string, unknown> = { ...(existing?.harnessOptions ?? {}) };
  if (body.harnessOptions && typeof body.harnessOptions === "object") Object.assign(harnessOptions, body.harnessOptions);
  if (body.reasoning !== undefined) harnessOptions.reasoning = String(body.reasoning);
  if (body.effort !== undefined) harnessOptions.effort = String(body.effort);

  const agent: AgentDefinition = {
    id,
    model: modelId,
    role,
    authority,
    description: String(body.description ?? existing?.description ?? `${role} agent`),
    enabled: body.enabled === undefined ? existing?.enabled ?? true : Boolean(body.enabled),
    autoStart: body.autoStart === undefined ? existing?.autoStart ?? false : Boolean(body.autoStart),
    permissions: normalizePermissions(body.permissions, existing?.permissions),
    harnessOptions,
  };
  config.agents[id] = agent;
  validateConfig(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { agent, config };
}

function applyConfig(service: BrokerService, config: BusConfig): void {
  Object.assign(service.config, config);
  const configured = new Set(Object.keys(config.agents));
  for (const [id, definition] of Object.entries(config.agents)) {
    const resolved = resolveAgent(config, id);
    const existing = service.agents.get(id);
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
      status: existing?.status ?? "offline",
      currentTaskId: existing?.currentTaskId ?? null,
      registeredAt: existing?.registeredAt ?? 0,
      lastSeen: existing?.lastSeen ?? 0,
    };
    service.agents.set(id, agent);
    service.store.saveAgent(agent);
    const identity = service.store.identityById(id);
    if (identity) {
      service.store.upsertIdentity({
        ...identity,
        authority: definition.authority,
        permissions: definition.permissions,
        updatedAt: Date.now(),
      });
    }
  }
  for (const [id, agent] of service.agents) {
    if (id === "operator" || configured.has(id)) continue;
    agent.status = "offline";
    service.store.saveAgent(agent);
  }
}

function storedProjects(service: BrokerService): ProjectRecord[] {
  try {
    return JSON.parse(service.store.getMeta(PROJECT_META_KEY) ?? "[]") as ProjectRecord[];
  } catch {
    return [];
  }
}

function projects(service: BrokerService): ProjectRecord[] {
  const byPath = new Map<string, ProjectRecord>();
  for (const project of storedProjects(service)) byPath.set(project.path, project);
  for (const run of service.runs.values()) {
    const existing = byPath.get(run.projectRoot);
    byPath.set(run.projectRoot, {
      path: run.projectRoot,
      name: existing?.name ?? basename(run.projectRoot) || run.projectRoot,
      createdAt: existing?.createdAt ?? run.createdAt,
      lastUsedAt: Math.max(existing?.lastUsedAt ?? 0, run.updatedAt),
    });
  }
  return [...byPath.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

function rememberProject(service: BrokerService, value: unknown): ProjectRecord {
  const path = resolve(String(value ?? "").trim());
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new Error(`project root is not a directory: ${path}`);
  const now = Date.now();
  const list = storedProjects(service);
  const existing = list.find((item) => item.path === path);
  const project: ProjectRecord = {
    path,
    name: existing?.name ?? basename(path) || path,
    createdAt: existing?.createdAt ?? now,
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

async function startAgent(
  service: BrokerService,
  operatorTokenPath: string,
  id: string,
  requestedProjectRoot?: string,
): Promise<Record<string, unknown>> {
  const definition = service.config.agents[id];
  if (!definition) throw new Error(`unknown configured agent: ${id}`);
  if (!definition.enabled) throw new Error(`agent ${id} is disabled`);
  const existing = service.supervisorMeta.get(id);
  if (existing) return { id, started: false, pid: existing.pid, message: "already supervised" };
  const latestRun = [...service.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const latestProject = projects(service)[0];
  const projectRoot = resolve(String(requestedProjectRoot || latestRun?.projectRoot || latestProject?.path || ""));
  if (!projectRoot || !existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    throw new Error("a valid projectRoot is required to start an agent");
  }
  await ensureAgentToken(service, operatorTokenPath, id);
  mkdirSync(join(BUS_HOME, "logs"), { recursive: true });
  const log = openSync(join(BUS_HOME, "logs", `${id}.out`), "a");
  const child = spawn(process.execPath, [CLI_PATH, "supervise", id, projectRoot], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  return { id, started: true, pid: child.pid ?? 0, projectRoot };
}

async function stopRun(service: BrokerService, token: string, runId: string, reason: string): Promise<{ run: Run; tasks: Task[] }> {
  const run = service.runs.get(runId);
  if (!run) throw new Error(`unknown run: ${runId}`);
  if (run.status !== "active") return {
    run,
    tasks: [...service.tasks.values()].filter((task) => task.runId === runId),
  };
  run.status = "cancelled";
  run.updatedAt = Date.now();
  service.store.saveRun(run);
  const open = [...service.tasks.values()].filter((task) =>
    task.runId === runId && !["accepted", "failed", "cancelled"].includes(task.state),
  );
  for (const task of open) {
    await service.handle("/task/cancel", { token, taskId: task.id, reason });
  }
  run.updatedAt = Date.now();
  service.store.saveRun(run);
  return { run, tasks: [...service.tasks.values()].filter((task) => task.runId === runId) };
}

async function providerStatus(service: BrokerService, discover: boolean): Promise<Record<string, unknown>[]> {
  const config = service.config;
  const harnessRows = new Map<string, Record<string, unknown>>();
  for (const harness of Object.values(config.harnesses)) {
    const agentDef = Object.values(config.agents).find((agent) => config.models[agent.model]?.harness === harness.id);
    let cliFound = false;
    let version: string | null = null;
    let error: string | null = harness.enabled ? "no configured agent uses this harness" : "disabled";
    let discoveredModels: string[] = [];
    if (harness.enabled && agentDef) {
      const resolvedAgent = resolveAgent(config, agentDef.id);
      const probe = await probeHarness(resolvedAgent);
      cliFound = probe.available;
      version = probe.version;
      error = probe.error;
      if (discover && probe.available && harness.modelDiscovery) {
        const discovery = await discoverHarnessModels(resolvedAgent);
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
      configured: provider.enabled && harnesses.some((row) => Boolean(row?.configured)),
      cliFound: harnesses.some((row) => Boolean(row?.cliFound)),
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
  searchParams: URLSearchParams,
  service: BrokerService,
  sessions: BrowserSessions,
  operatorTokenPath: string,
  configPath: string | null,
): Promise<void> {
  if (pathname === "/api/session" && req.method === "POST") {
    requireSameOrigin(req);
    const body = await readJson(req);
    const session = sessions.exchange(String(body.ticket ?? ""));
    return sendJson(res, 200, { authenticated: true }, {
      "set-cookie": `agent_bus_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.round(SESSION_TTL_MS / 1000)}`,
    });
  }

  const session = requireBrowserSession(req, sessions);
  if (req.method && req.method !== "GET" && req.method !== "HEAD") requireSameOrigin(req);

  if (pathname === "/api/session" && req.method === "GET") return sendJson(res, 200, { authenticated: true });
  if (pathname === "/api/session/logout" && req.method === "POST") {
    sessions.revoke(session);
    return sendJson(res, 200, { authenticated: false }, { "set-cookie": "agent_bus_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }

  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    let sinceSeq = Math.max(0, Number(searchParams.get("since") ?? 0) || 0);
    let closed = false;
    let running = false;
    const tick = async () => {
      if (closed || running) return;
      running = true;
      try {
        const snapshot = await service.handle("/snapshot", { sinceSeq }) as Record<string, unknown> & { seq?: number };
        sinceSeq = Number(snapshot.seq ?? sinceSeq);
        res.write(`event: snapshot\ndata: ${JSON.stringify({ ...snapshot, incremental: true })}\n\n`);
      } catch (error) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: (error as Error).message })}\n\n`);
      } finally {
        running = false;
      }
    };
    await tick();
    const interval = setInterval(tick, 800);
    interval.unref();
    req.on("close", () => {
      closed = true;
      clearInterval(interval);
    });
    return;
  }

  if (pathname === "/api/state" && req.method === "GET") {
    return sendJson(res, 200, await service.handle("/snapshot", { sinceSeq: 0 }));
  }
  if (pathname === "/api/catalog" && req.method === "GET") return sendJson(res, 200, await service.handle("/catalog", {}));
  if (pathname === "/api/projects" && req.method === "GET") return sendJson(res, 200, { projects: projects(service) });
  if (pathname === "/api/projects" && req.method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, { project: rememberProject(service, body.path ?? body.projectRoot) });
  }
  if (pathname === "/api/providers/status" && req.method === "GET") {
    return sendJson(res, 200, { providers: await providerStatus(service, searchParams.get("discover") === "1") });
  }
  if (pathname === "/api/runs" && req.method === "GET") return sendJson(res, 200, await service.handle("/run/list", {}));
  if (pathname === "/api/runs" && req.method === "POST") {
    const body = await readJson(req);
    rememberProject(service, body.projectRoot);
    return sendJson(res, 200, await service.handle("/run/create", { ...body, token: operatorToken(operatorTokenPath) }));
  }
  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && req.method === "GET") {
    return sendJson(res, 200, await service.handle("/run/get", { runId: decodeURIComponent(runMatch[1]) }));
  }
  const runStopMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
  if (runStopMatch && req.method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await stopRun(
      service,
      operatorToken(operatorTokenPath),
      decodeURIComponent(runStopMatch[1]),
      String(body.reason ?? "Run stopped by operator."),
    ));
  }
  if (pathname === "/api/messages" && req.method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await service.handle("/send", { ...body, token: operatorToken(operatorTokenPath) }));
  }
  if (pathname === "/api/tasks" && req.method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await service.handle("/task/create", { ...body, token: operatorToken(operatorTokenPath) }));
  }
  const taskAction = pathname.match(/^\/api\/tasks\/([^/]+)\/(review|cancel)$/);
  if (taskAction && req.method === "POST") {
    const body = await readJson(req);
    const taskId = decodeURIComponent(taskAction[1]);
    const brokerPath = taskAction[2] === "review" ? "/task/review" : "/task/cancel";
    return sendJson(res, 200, await service.handle(brokerPath, { ...body, taskId, token: operatorToken(operatorTokenPath) }));
  }
  if (pathname === "/api/agents" && req.method === "POST") {
    if (!configPath) throw new Error("agent configuration editing is unavailable when the broker was started from an in-memory config");
    const body = await readJson(req);
    const result = saveAgentConfig(configPath, body);
    applyConfig(service, result.config);
    return sendJson(res, 200, { agent: result.agent, applied: true });
  }
  if (pathname === "/api/integrations" && req.method === "POST") {
    if (!configPath) throw new Error("integration editing is unavailable when the broker was started from an in-memory config");
    const body = await readJson(req);
    const result = addOrUpdateIntegration(configPath, body as unknown as IntegrationInput);
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
    for (const [id] of service.supervisorMeta) {
      try {
        results.push({ id, ...(await service.handle("/kill", { token, agentId: id }) as Record<string, unknown>) });
      } catch (error) {
        results.push({ id, ok: false, error: (error as Error).message });
      }
    }
    return sendJson(res, 200, { results });
  }
  const agentAction = pathname.match(/^\/api\/agents\/([^/]+)\/(start|stop)$/);
  if (agentAction && req.method === "POST") {
    const id = decodeURIComponent(agentAction[1]);
    if (agentAction[2] === "start") {
      const body = await readJson(req);
      return sendJson(res, 200, await startAgent(service, operatorTokenPath, id, body.projectRoot ? String(body.projectRoot) : undefined));
    }
    return sendJson(res, 200, await service.handle("/kill", { token: operatorToken(operatorTokenPath), agentId: id }));
  }

  sendJson(res, 404, { error: "dashboard route not found" });
}

export async function startProductServer(options: ProductServerOptions = {}): Promise<ProductServerHandle> {
  const service = new BrokerService(options);
  const host = options.host ?? BUS_HOST;
  const requestedPort = options.port ?? BUS_PORT;
  const operatorTokenPath = options.operatorTokenPath ?? OPERATOR_TOKEN_PATH;
  const configPath = options.configPath ?? (options.config ? null : (process.env.AGENT_BUS_CONFIG ?? DEFAULT_CONFIG_PATH));
  const staticRoot = options.staticRoot ?? DEFAULT_STATIC_ROOT;
  const sessions = new BrowserSessions();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${requestedPort}`}`);
    const pathname = url.pathname;
    if (pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        agents: service.agents.size,
        tasks: service.tasks.size,
        runs: service.runs.size,
        durable: true,
        dashboard: true,
        uiBuilt: existsSync(join(staticRoot, "index.html")),
      });
    }

    try {
      if (pathname === "/dashboard/login" && req.method === "POST") {
        const body = await readJson(req);
        verifyOperatorToken(service, String(body.token ?? ""));
        const issued = sessions.issueTicket();
        return sendJson(res, 200, { ...issued, dashboardUrl: DASHBOARD_URL });
      }
      if (pathname.startsWith("/api/")) {
        return await handleApi(req, res, pathname, url.searchParams, service, sessions, operatorTokenPath, configPath);
      }
      if ((req.method === "GET" || req.method === "HEAD") && !pathname.startsWith("/agent/") && pathname !== "/register") {
        return serveStatic(req, res, staticRoot, pathname);
      }
      if (req.method !== "POST") return sendJson(res, 405, { error: "legacy broker routes require POST" });
      const body = await readJson(req);
      return sendJson(res, 200, await service.handle(pathname, body));
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
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => {
        service.close();
        if (error) reject(error); else resolveClose();
      });
    }),
  };
}
