#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverHarnessModels, probeHarness } from "./adapters.js";
import { BusConfig, enabledAgents, loadConfig } from "./config.js";
import { recordCurrentAgentBusProcess } from "./instance-processes.js";
import {
  fetchHealth,
  inspectPort,
  stopAgentBusProcesses,
  waitForPortFree,
} from "./process-management.js";
import { BUS_HOME, BUS_PORT, BUS_URL, Run, Task, brokerAlive, brokerCall } from "./protocol.js";
import { productArtifactManifest, PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";
import { OPERATOR_TOKEN_PATH, agentTokenPath, readTokenFile, writePrivateToken } from "./security.js";
import { DASHBOARD_URL, startProductServer } from "./product-server.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI_PATH = join(ROOT, "cli.js");
const STATIC_INDEX = join(ROOT, "dist", "web", "index.html");
const BROKER_LOG = join(BUS_HOME, "broker.log");
const BROKER_LOG_MAX_BYTES = 512 * 1024;
const EXPECTED_MANIFEST = productArtifactManifest(join(ROOT, "dist", "web"));
const EXPECTED_BUILD_ID = EXPECTED_MANIFEST.buildId;
const PROCESS_SCOPE = { applicationRoot: ROOT, busHome: BUS_HOME };

function flag(name:string):string|null{const i=process.argv.indexOf(name);return i>=0?String(process.argv[i+1]??""):null}
function hasFlag(name:string):boolean{return process.argv.includes(name)}
function operatorToken():string{const token=readTokenFile(OPERATOR_TOKEN_PATH);if(!token)throw new Error(`operator token missing at ${OPERATOR_TOKEN_PATH}; start Agent Bus first`);return token}

function isCurrentHealth(health: Awaited<ReturnType<typeof fetchHealth>>): boolean {
  if (!health) return false;
  const runtime = (health as typeof health & { runtime?: { applicationRoot?: string; staticRoot?: string; busHome?: string } }).runtime;
  return health.product === PRODUCT_NAME
    && health.productProtocol === PRODUCT_PROTOCOL_VERSION
    && health.buildId === EXPECTED_BUILD_ID
    && health.dashboard === true
    && health.uiBuilt === true
    && resolve(runtime?.busHome ?? "") === resolve(BUS_HOME)
    && resolve(runtime?.applicationRoot ?? "") === resolve(ROOT)
    && resolve(runtime?.staticRoot ?? "") === resolve(join(ROOT, "dist", "web"));
}

function rotateBrokerLog(): void {
  mkdirSync(BUS_HOME, { recursive: true });
  if (!existsSync(BROKER_LOG)) return;
  try {
    if (statSync(BROKER_LOG).size <= BROKER_LOG_MAX_BYTES) return;
    const previous = `${BROKER_LOG}.1`;
    try { unlinkSync(previous); } catch {}
    renameSync(BROKER_LOG, previous);
  } catch {}
}

function brokerLogTail(maxBytes = 16_000): string {
  try {
    const content = readFileSync(BROKER_LOG, "utf8");
    return content.slice(-maxBytes).trim();
  } catch {
    return "";
  }
}

function unrelatedDiagnostic(owners: Awaited<ReturnType<typeof inspectPort>>): string | null {
  const owner = owners.find((item) => item.kind === "unrelated");
  if (!owner) return null;
  return `Port ${BUS_PORT} is already owned by an unrelated process (PID ${owner.pid}${owner.command ? `: ${owner.command}` : ""}). Agent Bus will not terminate it.`;
}

function sha256(value: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(value)).digest("hex");
}

