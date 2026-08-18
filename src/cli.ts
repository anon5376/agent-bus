#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverHarnessModels, probeHarness } from "./adapters.js";
import { BusConfig, enabledAgents, loadConfig } from "./config.js";
import { BUS_HOME, BUS_URL, Run, Task, brokerAlive, brokerCall } from "./protocol.js";
import { OPERATOR_TOKEN_PATH, agentTokenPath, readTokenFile, writePrivateToken } from "./security.js";
import { DASHBOARD_URL, startProductServer } from "./product-server.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI_PATH = join(ROOT, "cli.js");

function flag(name:string):string|null{const i=process.argv.indexOf(name);return i>=0?String(process.argv[i+1]??""):null}
function hasFlag(name:string):boolean{return process.argv.includes(name)}
function operatorToken():string{const token=readTokenFile(OPERATOR_TOKEN_PATH);if(!token)throw new Error(`operator token missing at ${OPERATOR_TOKEN_PATH}; start the broker first`);return token}

async function productAlive():Promise<boolean>{
  try{
    const response=await fetch(`${BUS_URL}/health`,{signal:AbortSignal.timeout(1200)});
    if(!response.ok)return false;
    const body=await response.json() as {dashboard?:boolean};
    return body.dashboard===true;
  }catch{return false}
}

function legacyServicePids(includeSupervisors=false):number[]{
  if(process.platform==="win32")return[];
  try{
    const output=execFileSync("ps",["-axo","pid=,command="],{encoding:"utf8"});
    const action=includeSupervisors?"(?:broker|dashboard|supervise)":"(?:broker|dashboard)";
    const pattern=new RegExp(`\\/agent-bus\\/.*(?:dist\\/cli\\.js|cli\\.js)\\s+${action}(?:\\s|$)`);
    return output.split("\n").map(line=>{
      const match=line.trim().match(/^(\d+)\s+(.+)$/);
      if(!match||!pattern.test(match[2]))return 0;
      return Number(match[1]);
    }).filter(pid=>pid>0&&pid!==process.pid);
  }catch{return[]}
}

async function stopLegacyServices(includeSupervisors=false):Promise<number>{
  const pids=[...new Set(legacyServicePids(includeSupervisors))];
  for(const pid of pids){
    try{process.kill(-pid,"SIGTERM")}catch{try{process.kill(pid,"SIGTERM")}catch{/* already gone */}}
  }
  if(pids.length)await new Promise(resolve=>setTimeout(resolve,500));
  return pids.length;
}

async function ensureBrokerStarted():Promise<void>{
  if(await productAlive())return;
  if(await brokerAlive()||legacyServicePids(false).length){
    const stopped=await stopLegacyServices(false);
    if(stopped)process.stderr.write(`replaced ${stopped} legacy Agent Bus service process(es)\n`);
    for(let i=0;i<25&&await brokerAlive();i+=1)await new Promise(r=>setTimeout(r,80));
  }
  mkdirSync(BUS_HOME,{recursive:true});
  const log=openSync(join(BUS_HOME,"broker.log"),"a");
  spawn(process.execPath,[CLI_PATH,"broker"],{detached:true,stdio:["ignore",log,log]}).unref();
  for(let i=0;i<60;i+=1){await new Promise(r=>setTimeout(r,120));if(await productAlive())return}
  throw new Error(`could not start Agent Bus; see ${join(BUS_HOME,"broker.log")}`);
}

