#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

function replaceOnce(path, from, to) {
  const source = readFileSync(path, "utf8");
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`patch target not found in ${path}: ${from.slice(0, 140)}`);
  writeFileSync(path, source.replace(from, to));
}

replaceOnce(
  "web/src/main.tsx",
  'const bootMonitor=()=>((window as any).__AGENT_BUS_BOOT__ as {checkpoint?:(number:number,detail?:unknown)=>void;fail?:(title:string,detail:unknown)=>void;record?:(kind:string,detail:unknown)=>void}|undefined);',
  'const bootMonitor=()=>((window as any).__AGENT_BUS_BOOT__ as {checkpoint?:(number:number,detail?:unknown)=>void;fail?:(title:string,detail:unknown)=>void;diagnose?:(title:string,detail:unknown)=>void;record?:(kind:string,detail:unknown)=>void}|undefined);',
);
replaceOnce(
  "web/src/main.tsx",
  '    if(!ticket)return;',
  '    if(!ticket){window.setTimeout(()=>checkpoint(10,"locked dashboard committed to the DOM"),0);return;}',
);
replaceOnce(
  "web/src/main.tsx",
  '    }).catch(e=>{bootMonitor()?.record?.("ticket-exchange-error",e);setError(e.message)});',
  '    }).catch(e=>{bootMonitor()?.diagnose?.("Agent Bus ticket exchange failed",e);setError(e.message)});',
);
replaceOnce(
  "web/src/main.tsx",
  '  useEffect(()=>{api("/api/session").then(()=>{checkpoint(9,"existing browser session restored");setAuth(true)}).catch(()=>setAuth(false))},[]);',
  '  useEffect(()=>{const hasTicket=new URLSearchParams(location.search).has("ticket");if(!hasTicket)checkpoint(8,"existing session validation started");api("/api/session").then(()=>{if(!hasTicket)checkpoint(9,"existing browser session restored");setAuth(true)}).catch(()=>setAuth(false))},[]);',
);

replaceOnce(
  "src/process-management.ts",
  '  runs?: number;\n}',
  '  runs?: number;\n  runtime?: { applicationRoot?: string; staticRoot?: string; entrypoint?: string; nodePath?: string; cwd?: string };\n}',
);
replaceOnce(
  "src/process-management.ts",
  `export function knownAgentBusCommand(command: string): boolean {\n  const text = command.trim();\n  if (!text) return false;\n  return /(?:^|\\s)(?:\\S*node\\S*\\s+)?\\S*\\/agent-bus\\/(?:dist\\/(?:cli|broker|product-server)\\.js|cli\\.js)(?:\\s+(?:broker|dashboard|supervise)(?:\\s|$)|\\s*$)/i.test(text)\n    || /(?:^|\\s)(?:\\S*node\\S*\\s+)?\\S*\\/agent-bus\\/src\\/(?:broker|product-server)\\.(?:js|ts)(?:\\s|$)/i.test(text);\n}`,
  `export function knownAgentBusCommand(command: string): boolean {\n  const text = command.trim();\n  if (!text) return false;\n  const checkout = String.raw\`\\S*/agent-bus/\`;\n  const canonical = String.raw\`\\S*/\\.agent-bus/app/(?:current|releases/[^/]+)/\`;\n  const root = \`(?:\${checkout}|\${canonical})\`;\n  return new RegExp(String.raw\`(?:^|\\s)(?:\\S*node\\S*\\s+)?\${root}(?:dist/(?:cli|broker|product-server)\\.js|cli\\.js)(?:\\s+(?:broker|dashboard|supervise)(?:\\s|$)|\\s*$)\`, "i").test(text)\n    || new RegExp(String.raw\`(?:^|\\s)(?:\\S*node\\S*\\s+)?\${root}src/(?:broker|product-server)\\.(?:js|ts)(?:\\s|$)\`, "i").test(text);\n}`,
);

unlinkSync("scripts/apply-browser-followup.mjs");