async function runtimeDiagnostic(): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${BUS_URL}/diagnostics/runtime?probe=${Date.now()}`, {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function verifyServedDashboard(): Promise<void> {
  const nonce = randomBytes(8).toString("hex");
  const assets = [EXPECTED_MANIFEST.index, ...EXPECTED_MANIFEST.scripts, ...EXPECTED_MANIFEST.styles].filter(Boolean) as Array<{path:string;url:string|null;sha256:string}>;
  for (const asset of assets) {
    const pathname = asset.path === "index.html" ? "/" : asset.url;
    if (!pathname) throw new Error(`production manifest has no browser URL for ${asset.path}`);
    const separator = pathname.includes("?") ? "&" : "?";
    const response = await fetch(`${BUS_URL}${pathname}${separator}agent_bus_verify=${nonce}`, {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) throw new Error(`served production asset ${pathname} returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (asset.path.endsWith(".js") && !contentType.includes("javascript")) throw new Error(`served ${pathname} with invalid JavaScript MIME type: ${contentType}`);
    if (asset.path.endsWith(".css") && !contentType.includes("text/css")) throw new Error(`served ${pathname} with invalid CSS MIME type: ${contentType}`);
    const digest = sha256(await response.arrayBuffer());
    if (digest !== asset.sha256) throw new Error(`served ${pathname} hash ${digest.slice(0,12)} does not match installed artifact ${asset.sha256.slice(0,12)}`);
  }
  const remote = await runtimeDiagnostic();
  const remoteBuild = String(remote?.buildId ?? "");
  if (remoteBuild !== EXPECTED_BUILD_ID) throw new Error(`running build ${remoteBuild || "unknown"} does not match installed build ${EXPECTED_BUILD_ID}`);
}

async function ensureBrokerStarted():Promise<void>{
  if (!existsSync(STATIC_INDEX)) {
    throw new Error(`dashboard build missing at ${STATIC_INDEX}; run \`npm run build\` and reinstall Agent Bus`);
  }

  const initialHealth = await fetchHealth(BUS_URL);
  if (isCurrentHealth(initialHealth)) { await verifyServedDashboard(); return; }

  const initialOwners = await inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID, PROCESS_SCOPE);
  const unrelated = unrelatedDiagnostic(initialOwners);
  if (unrelated) throw new Error(unrelated);

  const stopped = await stopAgentBusProcesses({
    port: BUS_PORT,
    url: BUS_URL,
    expectedBuildId: EXPECTED_BUILD_ID,
    includeSupervisors: false,
    busHome: BUS_HOME,
    applicationRoot: ROOT,
  });
  if (stopped.unrelated.length) throw new Error(unrelatedDiagnostic(stopped.unrelated) ?? "Port is occupied by an unrelated process.");
  if (stopped.stoppedPids.length) {
    process.stderr.write(`replaced ${stopped.stoppedPids.length} previous Agent Bus service process(es)${stopped.forcedPids.length ? ` (${stopped.forcedPids.length} required SIGKILL)` : ""}\n`);
  }
  if (!(await waitForPortFree(BUS_PORT, 5000))) {
    const owners = await inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID, PROCESS_SCOPE);
    throw new Error(unrelatedDiagnostic(owners) ?? `Agent Bus could not release port ${BUS_PORT} after stopping the previous instance.`);
  }

  rotateBrokerLog();
  const log = openSync(BROKER_LOG, "a");
  const child = spawn(process.execPath, [CLI_PATH, "broker"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();

  for(let i=0;i<80;i+=1){
    await new Promise(r=>setTimeout(r,120));
    if (isCurrentHealth(await fetchHealth(BUS_URL))) { await verifyServedDashboard(); return; }
    if (child.exitCode !== null) break;
    const owners = await inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID, PROCESS_SCOPE);
    const conflict = unrelatedDiagnostic(owners);
    if (conflict) throw new Error(conflict);
  }

  const finalOwners = await inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID, PROCESS_SCOPE);
  const conflict = unrelatedDiagnostic(finalOwners);
  const tail = brokerLogTail();
  throw new Error([
    `Agent Bus failed to start at ${BUS_URL}.`,
    conflict ?? "The broker process did not become healthy.",
    tail ? `Broker log tail:\n${tail}` : "Broker log did not contain an error.",
    `Log: ${BROKER_LOG}`,
  ].join("\n"));
}

function openUrl(url:string):void{const command=process.platform==="darwin"?"open":process.platform==="win32"?"cmd":"xdg-open";const args=process.platform==="win32"?["/c","start","",url]:[url];const child=spawn(command,args,{detached:true,stdio:"ignore"});child.unref()}