function openUrl(url:string):void{const command=process.platform==="darwin"?"open":process.platform==="win32"?"cmd":"xdg-open";const args=process.platform==="win32"?["/c","start","",url]:[url];spawn(command,args,{detached:true,stdio:"ignore"}).unref()}
async function browserUrl():Promise<string>{await ensureBrokerStarted();const response=await fetch(`${BUS_URL}/dashboard/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:operatorToken()}),signal:AbortSignal.timeout(3000)});const text=await response.text();if(!response.ok)throw new Error(`could not create dashboard session: ${text}`);const body=JSON.parse(text) as {ticket:string};return `${DASHBOARD_URL}/?ticket=${encodeURIComponent(body.ticket)}`}

async function provisionAgent(id:string,rotate=false):Promise<string>{await ensureBrokerStarted();const existing=readTokenFile(agentTokenPath(id));if(existing&&!rotate)return existing;const response=await brokerCall<{token:string|null;message?:string}>("/agent/provision",{token:operatorToken(),id,rotate});if(!response.token)throw new Error(`${response.message??`identity ${id} already exists`} and ${agentTokenPath(id)} is missing; rerun with --rotate to replace it`);writePrivateToken(agentTokenPath(id),response.token);return response.token}
function startSupervisor(agentId:string,workdir:string):number{mkdirSync(join(BUS_HOME,"logs"),{recursive:true});const log=openSync(join(BUS_HOME,"logs",`${agentId}.out`),"a");const child=spawn(process.execPath,[CLI_PATH,"supervise",agentId,workdir],{detached:true,stdio:["ignore",log,log]});child.unref();return child.pid??0}
function fmtAgo(ts:number):string{const s=Math.max(0,Math.round((Date.now()-ts)/1000));return s<60?`${s}s`:s<3600?`${Math.round(s/60)}m`:`${Math.round(s/3600)}h`}

async function renderState():Promise<string>{const state=await brokerCall<any>("/state",{});const out:string[]=[];out.push("\x1b[1mAGENTS\x1b[0m");for(const agent of state.roster){if(agent.id==="operator")continue;const marker=agent.stalled?"\x1b[31m▲\x1b[0m":agent.status==="working"?"\x1b[33m●\x1b[0m":agent.status==="waiting"||agent.status==="idle"?"\x1b[32m●\x1b[0m":"\x1b[90m○\x1b[0m";out.push(`  ${marker} ${String(agent.id).padEnd(12)} ${String(agent.role).padEnd(15)} ${String(agent.status).padEnd(9)} ${agent.family}/${agent.model} via ${agent.harness}${agent.currentTaskId?` · ${agent.currentTaskId}`:""}`)}out.push("\n\x1b[1mRUNS\x1b[0m");if(!state.runs.length)out.push("  (none)");for(const run of state.runs)out.push(`  ${run.id}  ${run.status.padEnd(9)} ${run.projectRoot} · ${run.goal.slice(0,90)}`);out.push("\n\x1b[1mTASK GRAPH\x1b[0m");const open=state.tasks.filter((t:Task)=>!["accepted","failed","cancelled"].includes(t.state));if(!open.length)out.push("  (no open tasks)");for(const task of open){const indent="  ".repeat(Math.min(6,task.depth+1));out.push(`${indent}${task.id} \x1b[1m${task.state}\x1b[0m ${task.assigner}→${task.assignee||"?"} ${task.role}/c${task.complexity} r${task.round} · ${task.title} · ${fmtAgo(task.updatedAt)}`)}return out.join("\n")}
function printModels(config:BusConfig):void{console.log("MODEL REGISTRY (capabilities are configured heuristics, not objective rankings)\n");for(const model of Object.values(config.models)){const p=config.providers[model.provider];const h=config.harnesses[model.harness];console.log(`${model.enabled?"●":"○"} ${model.id.padEnd(20)} family=${model.family.padEnd(8)} provider=${model.provider.padEnd(10)} harness=${model.harness.padEnd(10)} auth=${p.authKind}`);console.log(`  selector=${model.exactModel??"CLI default"} context=${model.capabilities.contextTokens.toLocaleString()} source=${model.capabilities.source} cost=${model.capabilities.costClass} command=${h.command}`)}}

async function main():Promise<void>{const command=process.argv[2]??"status";switch(command){
case "start":{await ensureBrokerStarted();const url=await browserUrl();if(!hasFlag("--no-open"))openUrl(url);console.log("Agent Bus is running.");console.log(`Dashboard: ${DASHBOARD_URL}`);return}
case "open":{const url=await browserUrl();openUrl(url);console.log(DASHBOARD_URL);return}
case "stop":{const stopped=await stopLegacyServices(true);console.log(stopped?`Stopped ${stopped} Agent Bus process(es).`:"Agent Bus is not running.");return}
case "broker":{const handle=await startProductServer();const shutdown=async()=>{await handle.close().catch(()=>{});process.exit(0)};process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);return}
case "provision":{const id=process.argv[3];if(!id)throw new Error("usage: agent-bus provision <agent-id> [--rotate]");await provisionAgent(id,hasFlag("--rotate"));console.log(`${id} token stored at ${agentTokenPath(id)} (mode 0600)`);return}
case "supervise":{const id=process.argv[3];const workdir=resolve(process.argv[4]??process.cwd());if(!id)throw new Error("usage: agent-bus supervise <agent-id> [workdir]");const {supervise}=await import("./supervisor.js");await supervise(id,workdir);return}
case "run":{const workdir=resolve(process.argv[3]??"");const goal=flag("--goal");if(!process.argv[3]||!goal)throw new Error("usage: agent-bus run <project-dir> --goal \"Implement X\" [--role manager] [--no-autostart]");await ensureBrokerStarted();const config=loadConfig();const started:{id:string;pid:number}[]=[];if(!hasFlag("--no-autostart")){for(const agent of enabledAgents(config).filter(a=>a.autoStart)){await provisionAgent(agent.id);started.push({id:agent.id,pid:startSupervisor(agent.id,workdir)})}if(started.length)await new Promise(r=>setTimeout(r,900))}const response=await brokerCall<{run:Run;rootTask:Task}>("/run/create",{token:operatorToken(),projectRoot:workdir,goal,role:flag("--role")??"manager",network:!hasFlag("--no-network")});console.log(`run: ${response.run.id}`);console.log(`project: ${response.run.projectRoot}`);console.log(`root task: ${response.rootTask.id} → ${response.rootTask.assignee}`);console.log(`routing: ${response.rootTask.routing?.reason??"unavailable"}`);if(started.length)console.log(`supervisors: ${started.map(x=>`${x.id}:${x.pid}`).join(", ")}`);console.log(`dashboard: ${DASHBOARD_URL}`);return}
case "route":{await ensureBrokerStarted();const role=process.argv[3]??"implementation";const response=await brokerCall<any>("/route/preview",{role,complexity:Number(flag("--complexity")??3),contextTokens:Number(flag("--context")??8000),writeAccess:hasFlag("--write"),shell:hasFlag("--shell")||hasFlag("--write"),network:hasFlag("--network"),families:flag("--families")?.split(",").filter(Boolean),providers:flag("--providers")?.split(",").filter(Boolean),exactModel:flag("--model")??undefined,exactAgent:flag("--agent")??undefined,implementationFamily:flag("--implementation-family")??undefined});console.log(response.decision.reason);for(const c of response.decision.candidates)console.log(`  ${c.eligible?"✓":"×"} ${c.agentId.padEnd(14)} ${c.score.toFixed(3)} ${c.rejectedBy.join("; ")}`);return}
case "models":{const config=loadConfig();printModels(config);if(hasFlag("--discover")){console.log("\nLIVE DISCOVERY");const seen=new Set<string>();for(const agent of enabledAgents(config)){if(seen.has(agent.harnessDefinition.id))continue;seen.add(agent.harnessDefinition.id);const result=await discoverHarnessModels(agent);console.log(`  ${result.harness}: ${result.error??(result.models.join(", ")||"no models returned")}`)}}return}
case "doctor":{const config=loadConfig();const seen=new Set<string>();let failures=0;for(const agent of enabledAgents(config)){if(seen.has(agent.harnessDefinition.id))continue;seen.add(agent.harnessDefinition.id);const probe=await probeHarness(agent);if(!probe.available)failures+=1;console.log(`${probe.available?"✓":"×"} ${probe.harness.padEnd(10)} ${probe.version??probe.error}`)}console.log("CLI discovery proves executable availability only. Authentication, subscription entitlement, quota, and exact model access remain live-unverified until a real provider call succeeds.");process.exitCode=failures?1:0;return}
case "status":{if(!(await brokerAlive()))throw new Error(`broker not running at ${BUS_URL}`);console.log(await renderState());return}
case "watch":{if(!(await brokerAlive()))throw new Error(`broker not running at ${BUS_URL}`);const tick=async()=>{const content=await renderState().catch(e=>`broker unreachable: ${e.message}`);process.stdout.write(`\x1b[2J\x1b[H\x1b[1magent-bus\x1b[0m ${new Date().toLocaleTimeString()}\n\n${content}\n`)};await tick();setInterval(tick,1500);return}
case "usage":{if(!(await brokerAlive()))throw new Error(`broker not running at ${BUS_URL}`);const state=await brokerCall<any>("/state",{});for(const agent of state.roster.filter((x:any)=>x.id!=="operator")){const u=agent.usage;console.log(`${agent.id.padEnd(14)} ${agent.provider.padEnd(10)} ${agent.harness.padEnd(10)} ${u.turns} turns · ${u.totalTokens.toLocaleString()} tok · ${Math.round(u.latencyMs/1000)}s${u.costUSD?` · $${u.costUSD.toFixed(4)}`:""}`)}return}
case "send":{await ensureBrokerStarted();const to=process.argv[3];const subject=process.argv[4];const body=process.argv.slice(5).join(" ")||subject;if(!to||!subject)throw new Error("usage: agent-bus send <to> <subject> [body]");console.log(JSON.stringify(await brokerCall("/send",{token:operatorToken(),to,subject,body,type:"info"}),null,2));return}
default:console.log(["agent-bus — local multi-model agent control plane","","  agent-bus start [--no-open]","  agent-bus open","  agent-bus stop","  agent-bus run <project> --goal \"...\"","  agent-bus broker","  agent-bus provision <agent-id> [--rotate]","  agent-bus supervise <agent-id> [workdir]","  agent-bus route <role> [--complexity 1..5] [--write]","  agent-bus models [--discover]","  agent-bus doctor","  agent-bus status | watch | usage","  agent-bus send <to> <subject> [body]","",`  dashboard + broker: ${DASHBOARD_URL} · state: ${BUS_HOME}`].join("\n"))}}
main().catch(error=>{console.error(error?.stack??error?.message??error);process.exit(1)});