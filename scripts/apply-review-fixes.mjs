#!/usr/bin/env node
import { readFileSync, rmSync, writeFileSync } from "node:fs";

function update(path, transform) {
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`${path}: transform made no change`);
  writeFileSync(path, after);
}

function replaceOnce(text, before, after, label) {
  const index = text.indexOf(before);
  if (index < 0) throw new Error(`missing ${label}`);
  if (text.indexOf(before, index + before.length) >= 0) throw new Error(`ambiguous ${label}`);
  return text.slice(0, index) + after + text.slice(index + before.length);
}

function replaceRegex(text, pattern, replacement, label) {
  if (!pattern.test(text)) throw new Error(`missing ${label}`);
  pattern.lastIndex = 0;
  return text.replace(pattern, replacement);
}

// Instance ownership: remove the global Agent Bus process sweep. Only the target
// listener and processes recorded by the target home+port are eligible to stop.
update("src/process-management.ts", (source) => {
  let text = source;
  text = replaceOnce(text,
    'import { setTimeout as sleep } from "node:timers/promises";\nimport { PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";\n',
    'import { setTimeout as sleep } from "node:timers/promises";\nimport { join, resolve, sep } from "node:path";\nimport { ownedAgentBusPids, processCommand } from "./instance-processes.js";\nimport { PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";\n',
    "process-management imports");
  text = replaceOnce(text,
    '  runtime?: { applicationRoot?: string; staticRoot?: string; entrypoint?: string; nodePath?: string; cwd?: string };\n',
    '  runtime?: { applicationRoot?: string; staticRoot?: string; entrypoint?: string; nodePath?: string; cwd?: string; busHome?: string };\n',
    "health runtime shape");
  text = replaceOnce(text,
    'export interface StopResult {\n  stoppedPids: number[];\n  forcedPids: number[];\n  unrelated: PortOwner[];\n}\n\n',
    'export interface StopResult {\n  stoppedPids: number[];\n  forcedPids: number[];\n  unrelated: PortOwner[];\n}\n\nexport interface AgentBusCommandScope {\n  applicationRoot?: string;\n  busHome?: string;\n}\n\nfunction escapeRegex(value: string): string {\n  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");\n}\n\nfunction runtimeBelongsToScope(health: ProductHealth, scope: AgentBusCommandScope): boolean {\n  if (!scope.busHome) return true;\n  const targetHome = resolve(scope.busHome);\n  const reportedHome = String(health.runtime?.busHome ?? "").trim();\n  if (reportedHome) return resolve(reportedHome) === targetHome;\n  const applicationRoot = String(health.runtime?.applicationRoot ?? "").trim();\n  if (!applicationRoot) return false;\n  const appRoot = join(targetHome, "app");\n  const resolvedApplication = resolve(applicationRoot);\n  return resolvedApplication === appRoot || resolvedApplication.startsWith(`${appRoot}${sep}`);\n}\n\n',
    "command scope helpers");
  text = replaceRegex(text,
    /export function knownAgentBusCommand\(command: string\): boolean \{[\s\S]*?\n\}\n\nfunction legacyHealthShape/,
    `export function knownAgentBusCommand(command: string, scope: AgentBusCommandScope = {}): boolean {\n  const text = command.trim();\n  if (!text) return false;\n  const roots = [\n    String.raw\\`\\\\S*/agent-bus/\\`,\n    String.raw\\`\\\\S*/\\\\.agent-bus/app/(?:current|releases/[^/]+)/\\`,\n  ];\n  if (scope.applicationRoot) roots.push(\\`${'${escapeRegex(resolve(scope.applicationRoot))}'}/\\`);\n  if (scope.busHome) roots.push(\\`${'${escapeRegex(resolve(scope.busHome))}'}/app/(?:current|releases/[^/]+)/\\`);\n  const root = \\`(?:${'${[...new Set(roots)].join("|")}'} )\\`.replace(" )", ")");\n  return new RegExp(String.raw\\`(?:^|\\\\s)(?:\\\\S*node\\\\S*\\\\s+)?${'${root}'}(?:dist/(?:cli|broker|product-server)\\\\.js|cli\\\\.js)(?:\\\\s+(?:broker|dashboard|supervise)(?:\\\\s|$)|\\\\s*$)\\`, "i").test(text)\n    || new RegExp(String.raw\\`(?:^|\\\\s)(?:\\\\S*node\\\\S*\\\\s+)?${'${root}'}src/(?:broker|product-server)\\\\.(?:js|ts)(?:\\\\s|$)\\`, "i").test(text);\n}\n\nfunction legacyHealthShape`,
    "known command matcher");
  text = replaceOnce(text,
    '  legacyCatalogFingerprint = false,\n): PortOwner {\n',
    '  legacyCatalogFingerprint = false,\n  scope: AgentBusCommandScope = {},\n): PortOwner {\n',
    "classification scope parameter");
  text = replaceOnce(text,
    '  if (healthBelongsToPid && health?.product === PRODUCT_NAME) {\n    const current = health.productProtocol === PRODUCT_PROTOCOL_VERSION\n',
    '  if (healthBelongsToPid && health?.product === PRODUCT_NAME) {\n    if (!runtimeBelongsToScope(health, scope)) {\n      return { pid, command, kind: "unrelated", reason: "different Agent Bus instance/home" };\n    }\n    const current = health.productProtocol === PRODUCT_PROTOCOL_VERSION\n',
    "health ownership classification");
  text = replaceOnce(text,
    '  if (knownAgentBusCommand(command)) {\n',
    '  if (knownAgentBusCommand(command, scope)) {\n',
    "scoped command classification");
  text = replaceRegex(text,
    /export function processCommand\(pid: number\): string \{[\s\S]*?\n\}\n\nexport async function fetchHealth/,
    'export async function fetchHealth',
    "remove duplicate processCommand");
  text = replaceOnce(text,
    'export async function inspectPort(port: number, url: string, expectedBuildId: string): Promise<PortOwner[]> {\n',
    'export async function inspectPort(port: number, url: string, expectedBuildId: string, scope: AgentBusCommandScope = {}): Promise<PortOwner[]> {\n',
    "inspectPort scope signature");
  text = replaceOnce(text,
    '  return pids.map((pid) => classifyPortOwner(pid, processCommand(pid), health, expectedBuildId, legacyFingerprint));\n',
    '  return pids.map((pid) => classifyPortOwner(pid, processCommand(pid), health, expectedBuildId, legacyFingerprint, scope));\n',
    "inspectPort scoped classification");
  text = replaceRegex(text,
    /\nfunction knownServicePids\(includeSupervisors: boolean\): number\[] \{[\s\S]*?\n\}\n\nasync function supervisorPids[\s\S]*?\n\}\n\nfunction alive/,
    '\nfunction alive',
    "remove global service and supervisor PID discovery");
  text = replaceOnce(text,
    '  includeSupervisors: boolean;\n}): Promise<StopResult> {\n  const health = await fetchHealth(options.url);\n  const owners = await inspectPort(options.port, options.url, options.expectedBuildId);\n',
    '  includeSupervisors: boolean;\n  busHome?: string;\n  applicationRoot?: string;\n}): Promise<StopResult> {\n  const scope = { busHome: options.busHome, applicationRoot: options.applicationRoot };\n  const owners = await inspectPort(options.port, options.url, options.expectedBuildId, scope);\n',
    "stop ownership options");
  text = replaceOnce(text,
    '  const pids = [\n    ...safeListenerPids,\n    ...knownServicePids(options.includeSupervisors),\n    ...(options.includeSupervisors && !unrelated.length ? await supervisorPids(options.url, health) : []),\n  ];\n',
    '  const ownedPids = options.busHome\n    ? ownedAgentBusPids({ busHome: options.busHome, port: options.port, includeSupervisors: options.includeSupervisors })\n    : [];\n  const pids = [...safeListenerPids, ...ownedPids];\n',
    "instance-owned PID selection");
  return text;
});