async function browserUrl():Promise<string>{
  await ensureBrokerStarted();
  let response: Response;
  try {
    response = await fetch(`${BUS_URL}/dashboard/login`, {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({token:operatorToken()}),
      signal:AbortSignal.timeout(3000),
    });
  } catch (error) {
    throw new Error(`could not create browser session: ${(error as Error).message}`);
  }
  const text=await response.text();
  if(!response.ok)throw new Error(`could not create browser session (${response.status}): ${text}`);
  let body: {ticket?: string};
  try { body=JSON.parse(text); } catch { throw new Error(`dashboard login returned malformed JSON: ${text.slice(0,500)}`); }
  if(!body.ticket)throw new Error("dashboard login did not return a one-time ticket");
  return `${DASHBOARD_URL}/?ticket=${encodeURIComponent(body.ticket)}&build=${encodeURIComponent(EXPECTED_BUILD_ID)}&launch=${randomBytes(8).toString("hex")}`;
}

async function provisionAgent(id:string,rotate=false):Promise<string>{await ensureBrokerStarted();const existing=readTokenFile(agentTokenPath(id));if(existing&&!rotate)return existing;const response=await brokerCall<{token:string|null;message?:string}>("/agent/provision",{token:operatorToken(),id,rotate});if(!response.token)throw new Error(`${response.message??`identity ${id} already exists`} and ${agentTokenPath(id)} is missing; rerun with --rotate to replace it`);writePrivateToken(agentTokenPath(id),response.token);return response.token}
function startSupervisor(agentId:string,workdir:string):number{mkdirSync(join(BUS_HOME,"logs"),{recursive:true});const log=openSync(join(BUS_HOME,"logs",`${agentId}.out`),"a");const child=spawn(process.execPath,[CLI_PATH,"supervise",agentId,workdir],{detached:true,stdio:["ignore",log,log]});child.unref();return child.pid??0}
function fmtAgo(ts:number):string{const s=Math.max(0,Math.round((Date.now()-ts)/1000));return s<60?`${s}s`:s<3600?`${Math.round(s/60)}m`:`${Math.round(s/3600)}h`}

async function renderState():Promise<string>{const state=await brokerCall<any>("/state",{});const out:string[]=[];out.push("\x1b[1mAGENTS\x1b[0m");for(const agent of state.roster){if(agent.id==="operator")continue;const marker=agent.stalled?"\x1b[31m▲\x1b[0m":agent.status==="working"?"\x1b[33m●\x1b[0m":agent.status==="waiting"||agent.status==="idle"?"\x1b[32m●\x1b[0m":"\x1b[90m○\x1b[0m";out.push(`  ${marker} ${String(agent.id).padEnd(12)} ${String(agent.role).padEnd(15)} ${String(agent.status).padEnd(9)} ${agent.family}/${agent.model} via ${agent.harness}${agent.currentTaskId?` · ${agent.currentTaskId}`:""}`)}out.push("\n\x1b[1mRUNS\x1b[0m");if(!state.runs.length)out.push("  (none)");for(const run of state.runs)out.push(`  ${run.id}  ${run.status.padEnd(9)} ${run.projectRoot} · ${run.goal.slice(0,90)}`);out.push("\n\x1b[1mTASK GRAPH\x1b[0m");const open=state.tasks.filter((t:Task)=>!["accepted","failed","cancelled"].includes(t.state));if(!open.length)out.push("  (no open tasks)");for(const task of open){const indent="  ".repeat(Math.min(6,task.depth+1));out.push(`${indent}${task.id} \x1b[1m${task.state}\x1b[0m ${task.assigner}→${task.assignee||"?"} ${task.role}/c${task.complexity} r${task.round} · ${task.title} · ${fmtAgo(task.updatedAt)}`)}return out.join("\n")}
function printModels(config:BusConfig):void{console.log("MODEL REGISTRY (capabilities are configured heuristics, not objective rankings)\n");for(const model of Object.values(config.models)){const p=config.providers[model.provider];const h=config.harnesses[model.harness];console.log(`${model.enabled?"●":"○"} ${model.id.padEnd(20)} family=${model.family.padEnd(8)} provider=${model.provider.padEnd(10)} harness=${model.harness.padEnd(10)} auth=${p.authKind}`);console.log(`  selector=${model.exactModel??"CLI default"} context=${model.capabilities.contextTokens.toLocaleString()} source=${model.capabilities.source} cost=${model.capabilities.costClass} command=${h.command}`)}}

