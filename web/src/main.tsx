import "./entry.ts";
import { Component, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { BusSnapshot, Message, RosterEntry as Agent, Run, Task } from "../../src/protocol.ts";
import "./styles.css";

const bootMonitor=()=>((window as any).__AGENT_BUS_BOOT__ as {checkpoint?:(number:number,detail?:unknown)=>void;fail?:(title:string,detail:unknown)=>void;diagnose?:(title:string,detail:unknown)=>void;record?:(kind:string,detail:unknown)=>void}|undefined);
const checkpoint=(number:number,detail?:unknown)=>bootMonitor()?.checkpoint?.(number,detail);
checkpoint(3,"React application module evaluated");
checkpoint(4,"React and react-dom/client imports resolved");

type Snapshot = BusSnapshot;
type Catalog = { providers:Record<string,any>; harnesses:Record<string,any>; models:Record<string,any>; roles:Record<string,any>; agents:Record<string,any>; capabilityNotice:string; constraints:{maxDelegationDepth:number;maxConcurrentTasks:number;maxRetries:number;independentReviewComplexity:number;preferSubscription:boolean} };
type Project = { path:string; name:string; createdAt:number; lastUsedAt:number };
type ProviderStatus = { id:string; displayName:string; configured:boolean; enabled?:boolean; cliFound:boolean; authKind:string; authSource:string; loginCommand?:string; installHint?:string; apiKeyEnv?:string; command?:string; resolvedPath?:string|null; version?:string|null; error?:string|null; harnessId?:string; liveVerification:string; harnesses:any[] };
type SetupStatus = { completed:boolean; completedAt:number|null; required:boolean };
type View = "setup" | "console";

const empty: Snapshot = { roster:[], tasks:[], runs:[], waiting:[], telemetry:[], pathLeases:[], revision:0, configIdentity:{path:null,digest:""}, messages:[], seq:0, brokerPid:0 };

async function api<T=any>(path:string, init:RequestInit={}):Promise<T>{
  const res=await fetch(path,{credentials:"same-origin",headers:{"content-type":"application/json",...(init.headers||{})},...init});
  const text=await res.text(); const body=text?JSON.parse(text):{};
  if(!res.ok) throw new Error(body.error||`HTTP ${res.status}`); return body as T;
}
const post=<T=any>(path:string, body:any={})=>api<T>(path,{method:"POST",body:JSON.stringify(body)});
const fmtTokens=(n:number)=>n>=1_000_000?`${(n/1_000_000).toFixed(1)}m`:n>=1000?`${(n/1000).toFixed(1)}k`:String(n||0);

class AppErrorBoundary extends Component<{children:ReactNode},{error:string|null}>{
  state={error:null as string|null};
  static getDerivedStateFromError(error:unknown){return{error:error instanceof Error?error.message:String(error)}}
  componentDidCatch(error:unknown){bootMonitor()?.fail?.("Agent Bus React error boundary",error);(globalThis as any).__AGENT_BUS_BOOTSTRAP__={phase:"react-error",error:error instanceof Error?error.message:String(error)}}
  render(){if(this.state.error)return <main className="lock"><div className="lock-card"><div className="mark" aria-hidden="true">AB</div><h1>Agent Bus frontend crashed</h1><p className="error">{this.state.error}</p><p>Run <code>agent-bus open</code> again. The broker is still local and your persistent state is unchanged.</p></div></main>;return this.props.children}
}

function Login({onReady}:{onReady:()=>void}){
  const [error,setError]=useState("");
  useEffect(()=>{
    const ticket=new URLSearchParams(location.search).get("ticket");
    if(!ticket){window.setTimeout(()=>checkpoint(10,"locked dashboard committed to the DOM"),0);return;}
    checkpoint(8,"POST /api/session started");
    post("/api/session",{ticket}).then(()=>{
      checkpoint(9,"one-time ticket exchanged for HttpOnly session");
      history.replaceState(null,"",location.pathname);
      onReady();
    }).catch(e=>{history.replaceState(null,"",location.pathname);bootMonitor()?.diagnose?.("Agent Bus ticket exchange failed",e);setError(e.message)});
  },[]);
  return <main className="lock"><div className="lock-card"><div className="mark" aria-hidden="true">AB</div><h1>Agent Bus is locked</h1><p>Open this dashboard through the trusted CLI so the browser receives a one-time operator session.</p><code>agent-bus open</code>{error&&<p className="error">{error}</p>}</div></main>;
}

function App(){
  checkpoint(7,"App component function executed");
  const [auth,setAuth]=useState<boolean|null>(()=>new URLSearchParams(location.search).has("ticket")?false:null); const [snap,setSnap]=useState<Snapshot>(empty); const [catalog,setCatalog]=useState<Catalog|null>(null); const [projects,setProjects]=useState<Project[]>([]); const [providers,setProviders]=useState<ProviderStatus[]>([]);
  const [runId,setRunId]=useState<string|null>(null); const [taskId,setTaskId]=useState<string|null>(null); const [toast,setToast]=useState(""); const [modal,setModal]=useState<string|null>(null);
  const [view,setView]=useState<View|null>(null);
  const ready=()=>setAuth(true);
  const note=(s:string)=>{setToast(s);setTimeout(()=>setToast(""),2800)};
  const showSetup=()=>{if(location.pathname!=="/setup")history.pushState(null,"","/setup");setView("setup")};
  const showConsole=()=>{if(location.pathname!=="/")history.pushState(null,"","/");setView("console")};
  useEffect(()=>{
    const hasTicket=new URLSearchParams(location.search).has("ticket");
    if(hasTicket)return;
    checkpoint(8,"existing session validation started");
    api("/api/session").then(()=>{checkpoint(9,"existing browser session restored");setAuth(true)}).catch(()=>setAuth(false));
  },[]);
  useEffect(()=>{
    const onPop=()=>setView(location.pathname==="/setup"?"setup":"console");
    window.addEventListener("popstate",onPop);
    return()=>window.removeEventListener("popstate",onPop);
  },[]);
  useEffect(()=>{if(!auth)return;Promise.all([api<Snapshot>("/api/state"),api<Catalog>("/api/catalog"),api<any>("/api/projects"),api<any>("/api/providers/status"),api<SetupStatus>("/api/setup")]).then(([s,c,p,ps,setup])=>{setSnap(s);setCatalog(c);setProjects(p.projects||[]);setProviders(ps.providers||[]);setRunId(r=>r||s.runs[0]?.id||null);const required=setup.required??(!setup.completed&&s.runs.length===0);const wantSetup=location.pathname==="/setup"||required;setView(wantSetup?"setup":"console");if(required&&location.pathname!=="/setup")history.replaceState(null,"","/setup");checkpoint(10,"authenticated dashboard committed to the DOM")}).catch(e=>note(e.message));const es=new EventSource("/api/events");es.addEventListener("snapshot",e=>{const n=JSON.parse((e as MessageEvent).data);setSnap(prev=>mergeSnapshot(prev,n))});es.addEventListener("error",()=>note("Live event stream disconnected; reconnecting…"));return()=>es.close()},[auth]);
  if(auth===null)return <div className="boot">Starting Agent Bus…</div>; if(!auth)return <Login onReady={ready}/>;
  if(!catalog||!view)return <div className="boot">Starting Agent Bus…</div>;

  const currentRun=snap.runs.find(r=>r.id===runId)||null; const tasks=snap.tasks.filter(t=>!runId||t.runId===runId).sort((a,b)=>a.updatedAt-b.updatedAt); const task=snap.tasks.find(t=>t.id===taskId)||null;
  const agents=snap.roster.filter(a=>a.id!=="operator"); const runTaskIds=new Set(tasks.map(t=>t.id)); const messages=snap.messages.filter(m=>!runId||!m.taskId||runTaskIds.has(m.taskId)).slice().sort((a,b)=>b.seq-a.seq);
  const usage=agents.reduce((a,x)=>({tokens:a.tokens+(x.usage?.totalTokens||0),turns:a.turns+(x.usage?.turns||0),cost:a.cost+(x.usage?.costUSD||0)}),{tokens:0,turns:0,cost:0});
  const failures=tasks.filter(t=>t.state==="failed"||t.attempts>0).length;

  async function refreshCatalog(){const [c,p,ps]=await Promise.all([api<Catalog>("/api/catalog"),api<any>("/api/projects"),api<any>("/api/providers/status")]);setCatalog(c);setProjects(p.projects||[]);setProviders(ps.providers||[])}
  async function discoverProviders(){
    try{
      const applied=await post("/api/discover",{apply:true});
      setProviders(applied.providers||[]);
      await refreshCatalog();
      note(applied.added?.length?`Added ${applied.added.join(", ")}`:"Scanned installed CLIs");
    }catch(e:any){
      try{const result=await api<any>("/api/providers/status?discover=1");setProviders(result.providers||[]);note("Provider scan refreshed")}
      catch{note(e.message)}
    }
  }
  async function stopAll(){if(!confirm("Stop every supervised agent?"))return;try{await post("/api/agents/stop-all");note("All supervisors stopped")}catch(e:any){note(e.message)}}
  async function stopRun(){if(!currentRun)return;try{await post(`/api/runs/${currentRun.id}/stop`,{reason:"Stopped from dashboard"});note("Run stopped")}catch(e:any){note(e.message)}}
  async function review(accepted:boolean){if(!task)return;const feedback=(document.querySelector<HTMLTextAreaElement>("#task-feedback")?.value||"").trim()||(accepted?"Accepted.":"Changes requested.");try{await post(`/api/tasks/${task.id}/review`,{accepted,feedback});setModal(null)}catch(e:any){note(e.message)}}

  const liveAgents=agents.filter(a=>a.status!=="offline").length;
  const projectValue=currentRun?.projectRoot||projects[0]?.path||"";
  const modals=<>
    {modal==="run"&&<RunModal projects={projects} close={()=>setModal(null)} onDone={async(r)=>{setRunId(r.id);setModal(null);await refreshCatalog()}} onToast={note}/>}
    {modal==="project"&&<ProjectModal close={()=>setModal(null)} onDone={async()=>{setModal(null);await refreshCatalog()}} onToast={note}/>}
    {modal==="message"&&<MessageModal agents={agents} close={()=>setModal(null)} onToast={note}/>}
    {modal==="task"&&task&&<TaskModal task={task} close={()=>setModal(null)} review={review} onToast={note}/>}
    {modal==="agent"&&catalog&&<AgentModal catalog={catalog} existing={catalog.agents[taskId||""]} close={()=>{setModal(null);setTaskId(null)}} onDone={async()=>{setModal(null);setTaskId(null);await refreshCatalog()}} onToast={note}/>}
    {toast&&<div className="toast">{toast}</div>}
  </>;
  if(view==="setup")return <>
    <SetupView catalog={catalog} providers={providers} projects={projects} onToast={note} refreshCatalog={refreshCatalog} discoverProviders={discoverProviders} openAgent={(id)=>{setTaskId(id);setModal("agent")}} openProject={()=>setModal("project")} enterConsole={async()=>{try{await post("/api/setup",{completed:true});showConsole()}catch(e:any){note(e.message)}}}/>
    {modals}
  </>;
  return <div className="app" data-agent-bus-mounted="true">
    <header className="sector">
      <div className="sector-id"><span className="mark" aria-hidden="true">AB</span><strong>Agent Bus</strong><span className="host">{location.host}</span></div>
      <div className="sector-place">
        <label>Project<select value={projectValue} onChange={e=>{const path=e.target.value;const r=snap.runs.find(x=>x.projectRoot===path);if(r)setRunId(r.id)}}>{projects.length?projects.map(p=><option key={p.path} value={p.path}>{p.name}</option>):<option value="">Add a project…</option>}</select></label>
        <label>Run<select value={runId||""} onChange={e=>setRunId(e.target.value||null)}><option value="">No run</option>{snap.runs.map(r=><option key={r.id} value={r.id}>{r.goal}</option>)}</select></label>
        <button type="button" onClick={()=>setModal("project")} aria-label="Add project">+</button>
      </div>
      <div className="figures">
        <label><b>{liveAgents}/{agents.length}</b><span>agents</span></label>
        <label><b>{fmtTokens(usage.tokens)}</b><span>tokens</span></label>
        <label><b>{failures}</b><span>retries</span></label>
        <label><b>${usage.cost.toFixed(3)}</b><span>cost</span></label>
      </div>
      <div className="sector-actions">
        <details className="providers-pop">
          <summary>Providers</summary>
          <div className="menu"><button type="button" onClick={discoverProviders}>Scan CLIs</button>{providers.map(p=>{const discovered=(p.harnesses||[]).flatMap((h:any)=>h?.discoveredModels||[]);return <div className="provider" key={p.id}><span className={`tab ${p.cliFound?"ok":p.enabled||p.configured?"warn":""}`}/><div><b>{p.displayName}</b><small>{p.cliFound?"CLI found":p.configured||p.enabled?"configured · CLI missing":"not installed"}</small><small>{p.loginCommand||p.authSource}</small>{discovered.length?<small>models: {discovered.slice(0,4).join(", ")}</small>:null}</div></div>})}</div>
        </details>
        <button type="button" onClick={showSetup}>Settings</button>
        <button className="primary" onClick={()=>setModal("run")}>New run</button>
        <button className="alert" onClick={stopAll}>Stop all</button>
      </div>
    </header>
    <div className={`mission ${currentRun?"":"vacant"}`}>{currentRun?<><div><h1>{currentRun.goal}</h1><p>{currentRun.status} · {currentRun.id} · {currentRun.projectRoot}</p></div><div className="row"><button onClick={()=>setModal("message")}>Message team</button>{currentRun.status==="active"&&<button className="alert subtle" onClick={stopRun}>Stop run</button>}</div></>:<div><h1>No run selected</h1><p>Start a run with a project path and an objective. Attach <code>@agent-bus</code> in chat to delegate from another model.</p></div>}</div>
    <div className="bay">
      <section>
        <div className="bay-head">Tasks <b>{tasks.length}</b></div>
        <div className="strips">{tasks.length?tasks.map(t=><button className={`strip ${t.id===taskId?"selected":""}`} key={t.id} style={{marginLeft:Math.min(6,t.depth||0)*12}} onClick={()=>{setTaskId(t.id);setModal("task")}}><i className={`tab ${t.state}`}/><span className="strip-body"><b>{t.title}</b><small>{t.assignee||"unassigned"} · {t.role}/c{t.complexity} · r{t.round}{t.attempts?` · ${t.attempts} retry`:""}{t.routing?.reason?` · ${t.routing.reason}`:""}</small></span><span className="strip-meta">{t.state}</span></button>):<p className="empty">No tasks yet. Create a run or delegate from chat with @agent-bus.</p>}</div>
      </section>
      <section>
        <div className="bay-head">Agents <button type="button" data-agent-add="true" onClick={()=>setModal("agent")}>Add</button></div>
        <div className="strips">{agents.length?agents.map(a=><AgentStrip key={a.id} agent={a} project={currentRun?.projectRoot||projects[0]?.path||""} onToast={note} onEdit={()=>{setTaskId(a.id);setModal("agent")}}/>):<p className="empty">No agents yet. Open Settings, scan providers, then add a manager and workers.</p>}</div>
      </section>
    </div>
    <section className="console">
      <div className="bay-head">Live log <b>{messages.length}</b></div>
      {messages.length?<ol className="log">{messages.slice(0,250).map(m=><li key={m.id}><time>{new Date(m.ts).toLocaleTimeString()}</time><b>{m.from} → {m.to}</b><p>{m.subject} — {m.body}</p></li>)}</ol>:<p className="empty">Mail and task events appear here.</p>}
    </section>
    {modals}
  </div>;
}

function SetupView({catalog,providers,projects,onToast,refreshCatalog,discoverProviders,openAgent,openProject,enterConsole}:{catalog:Catalog;providers:ProviderStatus[];projects:Project[];onToast:(s:string)=>void;refreshCatalog:()=>Promise<void>;discoverProviders:()=>Promise<void>;openAgent:(id:string)=>void;openProject:()=>void;enterConsole:()=>Promise<void>}){
  const constraints=catalog.constraints||{maxDelegationDepth:4,maxConcurrentTasks:4,maxRetries:2,independentReviewComplexity:4,preferSubscription:true};
  const [depth,setDepth]=useState(constraints.maxDelegationDepth);
  const [reviewAt,setReviewAt]=useState(constraints.independentReviewComplexity);
  const [retries,setRetries]=useState(constraints.maxRetries);
  const [busy,setBusy]=useState(false);
  const [paths,setPaths]=useState<Record<string,string>>({});
  const [modelDraft,setModelDraft]=useState<Record<string,string>>({});
  const agents=Object.values(catalog.agents||{});
  const enabledAgents=agents.filter((agent:any)=>agent.enabled);
  useEffect(()=>{
    if(Object.keys(catalog.providers||{}).length)return;
    discoverProviders().catch(()=>{});
  },[]);
  async function saveDisk(action:()=>Promise<unknown>, ok?:string){
    try{await action();await refreshCatalog();if(ok)onToast(ok)}catch(error:any){onToast(error.message)}
  }
  async function finish(){
    setBusy(true);
    try{
      try{await post("/api/constraints",{maxDelegationDepth:depth,independentReviewComplexity:reviewAt,maxRetries:retries})}
      catch(error:any){if(!String(error.message).includes("in-memory"))throw error}
      await enterConsole();
    }catch(error:any){onToast(error.message)}
    finally{setBusy(false)}
  }
  return <div className="app setup" data-agent-bus-mounted="true" data-setup-page="true">
    <header className="sector">
      <div className="sector-id"><span className="mark" aria-hidden="true">AB</span><strong>Agent Bus</strong><span className="host">{location.host}</span></div>
      <div className="sector-place"><p className="setup-kicker">Settings</p></div>
      <div className="figures">
        <label><b>{enabledAgents.length}/{agents.length}</b><span>enabled</span></label>
        <label><b>{providers.filter(p=>p.cliFound).length}</b><span>CLIs</span></label>
        <label><b>{projects.length}</b><span>projects</span></label>
      </div>
      <div className="sector-actions">
        <button type="button" onClick={discoverProviders}>Scan and add CLIs</button>
        <button className="primary" onClick={finish} disabled={busy} data-setup-enter="true">Open dashboard</button>
      </div>
    </header>
    <div className="mission"><div><h1>Configure providers and agents</h1><p>Installed CLIs are detected the same way as other local agent tools. Missing ones can be wired with a binary path and a login command. Cursor is a normal provider.</p></div></div>
    <div className="setup-grid">
      <section>
        <div className="bay-head">Providers</div>
        <div className="strips">{providers.map(provider=>{
          const configured=Boolean(catalog.providers[provider.id]?.enabled||provider.enabled);
          const command=paths[provider.id]??provider.resolvedPath??provider.command??"";
          return <article className="strip agent" key={provider.id}>
            <i className={`tab ${provider.cliFound?"ok":configured?"warn":""}`}/>
            <span className="strip-body">
              <b>{provider.displayName}</b>
              <small>{provider.cliFound?`CLI found${provider.version?` · ${provider.version}`:""}`:configured?"enabled · CLI not found":"not installed"} · {provider.authSource}</small>
              <input className="login-cmd" readOnly value={provider.loginCommand||provider.installHint||""} title="Login or install command"/>
              <input placeholder="Binary path (optional)" value={command} onChange={e=>setPaths(p=>({...p,[provider.id]:e.target.value}))}/>
              <div className="row">
                <input placeholder="Add exact model id" value={modelDraft[provider.id]||""} onChange={e=>setModelDraft(d=>({...d,[provider.id]:e.target.value}))}/>
                <button type="button" onClick={()=>saveDisk(async()=>{
                  const exact=(modelDraft[provider.id]||"").trim(); if(!exact)throw new Error("enter a model id");
                  const harness=provider.harnessId||catalog.harnesses[Object.keys(catalog.harnesses)[0]]?.id;
                  if(!harness)throw new Error("enable the provider first");
                  await post("/api/models",{id:`${provider.id}-${exact}`.replace(/[^a-zA-Z0-9._-]/g,"-").slice(0,64),provider:provider.id,harness,family:provider.id,exactModel:exact,enabled:true});
                  setModelDraft(d=>({...d,[provider.id]:""}));
                }, "Model added")}>Add model</button>
              </div>
            </span>
            <label className="enable"><input type="checkbox" checked={configured} onChange={e=>saveDisk(()=>post("/api/providers",{id:provider.id,enabled:e.target.checked,command:command||undefined}))}/>on</label>
          </article>;
        })}</div>
      </section>
      <section>
        <div className="bay-head">Agents <button type="button" data-agent-add="true" onClick={()=>openAgent("")}>Add</button></div>
        <div className="strips">{agents.length?agents.map((agent:any)=><article className={`strip agent ${agent.enabled?"":"offline"}`} key={agent.id}><i className={`tab ${agent.enabled?"idle":""}`}/><span className="strip-body"><b>{agent.id}</b><small>{agent.role} · {agent.model}{agent.autoStart?" · auto-start":""}</small></span><label className="enable"><input type="checkbox" checked={Boolean(agent.enabled)} onChange={e=>saveDisk(()=>post("/api/agents",{id:agent.id,model:agent.model,role:agent.role,description:agent.description,enabled:e.target.checked,autoStart:agent.autoStart,permissions:agent.permissions}))}/>on</label><button type="button" onClick={()=>openAgent(agent.id)}>Edit</button></article>):<p className="empty">Add a manager first, then the workers it may create. Routing uses this roster, not stock names.</p>}</div>
      </section>
      <section>
        <div className="bay-head">Hierarchy</div>
        <HierarchyBoard agents={agents} onChange={(id,allowedChildAgentIds,agent)=>saveDisk(()=>post("/api/agents",{...agent,id,permissions:{...agent.permissions,canDelegate:true,allowedChildAgentIds}}),"Hierarchy saved")}/>
        <form className="setup-form" onSubmit={e=>e.preventDefault()}>
          <label>Max delegation depth<input type="number" min={0} max={8} value={depth} onChange={e=>setDepth(Number(e.target.value))}/></label>
          <label>Independent review from complexity<input type="number" min={1} max={5} value={reviewAt} onChange={e=>setReviewAt(Number(e.target.value))}/></label>
          <label>Retries before reroute<input type="number" min={0} max={10} value={retries} onChange={e=>setRetries(Number(e.target.value))}/></label>
        </form>
      </section>
      <section>
        <div className="bay-head">Projects <button type="button" onClick={openProject}>Add</button></div>
        <div className="strips">{projects.length?projects.map(project=><article className="strip" key={project.path}><i className="tab idle"/><span className="strip-body"><b>{project.name}</b><small>{project.path}</small></span></article>):<p className="empty">Add a local project path agents may work in.</p>}</div>
      </section>
    </div>
    <footer className="setup-foot">
      <p>{enabledAgents.length?`${enabledAgents.length} agent${enabledAgents.length===1?"":"s"} enabled.`:"Scan CLIs, turn providers on, then add the manager you will talk to first."}</p>
      <button className="primary" onClick={finish} disabled={busy}>Open dashboard</button>
    </footer>
  </div>;
}

function HierarchyBoard({agents,onChange}:{agents:any[];onChange:(id:string,allowed:string[],agent:any)=>void}){
  const managers=agents.filter((agent:any)=>agent.role==="manager"||agent.permissions?.canDelegate);
  const pool=agents.filter((agent:any)=>!managers.some((manager:any)=>manager.id===agent.id));
  const [over,setOver]=useState<string|null>(null);
  if(!managers.length)return <p className="empty">Add a manager, then drag workers onto it to choose who it may create.</p>;
  return <div className="hierarchy">
    <p className="empty">Drag a worker onto a manager. An empty list means any eligible agent; once you drop one, only that list may be spawned.</p>
    <div className="chips">{pool.map((agent:any)=><span className="chip" key={agent.id} draggable onDragStart={e=>e.dataTransfer.setData("text/plain",agent.id)}>{agent.id}</span>)}</div>
    {managers.map((manager:any)=>{
      const allowed=manager.permissions?.allowedChildAgentIds||[];
      return <div key={manager.id} className={`hierarchy-manager ${over===manager.id?"over":""}`} onDragOver={e=>{e.preventDefault();setOver(manager.id)}} onDragLeave={()=>setOver(null)} onDrop={e=>{
        e.preventDefault();setOver(null);
        const id=e.dataTransfer.getData("text/plain");
        if(!id||id===manager.id)return;
        onChange(manager.id,[...new Set([...allowed,id])],manager);
      }}>
        <b>{manager.id}</b> <small>{manager.role}</small>
        <div className="chips">{allowed.length?allowed.map((id:string)=><span className="chip" key={id} onClick={()=>onChange(manager.id,allowed.filter((item:string)=>item!==id),manager)}>{id} ×</span>):<span className="empty">Anyone eligible</span>}</div>
      </div>;
    })}
  </div>;
}

function mergeSnapshot(prev:Snapshot,n:BusSnapshot & {incremental?:boolean}):Snapshot{if(!n.incremental)return n;const map=new Map(prev.messages.map(m=>[m.id,m]));for(const m of n.messages||[])map.set(m.id,m);return {...prev,...n,messages:[...map.values()].sort((a,b)=>a.seq-b.seq).slice(-5000)}}
function AgentStrip({agent,project,onToast,onEdit}:{agent:Agent;project:string;onToast:(s:string)=>void;onEdit:()=>void}){
  const active=Boolean(agent.supervisorPid);
  const tab=agent.stalled?"warn":agent.status==="working"?"working":agent.status==="failed"?"failed":agent.status==="offline"?"":"idle";
  const act=async()=>{try{if(active)await post(`/api/agents/${agent.id}/stop`);else await post(`/api/agents/${agent.id}/start`,{projectRoot:project});onToast(active?`${agent.id} stopped`:`${agent.id} starting`)}catch(e:any){onToast(e.message)}};
  return <article className={`strip agent ${agent.status==="offline"?"offline":""}`}>
    <i className={`tab ${tab}`} aria-hidden="true"/>
    <span className="strip-body"><b>{agent.id}</b><small>{agent.role} · {agent.provider}/{agent.family} · {agent.model} · {agent.harness}</small></span>
    <span className="strip-meta">{agent.stalled?"stalled":agent.status}<span>{fmtTokens(agent.usage?.totalTokens||0)} tok · {agent.usage?.turns||0}t</span></span>
    <span className="row">{active?<button type="button" className="alert" onClick={act}>Stop</button>:<button type="button" className="primary" onClick={act}>Start</button>}<button type="button" onClick={onEdit}>Edit</button></span>
  </article>;
}

function Modal({title,close,children}:{title:string;close:()=>void;children:any}){return <div className="backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className="modal"><div className="modal-head"><h2>{title}</h2><button onClick={close}>×</button></div>{children}</div></div>}
function RunModal({projects,close,onDone,onToast}:{projects:Project[];close:()=>void;onDone:(r:Run)=>void;onToast:(s:string)=>void}){const [path,setPath]=useState(projects[0]?.path||"");const [goal,setGoal]=useState("");return <Modal title="Start run" close={close}><form onSubmit={async e=>{e.preventDefault();try{const x=await post<any>("/api/runs",{projectRoot:path,goal});onDone(x.run)}catch(err:any){onToast(err.message)}}}><label>Project path<input value={path} onChange={e=>setPath(e.target.value)} required/></label><label>Objective<textarea value={goal} onChange={e=>setGoal(e.target.value)} rows={5} required/></label><div className="modal-actions"><button type="button" onClick={close}>Cancel</button><button className="primary">Start run</button></div></form></Modal>}
function ProjectModal({close,onDone,onToast}:{close:()=>void;onDone:()=>void;onToast:(s:string)=>void}){const [path,setPath]=useState("");return <Modal title="Add local project" close={close}><form onSubmit={async e=>{e.preventDefault();try{await post("/api/projects",{path});onDone()}catch(err:any){onToast(err.message)}}}><label>Absolute project path<input value={path} onChange={e=>setPath(e.target.value)} placeholder="/Users/me/code/project" required/></label><div className="modal-actions"><button type="button" onClick={close}>Cancel</button><button className="primary">Add project</button></div></form></Modal>}
function MessageModal({agents,close,onToast}:{agents:Agent[];close:()=>void;onToast:(s:string)=>void}){const [to,setTo]=useState("*");const [body,setBody]=useState("");return <Modal title="Operator message" close={close}><form onSubmit={async e=>{e.preventDefault();try{await post("/api/messages",{to,subject:body.slice(0,120),body,type:"info"});close()}catch(err:any){onToast(err.message)}}}><label>To<select value={to} onChange={e=>setTo(e.target.value)}><option value="*">All agents</option>{agents.map(a=><option key={a.id}>{a.id}</option>)}</select></label><label>Message<textarea value={body} onChange={e=>setBody(e.target.value)} rows={5} required/></label><div className="modal-actions"><button type="button" onClick={close}>Cancel</button><button className="primary">Send</button></div></form></Modal>}
function TaskModal({task,close,review,onToast}:{task:Task;close:()=>void;review:(a:boolean)=>void;onToast:(s:string)=>void}){return <Modal title={task.title} close={close}><div className="detail-grid"><div><span>State</span><b>{task.state}</b></div><div><span>Assignee</span><b>{task.assignee||"—"}</b></div><div><span>Retries</span><b>{task.attempts}/{task.maxRetries}</b></div><div><span>Tokens</span><b>{fmtTokens(task.usage?.totalTokens||0)}</b></div></div><h3>Brief</h3><pre>{task.brief}</pre>{task.result&&<><h3>Submission</h3><pre>{task.result.summary}</pre></>} {task.routing&&<><h3>Routing decision</h3><pre>{task.routing.reason}</pre></>}<label>Operator feedback<textarea id="task-feedback" rows={4}/></label><div className="modal-actions split"><button className="danger" onClick={async()=>{try{await post(`/api/tasks/${task.id}/cancel`,{reason:"Cancelled by operator"});close()}catch(e:any){onToast(e.message)}}}>Cancel task</button><span/><button disabled={task.state!=="submitted"} onClick={()=>review(false)}>Request changes</button><button className="primary" disabled={task.state!=="submitted"} onClick={()=>review(true)}>Accept</button></div></Modal>}
function AgentModal({catalog,existing,close,onDone,onToast}:{catalog:Catalog;existing:any;close:()=>void;onDone:()=>void;onToast:(s:string)=>void}){const [id,setId]=useState(existing?.id||"");const [model,setModel]=useState(existing?.model||Object.keys(catalog.models)[0]||"");const [role,setRole]=useState(existing?.role||"implementation");const modelDef=catalog.models[model]||{};return <Modal title={existing?`Edit ${existing.id}`:"Create agent"} close={close}><form onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await post("/api/agents",{id,model,role,description:f.get("description"),enabled:f.get("enabled")==="on",autoStart:f.get("autoStart")==="on",reasoning:f.get("reasoning"),effort:f.get("effort"),permissions:{filesystem:f.get("filesystem"),shell:f.get("shell")==="on",network:f.get("network")==="on",canReview:f.get("canReview")==="on",canDelegate:f.get("canDelegate")==="on",maxDelegationDepth:f.get("canDelegate")==="on"?4:0,allowedPaths:["."],allowedChildAgentIds:existing?.permissions?.allowedChildAgentIds}});onDone()}catch(err:any){onToast(err.message)}}}><div className="two"><label>Name<input value={id} onChange={e=>setId(e.target.value)} disabled={!!existing} required/></label><label>Role<select value={role} onChange={e=>setRole(e.target.value)}>{Object.keys(catalog.roles).map(x=><option key={x}>{x}</option>)}</select></label><label>Model<select data-agent-model-select="true" value={model} onChange={e=>setModel(e.target.value)}>{Object.values(catalog.models).map((m:any)=><option key={m.id} value={m.id}>{m.id} · {m.provider}</option>)}</select></label><label>Exact model<input data-agent-model-exact="true" value={modelDef.exactModel||""} readOnly/></label><label>Model family<input data-agent-model-family="true" value={modelDef.family||""} readOnly/></label><label>Description<input name="description" defaultValue={existing?.description||""}/></label><label>Reasoning<input name="reasoning" defaultValue={existing?.harnessOptions?.reasoning||""} placeholder="high"/></label><label>Effort<input name="effort" defaultValue={existing?.harnessOptions?.effort||""} placeholder="high"/></label><label>Filesystem<select name="filesystem" defaultValue={existing?.permissions?.filesystem||"read"}><option>none</option><option>read</option><option>write</option></select></label></div><div className="checks"><label><input type="checkbox" name="shell" defaultChecked={existing?.permissions?.shell}/>shell</label><label><input type="checkbox" name="network" defaultChecked={existing?.permissions?.network}/>network</label><label><input type="checkbox" name="canReview" defaultChecked={existing?.permissions?.canReview}/>review</label><label><input type="checkbox" name="canDelegate" defaultChecked={existing?.permissions?.canDelegate}/>delegate</label><label><input type="checkbox" name="enabled" defaultChecked={existing?.enabled??true}/>enabled</label><label><input type="checkbox" name="autoStart" defaultChecked={existing?.autoStart}/>auto-start</label></div><div className="modal-actions"><button type="button" onClick={close}>Cancel</button><button className="primary">Save agent</button></div></form></Modal>}

const rootElement=document.getElementById("root");
if(!rootElement)throw new Error("Agent Bus root element is missing");
const reactRoot=createRoot(rootElement);
checkpoint(5,"createRoot returned successfully");
reactRoot.render(<AppErrorBoundary><App/></AppErrorBoundary>);
checkpoint(6,"render returned successfully");