// Product server: model definitions stay shared/immutable through the agent editor,
// live supervisors must be stopped before edits, health exposes the owning home,
// and close actively tears down long-lived SSE connections.
update("src/product-server.ts", (source) => {
  let text = source;
  text = replaceOnce(text,
    '  if (message.includes("already") || message.includes("not submitted") || message.includes("not eligible")) return 409;\n',
    '  if (message.includes("already") || message.includes("not submitted") || message.includes("not eligible") || message.includes("stop it before editing")) return 409;\n',
    "agent edit conflict status");
  text = replaceOnce(text,
    '  if (body.modelFamily !== undefined) model.family = String(body.modelFamily).trim() || model.family;\n  if (body.exactModel !== undefined) {\n    const exact = String(body.exactModel).trim();\n    if (exact) model.exactModel = exact; else delete model.exactModel;\n  }\n',
    '  if (body.modelFamily !== undefined || body.exactModel !== undefined) {\n    throw new Error("model definitions are shared; agent edits cannot change model family or exact model");\n  }\n',
    "shared model mutation");
  text = replaceOnce(text,
    '  if (pathname === "/api/agents" && req.method === "POST") {\n    if (!configPath) throw new Error("agent configuration editing is unavailable with an in-memory config");\n    const result = saveAgent(configPath, await readJson(req));\n',
    '  if (pathname === "/api/agents" && req.method === "POST") {\n    if (!configPath) throw new Error("agent configuration editing is unavailable with an in-memory config");\n    const body = await readJson(req);\n    const id = String(body.id ?? "").trim();\n    if (service.supervisorMeta.has(id)) throw new Error(`agent ${id} is supervised; stop it before editing its configuration`);\n    const result = saveAgent(configPath, body);\n',
    "running supervisor edit guard");
  text = replaceOnce(text,
    '    pid: process.pid,\n    applicationRoot: resolve(ROOT),\n',
    '    pid: process.pid,\n    busHome: resolve(BUS_HOME),\n    applicationRoot: resolve(ROOT),\n',
    "runtime home identity");
  text = replaceOnce(text,
    '    close: () => new Promise<void>((resolveClose, reject) => server.close((error) => {\n      service.close();\n      if (error) reject(error); else resolveClose();\n    })),\n',
    '    close: () => new Promise<void>((resolveClose, reject) => {\n      server.close((error) => {\n        service.close();\n        if (error) reject(error); else resolveClose();\n      });\n      server.closeAllConnections();\n    }),\n',
    "SSE-aware server close");
  return text;
});