async function main():Promise<void>{const command=process.argv[2]??"status";switch(command){
case "start":{await ensureBrokerStarted();const url=await browserUrl();if(!hasFlag("--no-open"))openUrl(url);console.log("Agent Bus is running.");console.log(`Dashboard: ${DASHBOARD_URL}`);return}
case "open":{const url=await browserUrl();openUrl(url);console.log(DASHBOARD_URL);return}
case "stop":{const result=await stopAgentBusProcesses({port:BUS_PORT,url:BUS_URL,expectedBuildId:EXPECTED_BUILD_ID,includeSupervisors:true,busHome:BUS_HOME,applicationRoot:ROOT});if(result.unrelated.length)console.log(`Preserved unrelated listener on port ${BUS_PORT}: PID ${result.unrelated[0].pid}${result.unrelated[0].command?` · ${result.unrelated[0].command}`:""}`);console.log(result.stoppedPids.length?`Stopped ${result.stoppedPids.length} Agent Bus process(es)${result.forcedPids.length?` (${result.forcedPids.length} forced)`:""}.`:"Agent Bus is not running.");return}
case "broker":{const removeProcessRecord=recordCurrentAgentBusProcess({busHome:BUS_HOME,port:BUS_PORT,applicationRoot:ROOT,kind:"broker"});try{const handle=await startProductServer();let shuttingDown=false;const shutdown=async()=>{if(shuttingDown)return;shuttingDown=true;await handle.close().catch(()=>{});removeProcessRecord();process.exit(0)};process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);return}catch(error){removeProcessRecord();throw error}}
case "provision":{const id=process.argv[3];if(!id)throw new Error("usage: agent-bus provision <agent-id> [--rotate]");await provisionAgent(id,hasFlag("--rotate"));console.log(`${id} token stored at ${agentTokenPath(id)} (mode 0600)`);return}
case "supervise":{const id=process.argv[3];const workdir=resolve(process.argv[4]??process.cwd());if(!id)throw new Error("usage: agent-bus supervise <agent-id> [workdir]");const removeProcessRecord=recordCurrentAgentBusProcess({busHome:BUS_HOME,port:BUS_PORT,applicationRoot:ROOT,kind:"supervisor",agentId:id});try{const {supervise}=await import("./supervisor.js");await supervise(id,workdir)}finally{removeProcessRecord()}return}
case "run":{const workdir=resolve(process.argv[3]??"");const goal=flag("--goal");if(!process.argv[3]||!goal)throw new Error("usage: agent-bus run <project-dir> --goal \"Implement X\" [--role manager] [--no-autostart]");await ensureBrokerStarted();const config=loadConfig();const started:{id:string;pid:number}[]=[];if(!hasFlag("--no-autostart")){for(const agent of enabledAgents(config).filter(a=>a.autoStart)){await provisionAgent(agent.id);started.push({id:agent.id,pid:startSupervisor(agent.id,workdir)})}if(started.length)await new Promise(r=>setTimeout(r,900))}const response=await brokerCall<{run:Run;rootTask:Task}>("/run/create",{token:operatorToken(),projectRoot:workdir,goal,role:flag("--role")??"manager",network:!hasFlag("--no-network")});console.log(`run: ${response.run.id}`);console.log(`project: ${response.run.projectRoot}`);console.log(`root task: ${response.rootTask.id} → ${response.rootTask.assignee}`);console.log(`routing: ${response.rootTask.routing?.reason??"unavailable"}`);if(started.length)console.log(`supervisors: ${started.map(x=>`${x.id}:${x.pid}`).join(", ")}`);console.log(`dashboard: ${DASHBOARD_URL}`);return}
case "route":{await ensureBrokerStarted();const role=process.argv[3]??"implementation";const response=await brokerCall<any>("/route/preview",{role,complexity:Number(flag("--complexity")??3),contextTokens:Number(flag("--context")??8000),writeAccess:hasFlag("--write"),shell:hasFlag("--shell")||hasFlag("--write"),network:hasFlag("--network"),families:flag("--families")?.split(",").filter(Boolean),providers:flag("--providers")?.split(",").filter(Boolean),exactModel:flag("--model")??undefined,exactAgent:flag("--agent")??undefined,implementationFamily:flag("--implementation-family")??undefined});console.log(response.decision.reason);for(const c of response.decision.candidates)console.log(`  ${c.eligible?"✓":"×"} ${c.agentId.padEnd(14)} ${c.score.toFixed(3)} ${c.rejectedBy.join("; ")}`);return}
case "runtime":{
  const running=await runtimeDiagnostic();
  const payload={local:{buildId:EXPECTED_BUILD_ID,applicationRoot:resolve(ROOT),staticRoot:resolve(join(ROOT,"dist","web")),entrypoint:resolve(process.argv[1]??CLI_PATH),launcherPath:process.env.AGENT_BUS_LAUNCHER_PATH??null,installRoot:process.env.AGENT_BUS_INSTALL_ROOT??null,nodePath:process.execPath,nodeVersion:process.version,cwd:process.cwd(),ui:{index:EXPECTED_MANIFEST.index,scripts:EXPECTED_MANIFEST.scripts,styles:EXPECTED_MANIFEST.styles}},running};
  if(hasFlag("--json")){console.log(JSON.stringify(payload,null,2))}
  else{console.log(`launcher: ${payload.local.launcherPath??"direct node invocation"}`);console.log(`application: ${payload.local.applicationRoot}`);console.log(`static: ${payload.local.staticRoot}`);console.log(`build: ${payload.local.buildId}`);console.log(`running: ${running?JSON.stringify(running):"not running"}`)}
  return
}
case "models":{const config=loadConfig();printModels(config);if(hasFlag("--discover")){console.log("\nLIVE DISCOVERY");const seen=new Set<string>();for(const agent of enabledAgents(config)){if(seen.has(agent.harnessDefinition.id))continue;seen.add(agent.harnessDefinition.id);const result=await discoverHarnessModels(agent);console.log(`  ${result.harness}: ${result.error??(result.models.join(", ")||"no models returned")}`)}}return}
case "doctor":{const config=loadConfig();const seen=new Set<string>();let failures=0;for(const agent of enabledAgents(config)){if(seen.has(agent.harnessDefinition.id))continue;seen.add(agent.harnessDefinition.id);const probe=await probeHarness(agent);if(!probe.available)failures+=1;console.log(`${probe.available?"✓":"×"} ${probe.harness.padEnd(10)} ${probe.version??probe.error}`)}console.log("CLI discovery proves executable availability only. Authentication, subscription entitlement, quota, and exact model access remain live-unverified until a real provider call succeeds.");process.exitCode=failures?1:0;return}
case "status":{if(!(await brokerAlive()))throw new Error(`broker not running at ${BUS_URL}`);console.log(await renderState());return}
case "watch":{if(!(await brokerAlive()))throw new Error(`broker not running at ${BUS_URL}`);const tick=async()=>{const content=await renderState().catch(e=>`broker unreachable: ${e.message}`);process.stdout.write(`\x1b[2J\x1b[H\x1b[1magent-bus\x1b[0m ${new Date().toLocaleTimeString()}\n\n${content}\n`)};await tick();setInterval(tick,1500);return}
case "usage":{if(!(await brokerAlive()))throw new Error(`broker not running at ${BUS_URL}`);const state=await brokerCall<any>("/state",{});for(const agent of state.roster.filter((x:any)=>x.id!=="operator")){const u=agent.usage;console.log(`${agent.id.padEnd(14)} ${agent.provider.padEnd(10)} ${agent.harness.padEnd(10)} ${u.turns} turns · ${u.totalTokens.toLocaleString()} tok · ${Math.round(u.latencyMs/1000)}s${u.costUSD?` · $${u.costUSD.toFixed(4)}`:""}`)}return}
case "send":{await ensureBrokerStarted();const to=process.argv[3];const subject=process.argv[4];const body=process.argv.slice(5).join(" ")||subject;if(!to||!subject)throw new Error("usage: agent-bus send <to> <subject> [body]");console.log(JSON.stringify(await brokerCall("/send",{token:operatorToken(),to,subject,body,type:"info"}),null,2));return}
default:console.log(["agent-bus — local multi-model agent control plane","","  agent-bus start [--no-open]","  agent-bus open","  agent-bus stop","  agent-bus run <project> --goal \"...\"","  agent-bus broker","  agent-bus provision <agent-id> [--rotate]","  agent-bus supervise <agent-id> [workdir]","  agent-bus route <role> [--complexity 1..5] [--write]","  agent-bus models [--discover]","  agent-bus doctor","  agent-bus status | watch | usage","  agent-bus send <to> <subject> [body]","",`  dashboard + broker: ${DASHBOARD_URL} · state: ${BUS_HOME}`].join("\n"))}}
main().catch(error=>{console.error(error?.stack??error?.message??error);process.exit(1)});
