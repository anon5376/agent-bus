#!/usr/bin/env python3
from pathlib import Path
import os
import re


def replace_once(text: str, before: str, after: str, label: str) -> str:
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(before, after, 1)


def replace_regex(text: str, pattern: str, after: str, label: str) -> str:
    updated, count = re.subn(pattern, after, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one regex match, found {count}")
    return updated


def update(path: str, transform) -> None:
    file = Path(path)
    before = file.read_text()
    after = transform(before)
    if after == before:
        raise RuntimeError(f"{path}: transform made no change")
    file.write_text(after)


# 1/2/6: process ownership is scoped to one home+port. Patched processes keep
# an OS-start-identity registry; an installed pre-registry process can only be
# discovered globally when its command path is physically under this home.
def patch_process_management(source: str) -> str:
    text = source
    text = replace_once(
        text,
        'import { setTimeout as sleep } from "node:timers/promises";\nimport { PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";\n',
        'import { setTimeout as sleep } from "node:timers/promises";\nimport { join, resolve, sep } from "node:path";\nimport { ownedAgentBusPids, processCommand } from "./instance-processes.js";\nimport { PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";\n',
        "process-management imports",
    )
    text = replace_once(
        text,
        '  runtime?: { applicationRoot?: string; staticRoot?: string; entrypoint?: string; nodePath?: string; cwd?: string };\n',
        '  runtime?: { applicationRoot?: string; staticRoot?: string; entrypoint?: string; nodePath?: string; cwd?: string; busHome?: string };\n',
        "health runtime home",
    )
    text = replace_once(
        text,
        '''export interface StopResult {
  stoppedPids: number[];
  forcedPids: number[];
  unrelated: PortOwner[];
}

''',
        '''export interface StopResult {
  stoppedPids: number[];
  forcedPids: number[];
  unrelated: PortOwner[];
}

export interface AgentBusCommandScope {
  applicationRoot?: string;
  busHome?: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runtimeBelongsToScope(health: ProductHealth, scope: AgentBusCommandScope): boolean {
  if (!scope.busHome) return true;
  const targetHome = resolve(scope.busHome);
  const reportedHome = String(health.runtime?.busHome ?? "").trim();
  if (reportedHome) return resolve(reportedHome) === targetHome;
  const applicationRoot = String(health.runtime?.applicationRoot ?? "").trim();
  if (!applicationRoot) return false;
  const appRoot = join(targetHome, "app");
  const resolvedApplication = resolve(applicationRoot);
  return resolvedApplication === appRoot || resolvedApplication.startsWith(`${appRoot}${sep}`);
}

''',
        "process scope helpers",
    )
    text = replace_regex(
        text,
        r'export function knownAgentBusCommand\(command: string\): boolean \{.*?\n\}',
        r'''export function knownAgentBusCommand(command: string, scope: AgentBusCommandScope = {}): boolean {
  const text = command.trim();
  if (!text) return false;
  const roots = [String.raw`\S*/agent-bus/`];
  if (scope.busHome) roots.push(`${escapeRegex(resolve(scope.busHome))}/app/(?:current|releases/[^/]+)/`);
  else roots.push(String.raw`\S*/\.agent-bus/app/(?:current|releases/[^/]+)/`);
  if (scope.applicationRoot) roots.push(`${escapeRegex(resolve(scope.applicationRoot))}/`);
  const root = `(?:${[...new Set(roots)].join("|")})`;
  return new RegExp(String.raw`(?:^|\s)(?:\S*node\S*\s+)?${root}(?:dist/(?:cli|broker|product-server)\.js|cli\.js)(?:\s+(?:broker|dashboard|supervise)(?:\s|$)|\s*$)`, "i").test(text)
    || new RegExp(String.raw`(?:^|\s)(?:\S*node\S*\s+)?${root}src/(?:broker|product-server)\.(?:js|ts)(?:\s|$)`, "i").test(text);
}''',
        "known Agent Bus command matcher",
    )
    text = replace_once(
        text,
        '''  legacyCatalogFingerprint = false,
): PortOwner {
''',
        '''  legacyCatalogFingerprint = false,
  scope: AgentBusCommandScope = {},
): PortOwner {
''',
        "classify scope argument",
    )
    text = replace_once(
        text,
        '''  if (healthBelongsToPid && health?.product === PRODUCT_NAME) {
    const current = health.productProtocol === PRODUCT_PROTOCOL_VERSION
''',
        '''  if (healthBelongsToPid && health?.product === PRODUCT_NAME) {
    if (!runtimeBelongsToScope(health, scope)) {
      return { pid, command, kind: "unrelated", reason: "different Agent Bus instance/home" };
    }
    const current = health.productProtocol === PRODUCT_PROTOCOL_VERSION
''',
        "health ownership check",
    )
    text = replace_once(
        text,
        '  if (knownAgentBusCommand(command)) {\n',
        '  if (knownAgentBusCommand(command, scope)) {\n',
        "scoped command classification",
    )
    text = replace_regex(
        text,
        r'\nexport function processCommand\(pid: number\): string \{.*?\n\}\n',
        '\n',
        "remove duplicate processCommand",
    )
    text = replace_once(
        text,
        'export async function inspectPort(port: number, url: string, expectedBuildId: string): Promise<PortOwner[]> {\n',
        'export async function inspectPort(port: number, url: string, expectedBuildId: string, scope: AgentBusCommandScope = {}): Promise<PortOwner[]> {\n',
        "inspectPort scope",
    )
    text = replace_once(
        text,
        '  return pids.map((pid) => classifyPortOwner(pid, processCommand(pid), health, expectedBuildId, legacyFingerprint));\n',
        '  return pids.map((pid) => classifyPortOwner(pid, processCommand(pid), health, expectedBuildId, legacyFingerprint, scope));\n',
        "inspectPort classification scope",
    )
    text = replace_regex(
        text,
        r'\nfunction knownServicePids\(includeSupervisors: boolean\): number\[] \{.*?\n\}\n',
        '\n',
        "remove global knownServicePids",
    )
    text = replace_regex(
        text,
        r'\nasync function supervisorPids\(url: string, health: ProductHealth \| null\): Promise<number\[]> \{.*?\n\}\n',
        '\n',
        "remove unscoped supervisorPids",
    )
    insertion = r'''
function installedServicePids(scope: AgentBusCommandScope, includeSupervisors: boolean): number[] {
  if (process.platform === "win32" || !scope.busHome) return [];
  const installedRoot = `${join(resolve(scope.busHome), "app")}${sep}`;
  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return [];
      const pid = Number(match[1]);
      const command = match[2];
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return [];
      if (!command.includes(installedRoot) || !knownAgentBusCommand(command, scope)) return [];
      if (!includeSupervisors && /\s+supervise(?:\s|$)/.test(command)) return [];
      return [pid];
    });
  } catch {
    return [];
  }
}

async function brokerSupervisorPids(url: string, health: ProductHealth | null, scope: AgentBusCommandScope): Promise<number[]> {
  if (!health || health.product !== PRODUCT_NAME || !runtimeBelongsToScope(health, scope)) return [];
  try {
    const response = await fetch(`${url}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return [];
    const body = await response.json() as { roster?: Array<{ id?: string; supervisorPid?: number }> };
    const applicationRoot = health.runtime?.applicationRoot || scope.applicationRoot;
    return (body.roster ?? []).flatMap((item) => {
      const pid = Number(item.supervisorPid);
      const id = String(item.id ?? "");
      if (!Number.isInteger(pid) || pid <= 0 || !id) return [];
      const command = processCommand(pid);
      if (!knownAgentBusCommand(command, { ...scope, applicationRoot })) return [];
      if (!new RegExp(`\\ssupervise\\s+${escapeRegex(id)}(?:\\s|$)`).test(command)) return [];
      return [pid];
    });
  } catch {
    return [];
  }
}
'''
    text = replace_once(text, '\nfunction alive(pid: number): boolean {\n', insertion + '\nfunction alive(pid: number): boolean {\n', "scoped process fallback insertion")
    text = replace_once(
        text,
        '''  expectedBuildId: string;
  includeSupervisors: boolean;
}): Promise<StopResult> {
  const health = await fetchHealth(options.url);
  const owners = await inspectPort(options.port, options.url, options.expectedBuildId);
''',
        '''  expectedBuildId: string;
  includeSupervisors: boolean;
  busHome?: string;
  applicationRoot?: string;
}): Promise<StopResult> {
  const scope: AgentBusCommandScope = { busHome: options.busHome, applicationRoot: options.applicationRoot };
  const health = await fetchHealth(options.url);
  const owners = await inspectPort(options.port, options.url, options.expectedBuildId, scope);
''',
        "stop process scope",
    )
    text = replace_once(
        text,
        '''  const pids = [
    ...safeListenerPids,
    ...knownServicePids(options.includeSupervisors),
    ...(options.includeSupervisors && !unrelated.length ? await supervisorPids(options.url, health) : []),
  ];
''',
        '''  const registeredPids = options.busHome
    ? ownedAgentBusPids({ busHome: options.busHome, port: options.port, includeSupervisors: options.includeSupervisors })
    : [];
  const installedPids = installedServicePids(scope, options.includeSupervisors);
  const legacySupervisorPids = options.includeSupervisors && !unrelated.length
    ? await brokerSupervisorPids(options.url, health, scope)
    : [];
  const pids = [...safeListenerPids, ...registeredPids, ...installedPids, ...legacySupervisorPids];
''',
        "instance-scoped PID selection",
    )
    return text


update("src/process-management.ts", patch_process_management)


# 1: establish supervisor identity on /register, before the execution config is
# reloaded. This closes the small register/presence startup race too.
def patch_broker(source: str) -> str:
    return replace_once(
        source,
        '''        this.agents.set(id, agent);
        this.store.saveAgent(agent);
        this.audit("register", { id, role: agent.role, model: agent.model, harness: agent.harness });
''',
        '''        this.agents.set(id, agent);
        this.store.saveAgent(agent);
        const supervisorPid = Number(body.pid);
        if (Number.isFinite(supervisorPid) && supervisorPid > 0) {
          this.supervisorMeta.set(id, {
            pid: supervisorPid,
            childPid: null,
            workdir: String(body.workdir ?? ""),
            cli: String(body.cli ?? agent.harness),
            startedAt: Date.now(),
          });
        }
        this.audit("register", { id, role: agent.role, model: agent.model, harness: agent.harness });
''',
        "broker registration supervisor metadata",
    )


update("src/broker.ts", patch_broker)


def patch_supervisor(source: str) -> str:
    text = source
    old = '''  const config = loadConfig(configPathFromProject(workdir));
  const agent = resolveAgent(config, agentId);
  if (!agent.enabled) throw new Error(`agent ${agentId} is disabled in configuration`);
  if (!(await brokerAlive())) throw new Error("broker is not running — start it with: agent-bus broker");

  const token = readTokenFile(agentTokenPath(agentId));
  if (!token) {
    throw new Error(`no token for ${agentId}; provision it explicitly with: agent-bus provision ${agentId}`);
  }
  await brokerCall("/register", { token, id: agentId });
  await reportPresence(token, agent, workdir, null);

  const adapter = getHarnessAdapter(agent.harnessDefinition.adapter);
'''
    new = '''  const configPath = configPathFromProject(workdir);
  const preflight = resolveAgent(loadConfig(configPath), agentId);
  if (!preflight.enabled) throw new Error(`agent ${agentId} is disabled in configuration`);
  if (!(await brokerAlive())) throw new Error("broker is not running — start it with: agent-bus broker");

  const token = readTokenFile(agentTokenPath(agentId));
  if (!token) {
    throw new Error(`no token for ${agentId}; provision it explicitly with: agent-bus provision ${agentId}`);
  }
  await brokerCall("/register", { token, id: agentId, pid: process.pid, workdir, cli: preflight.harnessDefinition.id });
  const agent = resolveAgent(loadConfig(configPath), agentId);
  if (!agent.enabled) throw new Error(`agent ${agentId} was disabled while the supervisor was starting`);
  await reportPresence(token, agent, workdir, null);

  const adapter = getHarnessAdapter(agent.harnessDefinition.adapter);
'''
    return replace_once(text, old, new, "supervisor registration/config reload")


update("src/supervisor.ts", patch_supervisor)


# 1/3/4/6: agent editor is offline-only for execution-affecting definitions;
# models remain shared registry objects; SSE streams are explicitly ended at close;
# runtime identity includes the owning home.
def patch_product_server(source: str) -> str:
    text = source
    text = replace_once(
        text,
        '  if (message.includes("already") || message.includes("not submitted") || message.includes("not eligible")) return 409;\n',
        '  if (message.includes("already") || message.includes("not submitted") || message.includes("not eligible") || message.includes("stop it before editing")) return 409;\n',
        "agent edit conflict status",
    )
    text = replace_once(
        text,
        '''  if (body.modelFamily !== undefined) model.family = String(body.modelFamily).trim() || model.family;
  if (body.exactModel !== undefined) {
    const exact = String(body.exactModel).trim();
    if (exact) model.exactModel = exact; else delete model.exactModel;
  }
''',
        '''  if (body.modelFamily !== undefined || body.exactModel !== undefined) {
    throw new Error("model definitions are shared; agent edits cannot change model family or exact model");
  }
''',
        "shared model mutation",
    )
    text = replace_once(
        text,
        '''  configPath: string | null,
  sessionTtlMs: number,
): Promise<void> {
''',
        '''  configPath: string | null,
  sessionTtlMs: number,
  eventStreams: Set<ServerResponse>,
): Promise<void> {
''',
        "event stream handleApi argument",
    )
    text = replace_regex(
        text,
        r'''  if \(pathname === "/api/events" && req\.method === "GET"\) \{.*?\n    return;\n  \}''',
        '''  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\\n\\n");
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
        const snapshot = await service.handle("/snapshot", { sinceSeq: since }) as Record<string, unknown> & { seq?: number };
        since = Number(snapshot.seq ?? since);
        if (!closed) res.write(`event: snapshot\\ndata: ${JSON.stringify({ ...snapshot, incremental: true })}\\n\\n`);
      } catch (error) {
        if (!closed) res.write(`event: error\\ndata: ${JSON.stringify({ error: (error as Error).message })}\\n\\n`);
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
  }''',
        "SSE stream lifecycle",
    )
    text = replace_once(
        text,
        '''  if (pathname === "/api/agents" && req.method === "POST") {
    if (!configPath) throw new Error("agent configuration editing is unavailable with an in-memory config");
    const result = saveAgent(configPath, await readJson(req));
''',
        '''  if (pathname === "/api/agents" && req.method === "POST") {
    if (!configPath) throw new Error("agent configuration editing is unavailable with an in-memory config");
    const body = await readJson(req);
    const id = String(body.id ?? "").trim();
    if (service.supervisorMeta.has(id)) throw new Error(`agent ${id} is supervised; stop it before editing its configuration`);
    const result = saveAgent(configPath, body);
''',
        "running supervisor edit guard",
    )
    text = replace_once(
        text,
        '''  const sessions = new BrowserSessions(sessionTtlMs, ticketTtlMs);
  const artifact = productArtifactManifest(staticRoot);
''',
        '''  const sessions = new BrowserSessions(sessionTtlMs, ticketTtlMs);
  const eventStreams = new Set<ServerResponse>();
  const artifact = productArtifactManifest(staticRoot);
''',
        "event stream set",
    )
    text = replace_once(
        text,
        '''    pid: process.pid,
    applicationRoot: resolve(ROOT),
''',
        '''    pid: process.pid,
    busHome: resolve(BUS_HOME),
    applicationRoot: resolve(ROOT),
''',
        "runtime bus home",
    )
    text = replace_once(
        text,
        '        return await handleApi(req, res, pathname, url.searchParams, service, sessions, operatorTokenPath, configPath, sessionTtlMs);\n',
        '        return await handleApi(req, res, pathname, url.searchParams, service, sessions, operatorTokenPath, configPath, sessionTtlMs, eventStreams);\n',
        "pass event stream set",
    )
    text = replace_once(
        text,
        '''    close: () => new Promise<void>((resolveClose, reject) => server.close((error) => {
      service.close();
      if (error) reject(error); else resolveClose();
    })),
''',
        '''    close: () => new Promise<void>((resolveClose, reject) => {
      for (const stream of eventStreams) {
        try { stream.end(); } catch {}
      }
      server.close((error) => {
        service.close();
        if (error) reject(error); else resolveClose();
      });
    }),
''',
        "graceful SSE close",
    )
    return text


update("src/product-server.ts", patch_product_server)


# 2/5/6: CLI scopes all lifecycle operations and records broker/supervisor OS
# identity. Exact-current health also requires the target home.
def patch_cli(source: str) -> str:
    text = source
    text = replace_once(
        text,
        'import { BusConfig, enabledAgents, loadConfig } from "./config.js";\n',
        'import { BusConfig, enabledAgents, loadConfig } from "./config.js";\nimport { recordCurrentAgentBusProcess } from "./instance-processes.js";\n',
        "CLI process registry import",
    )
    text = replace_once(
        text,
        'const EXPECTED_BUILD_ID = EXPECTED_MANIFEST.buildId;\n',
        'const EXPECTED_BUILD_ID = EXPECTED_MANIFEST.buildId;\nconst PROCESS_SCOPE = { applicationRoot: ROOT, busHome: BUS_HOME };\n',
        "CLI process scope",
    )
    text = replace_once(
        text,
        '  const runtime = (health as typeof health & { runtime?: { applicationRoot?: string; staticRoot?: string } }).runtime;\n',
        '  const runtime = (health as typeof health & { runtime?: { applicationRoot?: string; staticRoot?: string; busHome?: string } }).runtime;\n',
        "CLI health runtime type",
    )
    text = replace_once(
        text,
        '''    && health.uiBuilt === true
    && resolve(runtime?.applicationRoot ?? "") === resolve(ROOT)
''',
        '''    && health.uiBuilt === true
    && resolve(runtime?.busHome ?? "") === resolve(BUS_HOME)
    && resolve(runtime?.applicationRoot ?? "") === resolve(ROOT)
''',
        "CLI exact home health",
    )
    count = text.count('inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID)')
    if count < 2:
        raise RuntimeError(f"CLI inspectPort scope: expected multiple calls, found {count}")
    text = text.replace('inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID)', 'inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID, PROCESS_SCOPE)')
    text = replace_once(
        text,
        '''    expectedBuildId: EXPECTED_BUILD_ID,
    includeSupervisors: false,
  });
''',
        '''    expectedBuildId: EXPECTED_BUILD_ID,
    includeSupervisors: false,
    busHome: BUS_HOME,
    applicationRoot: ROOT,
  });
''',
        "startup stop scope",
    )
    text = replace_once(
        text,
        'case "stop":{const result=await stopAgentBusProcesses({port:BUS_PORT,url:BUS_URL,expectedBuildId:EXPECTED_BUILD_ID,includeSupervisors:true});',
        'case "stop":{const result=await stopAgentBusProcesses({port:BUS_PORT,url:BUS_URL,expectedBuildId:EXPECTED_BUILD_ID,includeSupervisors:true,busHome:BUS_HOME,applicationRoot:ROOT});',
        "CLI stop scope",
    )
    text = replace_once(
        text,
        'case "broker":{const handle=await startProductServer();const shutdown=async()=>{await handle.close().catch(()=>{});process.exit(0)};process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);return}\n',
        'case "broker":{const removeProcessRecord=recordCurrentAgentBusProcess({busHome:BUS_HOME,port:BUS_PORT,applicationRoot:ROOT,kind:"broker"});try{const handle=await startProductServer();let shuttingDown=false;const shutdown=async()=>{if(shuttingDown)return;shuttingDown=true;await handle.close().catch(()=>{});removeProcessRecord();process.exit(0)};process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);return}catch(error){removeProcessRecord();throw error}}\n',
        "broker process registry",
    )
    text = replace_once(
        text,
        'case "supervise":{const id=process.argv[3];const workdir=resolve(process.argv[4]??process.cwd());if(!id)throw new Error("usage: agent-bus supervise <agent-id> [workdir]");const {supervise}=await import("./supervisor.js");await supervise(id,workdir);return}\n',
        'case "supervise":{const id=process.argv[3];const workdir=resolve(process.argv[4]??process.cwd());if(!id)throw new Error("usage: agent-bus supervise <agent-id> [workdir]");const removeProcessRecord=recordCurrentAgentBusProcess({busHome:BUS_HOME,port:BUS_PORT,applicationRoot:ROOT,kind:"supervisor",agentId:id});try{const {supervise}=await import("./supervisor.js");await supervise(id,workdir)}finally{removeProcessRecord()}return}\n',
        "supervisor process registry",
    )
    return text


update("src/cli.ts", patch_cli)


# 4: model selector metadata is controlled/read-only and never submitted as an
# agent-level mutation.
def patch_web(source: str) -> str:
    text = source
    text = replace_once(
        text,
        'autoStart:f.get("autoStart")==="on",exactModel:f.get("exactModel"),modelFamily:f.get("modelFamily"),reasoning:f.get("reasoning"),',
        'autoStart:f.get("autoStart")==="on",reasoning:f.get("reasoning"),',
        "agent form model payload",
    )
    text = replace_once(
        text,
        '<label>Model<select value={model} onChange={e=>setModel(e.target.value)}>',
        '<label>Model<select data-agent-model-select="true" value={model} onChange={e=>setModel(e.target.value)}>',
        "agent model select marker",
    )
    text = replace_once(
        text,
        '<label>Exact model<input name="exactModel" defaultValue={modelDef.exactModel||""}/></label><label>Model family<input name="modelFamily" defaultValue={modelDef.family||""}/></label>',
        '<label>Exact model<input data-agent-model-exact="true" value={modelDef.exactModel||""} readOnly/></label><label>Model family<input data-agent-model-family="true" value={modelDef.family||""} readOnly/></label>',
        "controlled model metadata",
    )
    return text


update("web/src/main.tsx", patch_web)


# 5/7: semantic Node 22.5 gating at install and every launcher invocation, then
# prune only well-formed immutable releases after the new launcher is proven.
def patch_install(source: str) -> str:
    text = source
    text = replace_once(
        text,
        '''FALLBACK_NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "Agent Bus requires Node.js 22.5+; found $(node --version) at $FALLBACK_NODE_BIN" >&2
  exit 1
fi
''',
        '''FALLBACK_NODE_BIN="$(command -v node)"
if ! "$FALLBACK_NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)'; then
  echo "Agent Bus requires Node.js 22.5+; found $("$FALLBACK_NODE_BIN" --version 2>/dev/null || echo unknown) at $FALLBACK_NODE_BIN" >&2
  exit 1
fi
''',
        "installer Node semantic check",
    )
    text = replace_once(
        text,
        '''NODE_BIN="\${AGENT_BUS_NODE_BIN:-\$(command -v node 2>/dev/null || true)}"
if [ -z "\$NODE_BIN" ] || [ ! -x "\$NODE_BIN" ]; then
  NODE_BIN="$FALLBACK_NODE_BIN"
fi
if [ ! -x "\$NODE_BIN" ]; then
  echo "Agent Bus requires Node.js 22.5+; no executable Node binary was found." >&2
  exit 1
fi
''',
        '''node_supported() {
  "\$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)' >/dev/null 2>&1
}
NODE_BIN="\${AGENT_BUS_NODE_BIN:-}"
if [ -n "\$NODE_BIN" ]; then
  if [ ! -x "\$NODE_BIN" ] || ! node_supported "\$NODE_BIN"; then
    echo "Agent Bus requires Node.js 22.5+; AGENT_BUS_NODE_BIN is unsupported: \$NODE_BIN" >&2
    exit 1
  fi
else
  NODE_BIN="\$(command -v node 2>/dev/null || true)"
  if [ -z "\$NODE_BIN" ] || [ ! -x "\$NODE_BIN" ] || ! node_supported "\$NODE_BIN"; then
    NODE_BIN="$FALLBACK_NODE_BIN"
  fi
  if [ ! -x "\$NODE_BIN" ] || ! node_supported "\$NODE_BIN"; then
    echo "Agent Bus requires Node.js 22.5+; no supported Node binary was found." >&2
    exit 1
  fi
fi
''',
        "launcher Node semantic check",
    )
    text = replace_once(
        text,
        '''"$RESOLVED_AGENT_BUS" models >/dev/null

printf '\nAgent Bus installed globally:\n'
''',
        '''"$RESOLVED_AGENT_BUS" models >/dev/null

# Retain the active release plus one previous valid immutable release. Unknown,
# malformed, or symlinked entries are deliberately left untouched.
previous_kept=""
while IFS= read -r release_name; do
  [[ "$release_name" == "$ARTIFACT_ID" ]] && continue
  [[ "$release_name" =~ ^[0-9a-f]{20}$ ]] || continue
  release_path="$RELEASES_DIR/$release_name"
  [[ -d "$release_path" && ! -L "$release_path" && -f "$release_path/ARTIFACT_ID" ]] || continue
  [[ "$(cat "$release_path/ARTIFACT_ID" 2>/dev/null || true)" == "$release_name" ]] || continue
  if [[ -z "$previous_kept" ]]; then
    previous_kept="$release_name"
    continue
  fi
  rm -rf -- "$release_path"
done < <(ls -1t "$RELEASES_DIR" 2>/dev/null || true)

printf '\nAgent Bus installed globally:\n'
''',
        "release pruning",
    )
    return text


update("install.sh", patch_install)


# Regression: scope matcher and healthy cross-home identity.
def patch_process_tests(source: str) -> str:
    text = replace_once(
        source,
        '  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/.agent-bus/app/releases/abc123/dist/cli.js broker"), true);\n',
        '  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/.agent-bus/app/releases/abc123/dist/cli.js broker"), true);\n  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /tmp/custom-bus/app/releases/abc123/dist/cli.js broker", { busHome: "/tmp/custom-bus" }), true);\n  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /tmp/other-bus/app/releases/abc123/dist/cli.js broker", { busHome: "/tmp/custom-bus" }), false);\n',
        "custom-home matcher regression",
    )
    text += '''

test("product health from another Agent Bus home is not owned by this instance", () => {
  const owner = classifyPortOwner(123, "node /tmp/other/app/current/dist/cli.js broker", {
    ok: true,
    pid: 123,
    product: PRODUCT_NAME,
    productProtocol: PRODUCT_PROTOCOL_VERSION,
    buildId,
    dashboard: true,
    uiBuilt: true,
    runtime: { busHome: "/tmp/other", applicationRoot: "/tmp/other/app/releases/abc" },
  }, buildId, false, { busHome: "/tmp/mine", applicationRoot: "/tmp/mine/app/current" });
  assert.equal(owner.kind, "unrelated");
  assert.match(owner.reason, /different Agent Bus instance/i);
});
'''
    return text


update("tests/process-management.test.ts", patch_process_tests)


# Product-server regressions: open SSE close, shared-model mutation, and running
# supervisor edit rejection.
def patch_product_tests(source: str) -> str:
    marker = 'test("malformed JSON is rejected without crashing the product server",async t=>{'
    inserted = '''test("closing the product server terminates an open SSE stream without lifecycle escalation",async()=>{
  const f=await fixture();const cookie=await login(f);
  const response=await fetch(`${f.handle.url}/api/events`,{headers:{cookie}});assert.equal(response.status,200);
  const reader=response.body!.getReader();await reader.read();
  await Promise.race([f.handle.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("product server close hung on SSE")),1500))]);
});

test("agent edits cannot mutate a shared model definition",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());const cookie=await login(f);
  const createPeer=await fetch(`${f.handle.url}/api/agents`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({id:"fake-peer",model:"fake-small",role:"cheap-worker",description:"shares fake-small",enabled:true,autoStart:false,permissions:{filesystem:"read",shell:false,network:false,canReview:false,canDelegate:false,maxDelegationDepth:0,allowedPaths:["."]}})});
  const createPeerText=await createPeer.text();assert.equal(createPeer.status,200,createPeerText);
  const before=JSON.parse(readFileSync(f.configPath,"utf8"));
  const response=await fetch(`${f.handle.url}/api/agents`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({id:"fake-small",model:"fake-small",role:"cheap-worker",exactModel:"silently-mutated",modelFamily:"silently-mutated-family"})});
  const responseText=await response.text();assert.equal(response.status,400,responseText);assert.match(responseText,/model definitions are shared/i);
  const after=JSON.parse(readFileSync(f.configPath,"utf8"));assert.deepEqual(after.models["fake-small"],before.models["fake-small"]);assert.equal(after.agents["fake-peer"].model,"fake-small");
});

test("running supervisors reject agent configuration edits instead of creating split-brain state",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());const cookie=await login(f);
  const before=JSON.parse(readFileSync(f.configPath,"utf8"));
  (f.handle.service.supervisorMeta as any).set("fake-small",{pid:424242,childPid:null,workdir:f.root,cli:"fake",startedAt:Date.now()});
  const response=await fetch(`${f.handle.url}/api/agents`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({id:"fake-small",model:"fake-strong",role:"cheap-worker",description:"would diverge",enabled:true,autoStart:false,permissions:{filesystem:"read",shell:false,network:false,canReview:false,canDelegate:false,maxDelegationDepth:0,allowedPaths:["."]}})});
  const responseText=await response.text();assert.equal(response.status,409,responseText);assert.match(responseText,/stop it before editing/i);
  const after=JSON.parse(readFileSync(f.configPath,"utf8"));assert.deepEqual(after.agents["fake-small"],before.agents["fake-small"]);
  const catalog=await fetch(`${f.handle.url}/api/catalog`,{headers:{cookie}});const body=await catalog.json() as any;assert.equal(body.agents["fake-small"].model,before.agents["fake-small"].model);
});

'''
    return replace_once(source, marker, inserted + marker, "product server regressions")


update("tests/product-server.test.ts", patch_product_tests)


# Real Chromium regression for the model-switch controlled form bug.
def patch_browser(source: str) -> str:
    text = source
    helper = '''async function verifyAgentModelFields(cdp) {
  await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.right .pane-head button')?.click()" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  async function selectModel(id) {
    const changed = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const select=document.querySelector('[data-agent-model-select="true"]'); if(!select)return false; select.value=${JSON.stringify(id)}; select.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`,
      returnByValue: true,
    });
    assert.equal(changed.result?.value, true, "agent model selector was not found");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => ({exact:document.querySelector('[data-agent-model-exact="true"]')?.value??null,family:document.querySelector('[data-agent-model-family="true"]')?.value??null}))()`,
      returnByValue: true,
    });
    return result.result?.value;
  }
  const small = await selectModel("fake-small");
  assert.equal(small?.exact, "fake-small");
  const strong = await selectModel("fake-strong");
  assert.equal(strong?.exact, "fake-strong", "model metadata must update when model selection changes");
  assert.equal(strong?.family, "fake");
  await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.modal .modal-head button')?.click()" });
}

'''
    text = replace_once(text, 'function sha256(value) {\n', helper + 'function sha256(value) {\n', "browser form helper")
    text = replace_once(
        text,
        '''  const first = await runChrome(`${handle.url}/?ticket=${encodeURIComponent(ticket)}&build=${encodeURIComponent(runtime.buildId)}&launch=chrome-smoke`, profile, async (state, cdp) => {
    if (!(state.mounted && state.rootChildren > 0 && state.text.includes("Agent Bus") && state.search === "" && state.boot?.highest === 10)) return false;
    const cookies = await cdp.send("Network.getCookies", { urls: [handle.url] });
''',
        '''  let agentModelFieldsChecked = false;
  const first = await runChrome(`${handle.url}/?ticket=${encodeURIComponent(ticket)}&build=${encodeURIComponent(runtime.buildId)}&launch=chrome-smoke`, profile, async (state, cdp) => {
    if (!(state.mounted && state.rootChildren > 0 && state.text.includes("Agent Bus") && state.search === "" && state.boot?.highest === 10)) return false;
    if (!agentModelFieldsChecked) { await verifyAgentModelFields(cdp); agentModelFieldsChecked = true; }
    const cookies = await cdp.send("Network.getCookies", { urls: [handle.url] });
''',
        "browser form invocation",
    )
    return text


update("scripts/browser-smoke.mjs", patch_browser)


# Lifecycle regression with two isolated homes/ports and an unhealthy target.
def patch_lifecycle(source: str) -> str:
    text = source
    text = replace_once(
        text,
        '''  const stop = runCli(env, "stop");
  assert.equal(stop.status, 0, `stop failed:\n${stop.stdout}\n${stop.stderr}`);
  await waitForDown(url);
''',
        '''  const secondPort = await freePort();
  const secondUrl = `http://127.0.0.1:${secondPort}`;
  const secondEnv = { ...env, AGENT_BUS_HOME: join(temp, "home-b"), AGENT_BUS_PORT: String(secondPort), AGENT_BUS_URL: secondUrl };
  const secondInstanceStart = runCli(secondEnv, "start", "--no-open");
  assert.equal(secondInstanceStart.status, 0, `second isolated instance failed:\n${secondInstanceStart.stdout}\n${secondInstanceStart.stderr}`);
  const secondInstanceHealth = await waitForHealth(secondUrl, (body) => body.product === "agent-bus");

  const stop = runCli(env, "stop");
  assert.equal(stop.status, 0, `stop failed:\n${stop.stdout}\n${stop.stderr}`);
  await waitForDown(url);
  const secondAfterStop = await waitForHealth(secondUrl, (body) => body.product === "agent-bus");
  assert.equal(secondAfterStop.pid, secondInstanceHealth.pid, "stopping instance A must not terminate instance B");
  assert.equal(runCli(secondEnv, "stop").status, 0);
  await waitForDown(secondUrl);
''',
        "two-instance lifecycle regression",
    )
    text = replace_once(
        text,
        '''  assert.equal(runCli(env, "stop").status, 0);
  await waitForDown(url);

  const unrelated = startFixtureServer(port, "unrelated");
''',
        '''  assert.equal(runCli(env, "stop").status, 0);
  await waitForDown(url);

  const unhealthyStart = runCli(env, "start", "--no-open");
  assert.equal(unhealthyStart.status, 0, `unhealthy recovery setup failed:\n${unhealthyStart.stdout}\n${unhealthyStart.stderr}`);
  const unhealthyHealth = await waitForHealth(url, (body) => body.product === "agent-bus");
  process.kill(unhealthyHealth.pid, "SIGSTOP");
  const unhealthyStop = runCli(env, "stop");
  assert.equal(unhealthyStop.status, 0, `unhealthy instance stop failed:\n${unhealthyStop.stdout}\n${unhealthyStop.stderr}`);
  assert.match(`${unhealthyStop.stdout}${unhealthyStop.stderr}`, /forced/i);
  await waitForProcessDown(unhealthyHealth.pid);
  await waitForDown(url);

  const unrelated = startFixtureServer(port, "unrelated");
''',
        "unhealthy lifecycle regression",
    )
    return text


update("scripts/cli-lifecycle-smoke.mjs", patch_lifecycle)


# Final workflow keeps existing macOS Chrome/Safari coverage and adds install-time
# Node, launcher Node, unhealthy custom-home reinstall, and release pruning proof.
def patch_workflow(source: str) -> str:
    text = source
    text = replace_once(text, '      - fix/review-confirmed-issues\n', '', "remove temporary push trigger")
    text = replace_once(text, 'permissions:\n  contents: write\n', 'permissions:\n  contents: read\n', "restore workflow permissions")
    text = replace_regex(text, r'  apply-review-fixes:\n.*?\n  build-and-test:', '  build-and-test:', "remove temporary patch job")
    text = replace_once(text, "    if: github.ref != 'refs/heads/fix/review-confirmed-issues'\n", '', "remove Ubuntu temporary if")
    text = replace_once(text, "    if: github.ref != 'refs/heads/fix/review-confirmed-issues'\n", '', "remove macOS temporary if")
    text = replace_once(
        text,
        '''          export PATH="$STALE_BIN:$AGENT_BUS_INSTALL_DIR:$PATH"
          test "$(command -v agent-bus)" = "$STALE_BIN/agent-bus"

          bash install.sh
''',
        '''          export PATH="$STALE_BIN:$AGENT_BUS_INSTALL_DIR:$PATH"
          test "$(command -v agent-bus)" = "$STALE_BIN/agent-bus"

          REAL_NODE="$(command -v node)"
          OLD_NODE_DIR="$RUNNER_TEMP/old-node-bin"
          mkdir -p "$OLD_NODE_DIR"
          cat > "$OLD_NODE_DIR/node" <<OLDNODE
          #!/bin/sh
          case "\${1:-}" in
            -e) exit 1 ;;
            --version|-v) echo v22.4.0; exit 0 ;;
            *) exec "$REAL_NODE" "\$@" ;;
          esac
          OLDNODE
          chmod +x "$OLD_NODE_DIR/node"
          if PATH="$OLD_NODE_DIR:$PATH" bash install.sh >"$RUNNER_TEMP/old-node-install.out" 2>&1; then
            echo "installer accepted Node 22.4" >&2
            exit 1
          fi
          grep "Node.js 22.5+" "$RUNNER_TEMP/old-node-install.out"

          bash install.sh
''',
        "macOS install Node regression",
    )
    text = replace_once(
        text,
        '''          agent-bus __launcher-info | grep "application=$AGENT_BUS_HOME/app/current"
          test -L "$AGENT_BUS_HOME/app/current"

          cleanup() { agent-bus stop >/dev/null 2>&1 || true; }
''',
        '''          agent-bus __launcher-info | grep "application=$AGENT_BUS_HOME/app/current"
          test -L "$AGENT_BUS_HOME/app/current"
          if AGENT_BUS_NODE_BIN="$OLD_NODE_DIR/node" agent-bus models >"$RUNNER_TEMP/old-node-launch.out" 2>&1; then
            echo "launcher accepted unsupported AGENT_BUS_NODE_BIN" >&2
            exit 1
          fi
          grep "Node.js 22.5+" "$RUNNER_TEMP/old-node-launch.out"

          cleanup() { agent-bus stop >/dev/null 2>&1 || true; }
''',
        "macOS launcher Node regression",
    )
    text = replace_once(
        text,
        '''          first_pid="$(printf '%s' "$health" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).pid')"
          agent-bus start --no-open
          second_pid="$(curl -fsS http://127.0.0.1:7717/health | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).pid')"
          test "$first_pid" = "$second_pid"

          cd "$GITHUB_WORKSPACE"
          bash install.sh
          test "$(cat "$AGENT_BUS_HOME/install-sentinel")" = "preserve-me"
''',
        '''          first_pid="$(printf '%s' "$health" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).pid')"
          agent-bus start --no-open
          second_pid="$(curl -fsS http://127.0.0.1:7717/health | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).pid')"
          test "$first_pid" = "$second_pid"

          for release_id in 11111111111111111111 22222222222222222222 33333333333333333333; do
            mkdir -p "$AGENT_BUS_HOME/app/releases/$release_id"
            printf '%s\n' "$release_id" > "$AGENT_BUS_HOME/app/releases/$release_id/ARTIFACT_ID"
            sleep 0.05
          done
          kill -STOP "$first_pid"

          cd "$GITHUB_WORKSPACE"
          bash install.sh
          test "$(cat "$AGENT_BUS_HOME/install-sentinel")" = "preserve-me"
          for _ in {1..50}; do
            if ! kill -0 "$first_pid" 2>/dev/null; then break; fi
            sleep 0.1
          done
          if kill -0 "$first_pid" 2>/dev/null; then
            echo "unhealthy previous custom-home broker survived reinstall" >&2
            exit 1
          fi
          valid_release_count="$(find "$AGENT_BUS_HOME/app/releases" -mindepth 1 -maxdepth 1 -type d -name '????????????????????' | wc -l | tr -d ' ')"
          test "$valid_release_count" -le 2
''',
        "macOS unhealthy reinstall/pruning regression",
    )
    return text


update(".github/workflows/universal-harness-ci.yml", patch_workflow)

# This helper exists only to get a real checkout for deterministic patching. It
# deletes itself before the resulting product commit is created.
os.remove(__file__)
