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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeHarness } from "./adapters.js";
import {
  AgentDefinition,
  DEFAULT_CONFIG_PATH,
  enabledAgents,
  loadConfig,
  validateConfig,
} from "./config.js";
import { addOrUpdateIntegration, IntegrationInput } from "./integrations.js";
import { BUS_HOME, BUS_URL } from "./protocol.js";
import {
  OPERATOR_TOKEN_PATH,
  agentTokenPath,
  readTokenFile,
  writePrivateToken,
} from "./security.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = join(ROOT, "dist", "cli.js");
const DEFAULT_STATIC_ROOT = join(ROOT, "web");
export const DASHBOARD_HOST = "127.0.0.1";
export const DASHBOARD_PORT = Number(process.env.AGENT_BUS_DASHBOARD_PORT ?? 7718);
export const DASHBOARD_URL = `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`;

export interface DashboardOptions {
  host?: string;
  port?: number;
  brokerUrl?: string;
  operatorTokenPath?: string;
  configPath?: string;
  staticRoot?: string;
}

export interface DashboardHandle {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
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
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("body must be a JSON object");
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`invalid JSON body: ${(error as Error).message}`));
      }
    });
  });
}

function contentType(path: string): string {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "text/html; charset=utf-8";
}

function serveFile(
  res: ServerResponse,
  staticRoot: string,
  requestPath: string,
  sessionCookie: string,
): void {
  const allowed = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/app.js", "app.js"],
    ["/styles.css", "styles.css"],
  ]);
  const relative = allowed.get(requestPath);
  if (!relative) return sendJson(res, 404, { error: "not found" });
  const filePath = join(staticRoot, relative);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return sendJson(res, 503, { error: `dashboard asset missing: ${relative}` });
  }
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "content-type": contentType(filePath),
    "content-length": body.length,
    "cache-control": relative === "index.html" ? "no-store" : "public, max-age=60",
    "set-cookie": `agent_bus_dashboard=${encodeURIComponent(sessionCookie)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(body);
}

async function postBroker<T = any>(
  brokerUrl: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${brokerUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(path === "/wait" ? 260_000 : 20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`broker ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) as T : {} as T;
}

function requireOperatorToken(path: string): string {
  const token = readTokenFile(path);
  if (!token) throw new Error(`operator token missing at ${path}; start the broker first`);
  return token;
}

function requireDashboardSession(req: IncomingMessage, sessionCookie: string): void {
  if (parseCookies(req).agent_bus_dashboard !== sessionCookie) {
    throw new DashboardAuthError("dashboard session missing or expired");
  }
}

function requireSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) throw new DashboardAuthError("same-origin request required");
  const allowed = new Set([`http://${host}`, `https://${host}`]);
  if (!allowed.has(origin)) throw new DashboardAuthError("cross-origin dashboard request rejected");
}

class DashboardAuthError extends Error {}

async function ensureAgentToken(
  brokerUrl: string,
  operatorTokenPath: string,
  id: string,
): Promise<string> {
  const path = agentTokenPath(id);
  const existing = readTokenFile(path);
  if (existing) return existing;
  const token = requireOperatorToken(operatorTokenPath);
  let response = await postBroker<{ token: string | null; message?: string }>(brokerUrl, "/agent/provision", {
    token,
    id,
    rotate: false,
  });
  if (!response.token) {
    response = await postBroker<{ token: string | null }>(brokerUrl, "/agent/provision", {
      token,
      id,
      rotate: true,
    });
  }
  if (!response.token) throw new Error(`could not provision ${id}`);
  writePrivateToken(path, response.token);
  return response.token;
}