// CLI process identity and per-instance stop scope.
update("src/cli.ts", (source) => {
  let text = source;
  text = replaceOnce(text,
    'import { BusConfig, enabledAgents, loadConfig } from "./config.js";\n',
    'import { BusConfig, enabledAgents, loadConfig } from "./config.js";\nimport { recordCurrentAgentBusProcess } from "./instance-processes.js";\n',
    "CLI process registry import");
  text = replaceOnce(text,
    'const EXPECTED_BUILD_ID = EXPECTED_MANIFEST.buildId;\n',
    'const EXPECTED_BUILD_ID = EXPECTED_MANIFEST.buildId;\nconst PROCESS_SCOPE = { applicationRoot: ROOT, busHome: BUS_HOME };\n',
    "CLI process scope");
  text = replaceOnce(text,
    '  const runtime = (health as typeof health & { runtime?: { applicationRoot?: string; staticRoot?: string } }).runtime;\n',
    '  const runtime = (health as typeof health & { runtime?: { applicationRoot?: string; staticRoot?: string; busHome?: string } }).runtime;\n',
    "CLI health runtime type");
  text = replaceOnce(text,
    '    && health.uiBuilt === true\n    && resolve(runtime?.applicationRoot ?? "") === resolve(ROOT)\n',
    '    && health.uiBuilt === true\n    && resolve(runtime?.busHome ?? "") === resolve(BUS_HOME)\n    && resolve(runtime?.applicationRoot ?? "") === resolve(ROOT)\n',
    "CLI current home identity");
  text = text.replaceAll('inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID)', 'inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID, PROCESS_SCOPE)');
  text = replaceOnce(text,
    '    expectedBuildId: EXPECTED_BUILD_ID,\n    includeSupervisors: false,\n',
    '    expectedBuildId: EXPECTED_BUILD_ID,\n    includeSupervisors: false,\n    busHome: BUS_HOME,\n    applicationRoot: ROOT,\n',
    "startup stop scope");
  text = replaceOnce(text,
    'case "stop":{const result=await stopAgentBusProcesses({port:BUS_PORT,url:BUS_URL,expectedBuildId:EXPECTED_BUILD_ID,includeSupervisors:true});',
    'case "stop":{const result=await stopAgentBusProcesses({port:BUS_PORT,url:BUS_URL,expectedBuildId:EXPECTED_BUILD_ID,includeSupervisors:true,busHome:BUS_HOME,applicationRoot:ROOT});',
    "CLI stop scope");
  text = replaceOnce(text,
    'case "broker":{const handle=await startProductServer();const shutdown=async()=>{await handle.close().catch(()=>{});process.exit(0)};process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);return}\n',
    'case "broker":{const removeProcessRecord=recordCurrentAgentBusProcess({busHome:BUS_HOME,port:BUS_PORT,applicationRoot:ROOT,kind:"broker"});try{const handle=await startProductServer();let shuttingDown=false;const shutdown=async()=>{if(shuttingDown)return;shuttingDown=true;await handle.close().catch(()=>{});removeProcessRecord();process.exit(0)};process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);return}catch(error){removeProcessRecord();throw error}}\n',
    "broker process registration");
  text = replaceOnce(text,
    'case "supervise":{const id=process.argv[3];const workdir=resolve(process.argv[4]??process.cwd());if(!id)throw new Error("usage: agent-bus supervise <agent-id> [workdir]");const {supervise}=await import("./supervisor.js");await supervise(id,workdir);return}\n',
    'case "supervise":{const id=process.argv[3];const workdir=resolve(process.argv[4]??process.cwd());if(!id)throw new Error("usage: agent-bus supervise <agent-id> [workdir]");const removeProcessRecord=recordCurrentAgentBusProcess({busHome:BUS_HOME,port:BUS_PORT,applicationRoot:ROOT,kind:"supervisor",agentId:id});try{const {supervise}=await import("./supervisor.js");await supervise(id,workdir)}finally{removeProcessRecord()}return}\n',
    "supervisor process registration");
  return text;
});

