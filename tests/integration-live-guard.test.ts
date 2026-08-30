import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startProductServer } from "../src/product-server.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

async function fixture(){
  const root=temporaryDirectory("agent-bus-integration-guard-");
  const operatorTokenPath=join(root,"operator.token");
  const configPath=join(root,"config.json");
  const staticRoot=join(root,"web");
  mkdirSync(staticRoot);
  writeFileSync(join(staticRoot,"index.html"),"<!doctype html><title>Qagent</title><div id=root></div>");
  writeFileSync(configPath,JSON.stringify(testConfig(),null,2));
  const handle=await startProductServer({port:0,configPath,statePath:join(root,"state.sqlite"),logPath:join(root,"bus.jsonl"),operatorTokenPath,staticRoot});
  const token=readFileSync(operatorTokenPath,"utf8").trim();
  const ticketRes=await fetch(`${handle.url}/dashboard/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})});
  const ticket=(await ticketRes.json() as any).ticket;
  const sessionRes=await fetch(`${handle.url}/api/session`,{method:"POST",headers:{origin:handle.url,"content-type":"application/json"},body:JSON.stringify({ticket})});
  const cookie=(sessionRes.headers.get("set-cookie")??"").split(";")[0];
  return {root,handle,configPath,cookie};
}

test("integration edits cannot change dependencies of a supervised agent",async t=>{
  const f=await fixture();t.after(()=>f.handle.close());
  const beforeDisk=JSON.parse(readFileSync(f.configPath,"utf8"));
  const beforeResolved=f.handle.service.config.models["fake-small"];
  (f.handle.service.supervisorMeta as any).set("fake-small",{pid:424242,childPid:null,workdir:f.root,cli:"fake",startedAt:Date.now()});
  const response=await fetch(`${f.handle.url}/api/integrations`,{
    method:"POST",
    headers:{cookie:f.cookie,origin:f.handle.url,"content-type":"application/json"},
    body:JSON.stringify({
      kind:"command",
      providerId:"fake",
      providerName:"mutated fake provider",
      harnessId:"fake",
      command:process.execPath,
      modelId:"fake-small",
      exactModel:"mutated-model",
      family:"mutated-family",
      agentId:"fake-small",
      role:"cheap-worker",
      description:"would split broker and supervisor",
      enabled:true
    })
  });
  const text=await response.text();
  assert.equal(response.status,409,text);
  assert.match(text,/supervis/i);
  const afterDisk=JSON.parse(readFileSync(f.configPath,"utf8"));
  assert.deepEqual(afterDisk,beforeDisk,"rejected integration must not persist any partial config");
  assert.deepEqual(f.handle.service.config.models["fake-small"],beforeResolved,"live broker config must remain unchanged");
});