async function startAgent(
  brokerUrl: string,
  operatorTokenPath: string,
  id: string,
  requestedProjectRoot?: string,
): Promise<Record<string, unknown>> {
  const snapshot = await postBroker<any>(brokerUrl, "/snapshot", { sinceSeq: 0 });
  const existing = snapshot.roster?.find((agent: any) => agent.id === id);
  if (!existing) throw new Error(`unknown configured agent: ${id}`);
  if (existing.supervisorPid) {
    return { id, started: false, pid: existing.supervisorPid, message: "already supervised" };
  }
  const latestActive = snapshot.runs?.find((run: any) => run.status === "active") ?? snapshot.runs?.[0];
  const projectRoot = resolve(String(requestedProjectRoot || latestActive?.projectRoot || ""));
  if (!projectRoot || !existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    throw new Error("a valid projectRoot is required to start an agent");
  }
  await ensureAgentToken(brokerUrl, operatorTokenPath, id);
  mkdirSync(join(BUS_HOME, "logs"), { recursive: true });
  const log = openSync(join(BUS_HOME, "logs", `${id}.out`), "a");
  const child = spawn(process.execPath, [CLI_PATH, "supervise", id, projectRoot], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  return { id, started: true, pid: child.pid ?? 0, projectRoot };
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

function saveAgentConfig(configPath: string, body: Record<string, unknown>): AgentDefinition {
  const config = structuredClone(loadConfig(configPath));
  const id = String(body.id ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new Error("agent id must be 1-64 safe characters");
  const existing = config.agents[id];
  const model = String(body.model ?? existing?.model ?? "");
  const role = String(body.role ?? existing?.role ?? "");
  if (!config.models[model]) throw new Error(`unknown model: ${model}`);
  if (!config.roles[role]) throw new Error(`unknown role: ${role}`);
  const authority = String(body.authority ?? existing?.authority ?? (role === "manager" ? "manager" : "worker"));
  if (!["manager", "worker"].includes(authority)) throw new Error("agent authority must be manager or worker");
  const next: AgentDefinition = {
    id,
    model,
    role,
    authority: authority as AgentDefinition["authority"],
    description: String(body.description ?? existing?.description ?? `${role} agent`),
    enabled: body.enabled === undefined ? existing?.enabled ?? true : Boolean(body.enabled),
    autoStart: body.autoStart === undefined ? existing?.autoStart ?? false : Boolean(body.autoStart),
    permissions: normalizePermissions(body.permissions, existing?.permissions),
    harnessOptions: body.harnessOptions && typeof body.harnessOptions === "object"
      ? body.harnessOptions as Record<string, unknown>
      : existing?.harnessOptions,
  };
  config.agents[id] = next;
  validateConfig(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return next;
}

export async function dashboardAlive(url = DASHBOARD_URL): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startDashboard(options: DashboardOptions = {}): Promise<DashboardHandle> {
  const host = options.host ?? DASHBOARD_HOST;
  const requestedPort = options.port ?? DASHBOARD_PORT;
  const brokerUrl = options.brokerUrl ?? BUS_URL;
  const operatorTokenPath = options.operatorTokenPath ?? OPERATOR_TOKEN_PATH;
  const configPath = options.configPath ?? process.env.AGENT_BUS_CONFIG ?? DEFAULT_CONFIG_PATH;
  const staticRoot = options.staticRoot ?? DEFAULT_STATIC_ROOT;
  const sessionCookie = randomBytes(32).toString("base64url");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${requestedPort}`}`);
    const path = url.pathname;

    if (path === "/health") {
      return sendJson(res, 200, { ok: true, service: "agent-bus-dashboard", brokerUrl });
    }

    if (!path.startsWith("/api/")) {
      return serveFile(res, staticRoot, path, sessionCookie);
    }

    try {
      requireDashboardSession(req, sessionCookie);
      if (req.method && req.method !== "GET" && req.method !== "HEAD") requireSameOrigin(req);

      if (path === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(": connected\n\n");
        let sinceSeq = 0;
        let closed = false;
        let running = false;
        const tick = async () => {
          if (closed || running) return;
          running = true;
          try {
            const snapshot = await postBroker<any>(brokerUrl, "/snapshot", { sinceSeq });
            sinceSeq = Number(snapshot.seq ?? sinceSeq);
            res.write(`event: snapshot\ndata: ${JSON.stringify({ ...snapshot, incremental: true })}\n\n`);
          } catch (error) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: (error as Error).message })}\n\n`);
          } finally {
            running = false;
          }
        };
        await tick();
        const interval = setInterval(tick, 1000);
        req.on("close", () => {
          closed = true;
          clearInterval(interval);
        });
        return;
      }

      if (path === "/api/state" && req.method === "GET") {
        return sendJson(res, 200, await postBroker(brokerUrl, "/snapshot", { sinceSeq: 0 }));
      }

      if (path === "/api/catalog" && req.method === "GET") {
        return sendJson(res, 200, await postBroker(brokerUrl, "/catalog", {}));
      }

      if (path === "/api/integrations" && req.method === "POST") {
        const body = await readJson(req);
        const result = addOrUpdateIntegration(configPath, body as unknown as IntegrationInput);
        return sendJson(res, 200, {
          provider: result.provider,
          harness: result.harness,
          model: result.model,
          agent: result.agent,
          restartRequired: true,
          message: "Integration saved. Restart Agent Bus to load it into the broker roster and router.",
        });
      }

      if (path === "/api/providers/status" && req.method === "GET") {
        const config = loadConfig(configPath);
        const seen = new Set<string>();
        const probes = [];
        for (const agent of enabledAgents(config)) {
          if (seen.has(agent.harnessDefinition.id)) continue;
          seen.add(agent.harnessDefinition.id);
          probes.push(await probeHarness(agent));
        }
        return sendJson(res, 200, { probes });
      }

      if (path === "/api/runs" && req.method === "GET") {
        return sendJson(res, 200, await postBroker(brokerUrl, "/run/list", {}));
      }

      if (path === "/api/runs" && req.method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 200, await postBroker(brokerUrl, "/run/create", {
          ...body,
          token: requireOperatorToken(operatorTokenPath),
        }));
      }

      const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch && req.method === "GET") {
        return sendJson(res, 200, await postBroker(brokerUrl, "/run/get", { runId: decodeURIComponent(runMatch[1]) }));
      }

      if (path === "/api/messages" && req.method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 200, await postBroker(brokerUrl, "/send", {
          ...body,
          token: requireOperatorToken(operatorTokenPath),
        }));
      }

      if (path === "/api/agents" && req.method === "POST") {
        const body = await readJson(req);
        const agent = saveAgentConfig(configPath, body);
        return sendJson(res, 200, {
          agent,
          restartRequired: true,
          message: "Agent configuration saved. Restart Agent Bus before starting a newly-created or materially changed agent.",
        });
      }

      if (path === "/api/agents/stop-all" && req.method === "POST") {
        const snapshot = await postBroker<any>(brokerUrl, "/snapshot", { sinceSeq: 0 });
        const token = requireOperatorToken(operatorTokenPath);
        const results: Record<string, unknown>[] = [];
        for (const agent of snapshot.roster ?? []) {
          if (!agent.supervisorPid || agent.id === "operator") continue;
          try {
            results.push({ id: agent.id, ...(await postBroker<Record<string, unknown>>(brokerUrl, "/kill", { token, agentId: agent.id })) });
          } catch (error) {
            results.push({ id: agent.id, ok: false, error: (error as Error).message });
          }
        }
        return sendJson(res, 200, { results });
      }

      const agentAction = path.match(/^\/api\/agents\/([^/]+)\/(start|stop)$/);
      if (agentAction && req.method === "POST") {
        const id = decodeURIComponent(agentAction[1]);
        if (agentAction[2] === "start") {
          const body = await readJson(req);
          return sendJson(res, 200, await startAgent(brokerUrl, operatorTokenPath, id, body.projectRoot ? String(body.projectRoot) : undefined));
        }
        return sendJson(res, 200, await postBroker(brokerUrl, "/kill", {
          token: requireOperatorToken(operatorTokenPath),
          agentId: id,
        }));
      }

      const taskAction = path.match(/^\/api\/tasks\/([^/]+)\/(review|cancel)$/);
      if (taskAction && req.method === "POST") {
        const body = await readJson(req);
        const taskId = decodeURIComponent(taskAction[1]);
        const brokerPath = taskAction[2] === "review" ? "/task/review" : "/task/cancel";
        return sendJson(res, 200, await postBroker(brokerUrl, brokerPath, {
          ...body,
          taskId,
          token: requireOperatorToken(operatorTokenPath),
        }));
      }

      return sendJson(res, 404, { error: "dashboard route not found" });
    } catch (error) {
      const status = error instanceof DashboardAuthError ? 401 : 400;
      return sendJson(res, status, { error: (error as Error).message });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const url = `http://${host}:${port}`;
  process.stderr.write(`agent-bus dashboard listening on ${url} → ${brokerUrl}\n`);

  return {
    server,
    host,
    port,
    url,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}