// Agent modal: model metadata is read-only shared registry data and updates when
// the selected model changes. It is never submitted as an agent mutation.
update("web/src/main.tsx", (source) => {
  let text = source;
  text = replaceOnce(text,
    'autoStart:f.get("autoStart")==="on",exactModel:f.get("exactModel"),modelFamily:f.get("modelFamily"),reasoning:f.get("reasoning"),',
    'autoStart:f.get("autoStart")==="on",reasoning:f.get("reasoning"),',
    "agent form shared model payload");
  text = replaceOnce(text,
    '<label>Model<select value={model} onChange={e=>setModel(e.target.value)}>',
    '<label>Model<select data-agent-model-select="true" value={model} onChange={e=>setModel(e.target.value)}>',
    "agent model select marker");
  text = replaceOnce(text,
    '<label>Exact model<input name="exactModel" defaultValue={modelDef.exactModel||""}/></label><label>Model family<input name="modelFamily" defaultValue={modelDef.family||""}/></label>',
    '<label>Exact model<input data-agent-model-exact="true" value={modelDef.exactModel||""} readOnly/></label><label>Model family<input data-agent-model-family="true" value={modelDef.family||""} readOnly/></label>',
    "controlled model metadata fields");
  return text;
});

// Installer: semantic Node >=22.5 checks at install and launch, then prune valid
// immutable releases only after the new launcher has successfully executed.
update("install.sh", (source) => {
  let text = source;
  text = replaceOnce(text,
    'FALLBACK_NODE_BIN="$(command -v node)"\nNODE_MAJOR="$(node -p \'Number(process.versions.node.split(".")[0])\')"\nif [[ "$NODE_MAJOR" -lt 22 ]]; then\n  echo "Agent Bus requires Node.js 22.5+; found $(node --version) at $FALLBACK_NODE_BIN" >&2\n  exit 1\nfi\n',
    'FALLBACK_NODE_BIN="$(command -v node)"\nif ! "$FALLBACK_NODE_BIN" -e \'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)\'; then\n  echo "Agent Bus requires Node.js 22.5+; found $("$FALLBACK_NODE_BIN" --version 2>/dev/null || echo unknown) at $FALLBACK_NODE_BIN" >&2\n  exit 1\nfi\n',
    "installer Node version check");
  text = replaceOnce(text,
    'NODE_BIN="\\${AGENT_BUS_NODE_BIN:-\\$(command -v node 2>/dev/null || true)}"\nif [ -z "\\$NODE_BIN" ] || [ ! -x "\\$NODE_BIN" ]; then\n  NODE_BIN="$FALLBACK_NODE_BIN"\nfi\nif [ ! -x "\\$NODE_BIN" ]; then\n  echo "Agent Bus requires Node.js 22.5+; no executable Node binary was found." >&2\n  exit 1\nfi\n',
    'node_supported() {\n  "\\$1" -e \'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)\' >/dev/null 2>&1\n}\nNODE_BIN="\\${AGENT_BUS_NODE_BIN:-}"\nif [ -n "\\$NODE_BIN" ]; then\n  if [ ! -x "\\$NODE_BIN" ] || ! node_supported "\\$NODE_BIN"; then\n    echo "Agent Bus requires Node.js 22.5+; AGENT_BUS_NODE_BIN is unsupported: \\$NODE_BIN" >&2\n    exit 1\n  fi\nelse\n  NODE_BIN="\\$(command -v node 2>/dev/null || true)"\n  if [ -z "\\$NODE_BIN" ] || [ ! -x "\\$NODE_BIN" ] || ! node_supported "\\$NODE_BIN"; then\n    NODE_BIN="$FALLBACK_NODE_BIN"\n  fi\n  if [ ! -x "\\$NODE_BIN" ] || ! node_supported "\\$NODE_BIN"; then\n    echo "Agent Bus requires Node.js 22.5+; no supported Node binary was found." >&2\n    exit 1\n  fi\nfi\n',
    "launcher Node version check");
  text = replaceOnce(text,
    '"$RESOLVED_AGENT_BUS" models >/dev/null\n\nprintf \'\\nAgent Bus installed globally:\\n\'\n',
    '"$RESOLVED_AGENT_BUS" models >/dev/null\n\n# Keep the active immutable release plus one previous valid release. Unknown or\n# malformed entries are never removed by pruning.\nprevious_kept=""\nwhile IFS= read -r release_name; do\n  [[ "$release_name" == "$ARTIFACT_ID" ]] && continue\n  [[ "$release_name" =~ ^[0-9a-f]{20}$ ]] || continue\n  release_path="$RELEASES_DIR/$release_name"\n  [[ -d "$release_path" && ! -L "$release_path" && -f "$release_path/ARTIFACT_ID" ]] || continue\n  [[ "$(cat "$release_path/ARTIFACT_ID" 2>/dev/null || true)" == "$release_name" ]] || continue\n  if [[ -z "$previous_kept" ]]; then\n    previous_kept="$release_name"\n    continue\n  fi\n  rm -rf -- "$release_path"\ndone < <(ls -1t "$RELEASES_DIR" 2>/dev/null || true)\n\nprintf \'\\nAgent Bus installed globally:\\n\'\n',
    "release pruning");
  return text;
});

