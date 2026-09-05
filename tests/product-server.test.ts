import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startProductServer } from "../src/product-server.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

async function fixture(){
  const root=temporaryDirectory("agent-bus-product-");
  const operatorTokenPath=join(root,"operator.token");
  const configPath=join(root,"config.json");
  const staticRoot=join(root,"web");
  mkdirSync(staticRoot);
  writeFileSync(join(staticRoot,"index.html"),"<!doctype html><title>Qagent React</title><div id=root></div>");
  writeFileSync(configPath,JSON.stringify(testConfig(),null,2));
  const handle=await startProductServer({port:0,configPath,statePath:join(root,"state.sqlite"),logPath:join(root,"bus.jsonl"),operatorTokenPath,staticRoot});
  const token=readFileSync(operatorTokenPath,"utf8").trim();
  return {root,handle,token,configPath};
}

async function login(f:Awaited<ReturnType<typeof fixture>>){
  const ticketRes=await fetch(`${f.handle.url}/dashboard/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:f.token})});
  assert.equal(ticketRes.status,200);
  const ticket=(await ticketRes.json() as any).ticket;
  const sessionRes=await fetch(`${f.handle.url}/api/session`,{method:"POST",headers:{origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({ticket})});
  assert.equal(sessionRes.status,200);
  return (sessionRes.headers.get("set-cookie")??"").split(";")[0];
}

test("single localhost server serves SPA but does not authenticate direct visitors",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());
  const page=await fetch(`${f.handle.url}/`);assert.equal(page.status,200);assert.match(await page.text(),/Qagent React/);assert.equal(page.headers.get("set-cookie"),null);
  assert.equal((await fetch(`${f.handle.url}/api/state`)).status,401);
  const bad=await fetch(`${f.handle.url}/dashboard/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:"wrong"})});assert.equal(bad.status,401);
});