// Unit/integration regressions.
update("tests/process-management.test.ts", (source) => {
  let text = source;
  text = replaceOnce(text,
    '  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/.agent-bus/app/releases/abc123/dist/cli.js broker"), true);\n',
    '  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/.agent-bus/app/releases/abc123/dist/cli.js broker"), true);\n  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /tmp/custom-bus/app/releases/abc123/dist/cli.js broker", { busHome: "/tmp/custom-bus" }), true);\n  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /tmp/other-bus/app/releases/abc123/dist/cli.js broker", { busHome: "/tmp/custom-bus" }), false);\n',
    "custom home command tests");
  text += '\n' + `test("product health from another Agent Bus home is not owned by this instance", () => {\n  const owner = classifyPortOwner(123, "node /tmp/other/app/current/dist/cli.js broker", {\n    ok: true,\n    pid: 123,\n    product: PRODUCT_NAME,\n    productProtocol: PRODUCT_PROTOCOL_VERSION,\n    buildId,\n    dashboard: true,\n    uiBuilt: true,\n    runtime: { busHome: "/tmp/other", applicationRoot: "/tmp/other/app/releases/abc" },\n  }, buildId, false, { busHome: "/tmp/mine", applicationRoot: "/tmp/mine/app/current" });\n  assert.equal(owner.kind, "unrelated");\n  assert.match(owner.reason, /different Agent Bus instance/i);\n});\n`;
  return text;
});

update("tests/product-server.test.ts", (source) => {
  const marker = 'test("malformed JSON is rejected without crashing the product server",async t=>{';
  const tests = `test("closing the product server terminates an open SSE stream without lifecycle escalation",async()=>{\n  const f=await fixture();const cookie=await login(f);\n  const response=await fetch(\\`${'${f.handle.url}'}/api/events\\`,{headers:{cookie}});\n  assert.equal(response.status,200);\n  const reader=response.body!.getReader();await reader.read();\n  await Promise.race([f.handle.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("product server close hung on SSE")),1500))]);\n});\n\ntest("agent edits cannot mutate a shared model definition",async t=>{\n  const f=await fixture();t.after(()=>f.handle.close());const cookie=await login(f);\n  const createPeer=await fetch(\\`${'${f.handle.url}'}/api/agents\\`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({id:"fake-peer",model:"fake-small",role:"cheap-worker",description:"shares fake-small",enabled:true,autoStart:false,permissions:{filesystem:"read",shell:false,network:false,canReview:false,canDelegate:false,maxDelegationDepth:0,allowedPaths:["."]}})});\n  assert.equal(createPeer.status,200,await createPeer.text());\n  const before=JSON.parse(readFileSync(f.configPath,"utf8"));\n  const response=await fetch(\\`${'${f.handle.url}'}/api/agents\\`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({id:"fake-small",model:"fake-small",role:"cheap-worker",exactModel:"silently-mutated",modelFamily:"silently-mutated-family"})});\n  assert.equal(response.status,400);\n  assert.match(await response.text(),/model definitions are shared/i);\n  const after=JSON.parse(readFileSync(f.configPath,"utf8"));\n  assert.deepEqual(after.models["fake-small"],before.models["fake-small"]);\n  assert.equal(after.agents["fake-peer"].model,"fake-small");\n});\n\ntest("running supervisors reject agent configuration edits instead of creating split-brain state",async t=>{\n  const f=await fixture();t.after(()=>f.handle.close());const cookie=await login(f);\n  const before=JSON.parse(readFileSync(f.configPath,"utf8"));\n  (f.handle.service.supervisorMeta as any).set("fake-small",{pid:424242,childPid:null,workdir:f.root,cli:"fake",startedAt:Date.now()});\n  const response=await fetch(\\`${'${f.handle.url}'}/api/agents\\`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({id:"fake-small",model:"fake-strong",role:"cheap-worker",description:"would diverge",enabled:true,autoStart:false,permissions:{filesystem:"read",shell:false,network:false,canReview:false,canDelegate:false,maxDelegationDepth:0,allowedPaths:["."]}})});\n  assert.equal(response.status,409);\n  assert.match(await response.text(),/stop it before editing/i);\n  const after=JSON.parse(readFileSync(f.configPath,"utf8"));\n  assert.deepEqual(after.agents["fake-small"],before.agents["fake-small"]);\n  const catalog=await fetch(\\`${'${f.handle.url}'}/api/catalog\\`,{headers:{cookie}});const body=await catalog.json() as any;\n  assert.equal(body.agents["fake-small"].model,before.agents["fake-small"].model);\n});\n\n`;
  return replaceOnce(source, marker, tests + marker, "product-server regression insertion");
});

// Real browser regression for the formerly uncontrolled model metadata fields.
update("scripts/browser-smoke.mjs", (source) => {
  let text = source;
  text = replaceOnce(text,
    'function sha256(value) {\n',
    `async function verifyAgentModelFields(cdp) {\n  await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.right .pane-head button')?.click()" });\n  await new Promise((resolve) => setTimeout(resolve, 80));\n  async function selectModel(id) {\n    await cdp.send("Runtime.evaluate", { expression: \\`(() => { const select=document.querySelector('[data-agent-model-select=\\"true\\"]'); if(!select) return false; select.value=${'${JSON.stringify(id)}'}; select.dispatchEvent(new Event('change',{bubbles:true})); return true; })()\\`, returnByValue: true });\n    await new Promise((resolve) => setTimeout(resolve, 80));\n    const result = await cdp.send("Runtime.evaluate", { expression: \\`(() => ({ exact: document.querySelector('[data-agent-model-exact=\\"true\\"]')?.value ?? null, family: document.querySelector('[data-agent-model-family=\\"true\\"]')?.value ?? null }))()\\`, returnByValue: true });\n    return result.result?.value;\n  }\n  const small = await selectModel("fake-small");\n  assert.equal(small?.exact, "fake-small");\n  const strong = await selectModel("fake-strong");\n  assert.equal(strong?.exact, "fake-strong", "model metadata must update when the selected model changes");\n  assert.equal(strong?.family, "fake");\n  await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.modal .modal-head button')?.click()" });\n}\n\nfunction sha256(value) {\n`,
    "browser model form helper");
  text = replaceOnce(text,
    '  const first = await runChrome(`${handle.url}/?ticket=${encodeURIComponent(ticket)}&build=${encodeURIComponent(runtime.buildId)}&launch=chrome-smoke`, profile, async (state, cdp) => {\n    if (!(state.mounted && state.rootChildren > 0 && state.text.includes("Agent Bus") && state.search === "" && state.boot?.highest === 10)) return false;\n    const cookies = await cdp.send("Network.getCookies", { urls: [handle.url] });\n',
    '  let agentModelFieldsChecked = false;\n  const first = await runChrome(`${handle.url}/?ticket=${encodeURIComponent(ticket)}&build=${encodeURIComponent(runtime.buildId)}&launch=chrome-smoke`, profile, async (state, cdp) => {\n    if (!(state.mounted && state.rootChildren > 0 && state.text.includes("Agent Bus") && state.search === "" && state.boot?.highest === 10)) return false;\n    if (!agentModelFieldsChecked) { await verifyAgentModelFields(cdp); agentModelFieldsChecked = true; }\n    const cookies = await cdp.send("Network.getCookies", { urls: [handle.url] });\n',
    "browser model form invocation");
  return text;
});