test("one-time CLI ticket exchanges for HttpOnly session and cannot be replayed",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());
  const first=await fetch(`${f.handle.url}/dashboard/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:f.token})});
  const ticket=(await first.json() as any).ticket;
  const exchange=await fetch(`${f.handle.url}/api/session`,{method:"POST",headers:{origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({ticket})});
  assert.match(exchange.headers.get("set-cookie")??"",/HttpOnly/);
  const replay=await fetch(`${f.handle.url}/api/session`,{method:"POST",headers:{origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({ticket})});assert.equal(replay.status,401);
});

test("browser API persists projects/runs, requires same-origin mutations, and can stop a run",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());const cookie=await login(f);
  const noOrigin=await fetch(`${f.handle.url}/api/projects`,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({path:f.root})});assert.equal(noOrigin.status,401);
  const project=await fetch(`${f.handle.url}/api/projects`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({path:f.root})});assert.equal(project.status,200);
  const runRes=await fetch(`${f.handle.url}/api/runs`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({projectRoot:f.root,goal:"exercise product server"})});
  const runText=await runRes.text();assert.equal(runRes.status,200,runText);const runBody=JSON.parse(runText);const run=runBody.run;
  const stop=await fetch(`${f.handle.url}/api/runs/${run.id}/stop`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({reason:"test stop"})});
  const stopText=await stop.text();assert.equal(stop.status,200,stopText);const stopped=JSON.parse(stopText);assert.equal(stopped.run.status,"cancelled");assert.ok(stopped.tasks.every((task:any)=>["accepted","failed","cancelled"].includes(task.state)));
  const projectList=await fetch(`${f.handle.url}/api/projects`,{headers:{cookie}});assert.ok((await projectList.json() as any).projects.some((p:any)=>p.path===f.root));
});

test("SSE is session protected and emits real broker snapshots",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());assert.equal((await fetch(`${f.handle.url}/api/events`)).status,401);const cookie=await login(f);
  const controller=new AbortController();const response=await fetch(`${f.handle.url}/api/events`,{headers:{cookie},signal:controller.signal});assert.equal(response.status,200);assert.match(response.headers.get("content-type")??"",/text\/event-stream/);
  const reader=response.body!.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/connected|snapshot/);controller.abort();
});

test("agent editor updates config and live catalog without broker restart",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());const cookie=await login(f);
  const response=await fetch(`${f.handle.url}/api/agents`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({id:"fake-small",model:"fake-small",role:"cheap-worker",description:"edited live",enabled:true,autoStart:true,resumeSessionId:"original-chat",reasoning:"high",permissions:{filesystem:"read",shell:false,network:false,canReview:false,canDelegate:false,maxDelegationDepth:0,allowedPaths:["."]}})});
  const responseText=await response.text();assert.equal(response.status,200,responseText);
  const catalog=await fetch(`${f.handle.url}/api/catalog`,{headers:{cookie}});const body=await catalog.json() as any;assert.equal(body.agents["fake-small"].description,"edited live");assert.equal(body.agents["fake-small"].autoStart,true);assert.equal(body.agents["fake-small"].resumeSessionId,"original-chat");
  const disk=JSON.parse(readFileSync(f.configPath,"utf8"));assert.equal(disk.agents["fake-small"].description,"edited live");
});

test("closing the product server terminates an open SSE stream without lifecycle escalation",async()=>{
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

test("malformed JSON is rejected without crashing the product server",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());const cookie=await login(f);
  const response=await fetch(`${f.handle.url}/api/messages`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:"{"});assert.equal(response.status,400);assert.equal((await fetch(`${f.handle.url}/health`)).status,200);
});

test("first-run setup is required until the operator completes configuration",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());
  assert.equal((await fetch(`${f.handle.url}/api/setup`)).status,401);
  const cookie=await login(f);
  const fresh=await fetch(`${f.handle.url}/api/setup`,{headers:{cookie}});
  const freshBody=await fresh.json() as any;
  assert.equal(fresh.status,200);assert.equal(freshBody.completed,false);assert.equal(freshBody.required,true);
  const constraints=await fetch(`${f.handle.url}/api/constraints`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({maxDelegationDepth:2,independentReviewComplexity:4,maxRetries:1})});
  assert.equal(constraints.status,200,await constraints.clone().text());
  const provider=await fetch(`${f.handle.url}/api/providers`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({id:"fake",enabled:true})});
  assert.equal(provider.status,200,await provider.clone().text());
  const done=await fetch(`${f.handle.url}/api/setup`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({completed:true})});
  const doneBody=await done.json() as any;
  assert.equal(done.status,200);assert.equal(doneBody.completed,true);assert.equal(doneBody.required,false);
  const disk=JSON.parse(readFileSync(f.configPath,"utf8"));
  assert.equal(disk.constraints.maxDelegationDepth,2);
  assert.equal(disk.constraints.maxRetries,1);
  assert.equal(disk.providers.fake.enabled,true);
});

test("appearance colors persist through catalog and reject invalid hex",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());const cookie=await login(f);
  const bad=await fetch(`${f.handle.url}/api/appearance`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({accent:"blue"})});
  assert.equal(bad.status,400);assert.match(await bad.text(),/appearance\.accent must be a #RRGGBB color/);
  const ok=await fetch(`${f.handle.url}/api/appearance`,{method:"POST",headers:{cookie,origin:f.handle.url,"content-type":"application/json"},body:JSON.stringify({accent:"#FF5500",bg:"#111111"})});
  const okText=await ok.text();assert.equal(ok.status,200,okText);
  const saved=JSON.parse(okText);
  assert.equal(saved.appearance.accent,"#ff5500");
  assert.equal(saved.appearance.bg,"#111111");
  assert.equal(saved.appearance.text,"#e4e4e4");
  const catalog=await fetch(`${f.handle.url}/api/catalog`,{headers:{cookie}});
  const body=await catalog.json() as any;
  assert.equal(body.appearance.accent,"#ff5500");
  assert.equal(body.appearance.bg,"#111111");
  const disk=JSON.parse(readFileSync(f.configPath,"utf8"));
  assert.equal(disk.appearance.accent,"#ff5500");
  assert.equal(disk.appearance.bg,"#111111");
});