// Lifecycle regression: two homes/ports must be isolated, and a stopped/unhealthy
// target broker must still be recoverable without touching the other instance.
update("scripts/cli-lifecycle-smoke.mjs", (source) => {
  let text = source;
  text = replaceOnce(text,
    '  const stop = runCli(env, "stop");\n  assert.equal(stop.status, 0, `stop failed:\\n${stop.stdout}\\n${stop.stderr}`);\n  await waitForDown(url);\n',
    `  const secondPort = await freePort();\n  const secondUrl = \\`http://127.0.0.1:${'${secondPort}'}\\`;\n  const secondEnv = { ...env, AGENT_BUS_HOME: join(temp, "home-b"), AGENT_BUS_PORT: String(secondPort), AGENT_BUS_URL: secondUrl };\n  const secondInstanceStart = runCli(secondEnv, "start", "--no-open");\n  assert.equal(secondInstanceStart.status, 0, \\`second isolated instance failed:\\n${'${secondInstanceStart.stdout}'}\\n${'${secondInstanceStart.stderr}'}\\`);\n  const secondInstanceHealth = await waitForHealth(secondUrl, (body) => body.product === "agent-bus");\n\n  const stop = runCli(env, "stop");\n  assert.equal(stop.status, 0, \\`stop failed:\\n${'${stop.stdout}'}\\n${'${stop.stderr}'}\\`);\n  await waitForDown(url);\n  const secondAfterStop = await waitForHealth(secondUrl, (body) => body.product === "agent-bus");\n  assert.equal(secondAfterStop.pid, secondInstanceHealth.pid, "stopping instance A must not terminate instance B");\n  assert.equal(runCli(secondEnv, "stop").status, 0);\n  await waitForDown(secondUrl);\n`,
    "cross-instance lifecycle test");
  text = replaceOnce(text,
    '  assert.equal(runCli(env, "stop").status, 0);\n  await waitForDown(url);\n\n  const unrelated = startFixtureServer(port, "unrelated");\n',
    `  assert.equal(runCli(env, "stop").status, 0);\n  await waitForDown(url);\n\n  const unhealthyStart = runCli(env, "start", "--no-open");\n  assert.equal(unhealthyStart.status, 0, \\`unhealthy recovery setup failed:\\n${'${unhealthyStart.stdout}'}\\n${'${unhealthyStart.stderr}'}\\`);\n  const unhealthyHealth = await waitForHealth(url, (body) => body.product === "agent-bus");\n  process.kill(unhealthyHealth.pid, "SIGSTOP");\n  const unhealthyStop = runCli(env, "stop");\n  assert.equal(unhealthyStop.status, 0, \\`unhealthy instance stop failed:\\n${'${unhealthyStop.stdout}'}\\n${'${unhealthyStop.stderr}'}\\`);\n  assert.match(\\`${'${unhealthyStop.stdout}'}${'${unhealthyStop.stderr}'}\\`, /forced/i);\n  await waitForProcessDown(unhealthyHealth.pid);\n  await waitForDown(url);\n\n  const unrelated = startFixtureServer(port, "unrelated");\n`,
    "unhealthy lifecycle recovery test");
  return text;
});

// macOS installed-product regressions for install-time/runtime Node gating,
// unhealthy custom-home reinstall, release pruning, and preserved Chrome/Safari.
update(".github/workflows/universal-harness-ci.yml", (source) => {
  let text = source;
  text = text.replace('      - fix/review-confirmed-issues\n', '');
  text = text.replace('  contents: write\n', '  contents: read\n');
  text = replaceRegex(text,
    /  apply-review-fixes:\n[\s\S]*?\n  build-and-test:/,
    '  build-and-test:',
    "remove temporary self-patch job");
  text = replaceOnce(text,
    '          export PATH="$STALE_BIN:$AGENT_BUS_INSTALL_DIR:$PATH"\n          test "$(command -v agent-bus)" = "$STALE_BIN/agent-bus"\n\n          bash install.sh\n',
    '          export PATH="$STALE_BIN:$AGENT_BUS_INSTALL_DIR:$PATH"\n          test "$(command -v agent-bus)" = "$STALE_BIN/agent-bus"\n\n          REAL_NODE="$(command -v node)"\n          OLD_NODE_DIR="$RUNNER_TEMP/old-node-bin"\n          mkdir -p "$OLD_NODE_DIR"\n          cat > "$OLD_NODE_DIR/node" <<OLDNODE\n          #!/bin/sh\n          case "\\${1:-}" in\n            -e) exit 1 ;;\n            --version|-v) echo v22.4.0; exit 0 ;;\n            *) exec "$REAL_NODE" "\\$@" ;;\n          esac\n          OLDNODE\n          chmod +x "$OLD_NODE_DIR/node"\n          if PATH="$OLD_NODE_DIR:$PATH" bash install.sh >"$RUNNER_TEMP/old-node-install.out" 2>&1; then\n            echo "installer accepted Node 22.4" >&2\n            exit 1\n          fi\n          grep "Node.js 22.5+" "$RUNNER_TEMP/old-node-install.out"\n\n          bash install.sh\n',
    "macOS install Node regression");
  text = replaceOnce(text,
    '          agent-bus __launcher-info | grep "application=$AGENT_BUS_HOME/app/current"\n          test -L "$AGENT_BUS_HOME/app/current"\n\n          cleanup() { agent-bus stop >/dev/null 2>&1 || true; }\n',
    '          agent-bus __launcher-info | grep "application=$AGENT_BUS_HOME/app/current"\n          test -L "$AGENT_BUS_HOME/app/current"\n          if AGENT_BUS_NODE_BIN="$OLD_NODE_DIR/node" agent-bus models >"$RUNNER_TEMP/old-node-launch.out" 2>&1; then\n            echo "launcher accepted unsupported AGENT_BUS_NODE_BIN" >&2\n            exit 1\n          fi\n          grep "Node.js 22.5+" "$RUNNER_TEMP/old-node-launch.out"\n\n          cleanup() { agent-bus stop >/dev/null 2>&1 || true; }\n',
    "macOS launcher Node regression");
  text = replaceOnce(text,
    '          first_pid="$(printf \'%s\' "$health" | node -pe \'JSON.parse(require("fs").readFileSync(0,"utf8")).pid\')"\n          agent-bus start --no-open\n          second_pid="$(curl -fsS http://127.0.0.1:7717/health | node -pe \'JSON.parse(require("fs").readFileSync(0,"utf8")).pid\')"\n          test "$first_pid" = "$second_pid"\n\n          cd "$GITHUB_WORKSPACE"\n          bash install.sh\n',
    '          first_pid="$(printf \'%s\' "$health" | node -pe \'JSON.parse(require("fs").readFileSync(0,"utf8")).pid\')"\n          agent-bus start --no-open\n          second_pid="$(curl -fsS http://127.0.0.1:7717/health | node -pe \'JSON.parse(require("fs").readFileSync(0,"utf8")).pid\')"\n          test "$first_pid" = "$second_pid"\n\n          for release_id in 11111111111111111111 22222222222222222222 33333333333333333333; do\n            mkdir -p "$AGENT_BUS_HOME/app/releases/$release_id"\n            printf \'%s\\n\' "$release_id" > "$AGENT_BUS_HOME/app/releases/$release_id/ARTIFACT_ID"\n            sleep 0.05\n          done\n          kill -STOP "$first_pid"\n\n          cd "$GITHUB_WORKSPACE"\n          bash install.sh\n          if kill -0 "$first_pid" 2>/dev/null; then\n            echo "unhealthy previous custom-home broker survived reinstall" >&2\n            exit 1\n          fi\n          valid_release_count="$(find "$AGENT_BUS_HOME/app/releases" -mindepth 1 -maxdepth 1 -type d -name \'????????????????????\' | wc -l | tr -d \' \')"\n          test "$valid_release_count" -le 2\n',
    "macOS unhealthy reinstall and pruning regression");
  return text;
});

// The helper is intentionally ephemeral; the generated fix commit contains only
// product code/tests, not a repository self-modifier.
rmSync(new URL(import.meta.url));
