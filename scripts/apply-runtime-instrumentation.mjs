#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

function lines(...items) {
  return items.join("\n");
}

function replaceOnce(path, from, to) {
  const source = readFileSync(path, "utf8");
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`patch target not found in ${path}: ${from.slice(0, 120)}`);
  writeFileSync(path, source.replace(from, to));
}

replaceOnce(
  "web/src/main.tsx",
  'import { Component, useEffect, useState } from "react";',
  'import "./entry.ts";\nimport { Component, useEffect, useState } from "react";',
);
replaceOnce(
  "web/src/main.tsx",
  'import "./styles.css";\n',
  lines(
    'import "./styles.css";',
    '',
    'const bootMonitor=()=>((window as any).__AGENT_BUS_BOOT__ as {checkpoint?:(number:number,detail?:unknown)=>void;fail?:(title:string,detail:unknown)=>void;record?:(kind:string,detail:unknown)=>void}|undefined);',
    'const checkpoint=(number:number,detail?:unknown)=>bootMonitor()?.checkpoint?.(number,detail);',
    'checkpoint(3,"React application module evaluated");',
    'checkpoint(4,"React and react-dom/client imports resolved");',
    '',
  ),
);
replaceOnce(
  "web/src/main.tsx",
  'componentDidCatch(error:unknown){(globalThis as any).__AGENT_BUS_BOOTSTRAP__={phase:"react-error",error:error instanceof Error?error.message:String(error)}}',
  'componentDidCatch(error:unknown){bootMonitor()?.fail?.("Agent Bus React error boundary",error);(globalThis as any).__AGENT_BUS_BOOTSTRAP__={phase:"react-error",error:error instanceof Error?error.message:String(error)}}',
);
replaceOnce(
  "web/src/main.tsx",
  '  useEffect(()=>{const ticket=new URLSearchParams(location.search).get("ticket");if(!ticket)return;post("/api/session",{ticket}).then(()=>{history.replaceState(null,"",location.pathname);onReady()}).catch(e=>setError(e.message))},[]);',
  lines(
    '  useEffect(()=>{',
    '    const ticket=new URLSearchParams(location.search).get("ticket");',
    '    if(!ticket)return;',
    '    checkpoint(8,"POST /api/session started");',
    '    post("/api/session",{ticket}).then(()=>{',
    '      checkpoint(9,"one-time ticket exchanged for HttpOnly session");',
    '      history.replaceState(null,"",location.pathname);',
    '      onReady();',
    '    }).catch(e=>{bootMonitor()?.record?.("ticket-exchange-error",e);setError(e.message)});',
    '  },[]);',
  ),
);
replaceOnce(
  "web/src/main.tsx",
  'function App(){\n',
  'function App(){\n  checkpoint(7,"App component function executed");\n',
);
replaceOnce(
  "web/src/main.tsx",
  '  useEffect(()=>{api("/api/session").then(()=>setAuth(true)).catch(()=>setAuth(false))},[]);',
  lines(
    '  useEffect(()=>{api("/api/session").then(()=>{checkpoint(9,"existing browser session restored");setAuth(true)}).catch(()=>setAuth(false))},[]);',
    '  useEffect(()=>{if(auth)window.setTimeout(()=>checkpoint(10,"authenticated dashboard committed to the DOM"),0)},[auth]);',
  ),
);
replaceOnce(
  "web/src/main.tsx",
  'const rootElement=document.getElementById("root");\nif(!rootElement)throw new Error("Agent Bus root element is missing");\ncreateRoot(rootElement).render(<AppErrorBoundary><App/></AppErrorBoundary>);',
  lines(
    'const rootElement=document.getElementById("root");',
    'if(!rootElement)throw new Error("Agent Bus root element is missing");',
    'checkpoint(5,"createRoot invocation reached");',
    'const reactRoot=createRoot(rootElement);',
    'checkpoint(6,"React root created; render invocation reached");',
    'reactRoot.render(<AppErrorBoundary><App/></AppErrorBoundary>);',
  ),
);

replaceOnce(
  "src/product-server.ts",
  'import { productBuildId, PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";',
  'import { productArtifactManifest, PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";',
);
replaceOnce(
  "src/product-server.ts",
  '  const buildId = productBuildId(staticRoot);',
  lines(
    '  const artifact = productArtifactManifest(staticRoot);',
    '  const buildId = artifact.buildId;',
    '  const runtime = {',
    '    pid: process.pid,',
    '    applicationRoot: resolve(ROOT),',
    '    staticRoot: resolve(staticRoot),',
    '    entrypoint: resolve(process.argv[1] ?? CLI_PATH),',
    '    modulePath: fileURLToPath(import.meta.url),',
    '    launcherPath: process.env.AGENT_BUS_LAUNCHER_PATH ?? null,',
    '    installRoot: process.env.AGENT_BUS_INSTALL_ROOT ?? null,',
    '    nodePath: process.execPath,',
    '    nodeVersion: process.version,',
    '    cwd: process.cwd(),',
    '    argv: process.argv.slice(1),',
    '    ui: { index: artifact.index, scripts: artifact.scripts, styles: artifact.styles },',
    '  };',
  ),
);
replaceOnce(
  "src/product-server.ts",
  '        uiBuilt: existsSync(join(staticRoot, "index.html")),',
  '        uiBuilt: artifact.uiBuilt,\n        runtime,',
);
replaceOnce(
  "src/product-server.ts",
  '      });\n    }\n\n    try {',
  lines(
    '      });',
    '    }',
    '    if (pathname === "/diagnostics/runtime" && (req.method === "GET" || req.method === "HEAD")) {',
    '      return sendJson(res, 200, { ok: true, product: PRODUCT_NAME, productProtocol: PRODUCT_PROTOCOL_VERSION, buildId, runtime });',
    '    }',
    '',
    '    try {',
  ),
);

replaceOnce(
  "src/cli.ts",
  'import { spawn } from "node:child_process";',
  'import { spawn } from "node:child_process";\nimport { createHash, randomBytes } from "node:crypto";',
);
replaceOnce(
  "src/cli.ts",
  'import { productBuildId, PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";',
  'import { productArtifactManifest, PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";',
);
replaceOnce(
  "src/cli.ts",
  'const EXPECTED_BUILD_ID = productBuildId(join(ROOT, "dist", "web"));',
  'const EXPECTED_MANIFEST = productArtifactManifest(join(ROOT, "dist", "web"));\nconst EXPECTED_BUILD_ID = EXPECTED_MANIFEST.buildId;',
);
replaceOnce(
  "src/cli.ts",
  lines(
    'function isCurrentHealth(health: Awaited<ReturnType<typeof fetchHealth>>): boolean {',
    '  return health?.product === PRODUCT_NAME',
    '    && health.productProtocol === PRODUCT_PROTOCOL_VERSION',
    '    && health.buildId === EXPECTED_BUILD_ID',
    '    && health.dashboard === true',
    '    && health.uiBuilt === true;',
    '}',
  ),
  lines(
    'function isCurrentHealth(health: Awaited<ReturnType<typeof fetchHealth>>): boolean {',
    '  if (!health) return false;',
    '  const runtime = (health as typeof health & { runtime?: { applicationRoot?: string; staticRoot?: string } }).runtime;',
    '  return health.product === PRODUCT_NAME',
    '    && health.productProtocol === PRODUCT_PROTOCOL_VERSION',
    '    && health.buildId === EXPECTED_BUILD_ID',
    '    && health.dashboard === true',
    '    && health.uiBuilt === true',
    '    && resolve(runtime?.applicationRoot ?? "") === resolve(ROOT)',
    '    && resolve(runtime?.staticRoot ?? "") === resolve(join(ROOT, "dist", "web"));',
    '}',
  ),
);
replaceOnce(
  "src/cli.ts",
  'async function ensureBrokerStarted():Promise<void>{',
  lines(
    'function sha256(value: ArrayBuffer): string {',
    '  return createHash("sha256").update(Buffer.from(value)).digest("hex");',
    '}',
    '',
    'async function runtimeDiagnostic(): Promise<Record<string, unknown> | null> {',
    '  try {',
    '    const response = await fetch(`${BUS_URL}/diagnostics/runtime?probe=${Date.now()}`, {',
    '      headers: { "cache-control": "no-cache" },',
    '      signal: AbortSignal.timeout(2500),',
    '    });',
    '    if (!response.ok) return null;',
    '    return await response.json() as Record<string, unknown>;',
    '  } catch {',
    '    return null;',
    '  }',
    '}',
    '',
    'async function verifyServedDashboard(): Promise<void> {',
    '  const nonce = randomBytes(8).toString("hex");',
    '  const assets = [EXPECTED_MANIFEST.index, ...EXPECTED_MANIFEST.scripts, ...EXPECTED_MANIFEST.styles].filter(Boolean) as Array<{path:string;url:string|null;sha256:string}>;',
    '  for (const asset of assets) {',
    '    const pathname = asset.path === "index.html" ? "/" : asset.url;',
    '    if (!pathname) throw new Error(`production manifest has no browser URL for ${asset.path}`);',
    '    const separator = pathname.includes("?") ? "&" : "?";',
    '    const response = await fetch(`${BUS_URL}${pathname}${separator}agent_bus_verify=${nonce}`, {',
    '      headers: { "cache-control": "no-cache" },',
    '      signal: AbortSignal.timeout(3500),',
    '    });',
    '    if (!response.ok) throw new Error(`served production asset ${pathname} returned HTTP ${response.status}`);',
    '    const contentType = response.headers.get("content-type") ?? "";',
    '    if (asset.path.endsWith(".js") && !contentType.includes("javascript")) throw new Error(`served ${pathname} with invalid JavaScript MIME type: ${contentType}`);',
    '    if (asset.path.endsWith(".css") && !contentType.includes("text/css")) throw new Error(`served ${pathname} with invalid CSS MIME type: ${contentType}`);',
    '    const digest = sha256(await response.arrayBuffer());',
    '    if (digest !== asset.sha256) throw new Error(`served ${pathname} hash ${digest.slice(0,12)} does not match installed artifact ${asset.sha256.slice(0,12)}`);',
    '  }',
    '  const remote = await runtimeDiagnostic();',
    '  const remoteBuild = String(remote?.buildId ?? "");',
    '  if (remoteBuild !== EXPECTED_BUILD_ID) throw new Error(`running build ${remoteBuild || "unknown"} does not match installed build ${EXPECTED_BUILD_ID}`);',
    '}',
    '',
    'async function ensureBrokerStarted():Promise<void>{',
  ),
);
replaceOnce(
  "src/cli.ts",
  '  if (isCurrentHealth(initialHealth)) return;',
  '  if (isCurrentHealth(initialHealth)) { await verifyServedDashboard(); return; }',
);
replaceOnce(
  "src/cli.ts",
  '    if (isCurrentHealth(await fetchHealth(BUS_URL))) return;',
  '    if (isCurrentHealth(await fetchHealth(BUS_URL))) { await verifyServedDashboard(); return; }',
);
replaceOnce(
  "src/cli.ts",
  '  return `${DASHBOARD_URL}/?ticket=${encodeURIComponent(body.ticket)}`;',
  '  return `${DASHBOARD_URL}/?ticket=${encodeURIComponent(body.ticket)}&build=${encodeURIComponent(EXPECTED_BUILD_ID)}&launch=${randomBytes(8).toString("hex")}`;',
);
replaceOnce(
  "src/cli.ts",
  'case "models":{',
  lines(
    'case "runtime":{',
    '  const running=await runtimeDiagnostic();',
    '  const payload={local:{buildId:EXPECTED_BUILD_ID,applicationRoot:resolve(ROOT),staticRoot:resolve(join(ROOT,"dist","web")),entrypoint:resolve(process.argv[1]??CLI_PATH),launcherPath:process.env.AGENT_BUS_LAUNCHER_PATH??null,installRoot:process.env.AGENT_BUS_INSTALL_ROOT??null,nodePath:process.execPath,nodeVersion:process.version,cwd:process.cwd(),ui:{index:EXPECTED_MANIFEST.index,scripts:EXPECTED_MANIFEST.scripts,styles:EXPECTED_MANIFEST.styles}},running};',
    '  if(hasFlag("--json")){console.log(JSON.stringify(payload,null,2))}',
    '  else{console.log(`launcher: ${payload.local.launcherPath??"direct node invocation"}`);console.log(`application: ${payload.local.applicationRoot}`);console.log(`static: ${payload.local.staticRoot}`);console.log(`build: ${payload.local.buildId}`);console.log(`running: ${running?JSON.stringify(running):"not running"}`)}',
    '  return',
    '}',
    'case "models":{',
  ),
);

writeFileSync(
  "scripts/verify-production-bundle.mjs",
  lines(
    '#!/usr/bin/env node',
    'import assert from "node:assert/strict";',
    'import { readFileSync, readdirSync } from "node:fs";',
    'import { join } from "node:path";',
    '',
    'const root = "dist/web";',
    'const html = readFileSync(join(root, "index.html"), "utf8");',
    'assert.match(html, /id="agent-bus-boot"/, "production HTML must contain the pre-React boot diagnostic");',
    'assert.match(html, /data-boot-stage="10"/, "production HTML must expose all ten boot checkpoints");',
    'assert.match(html, /<script[^>]+src="\\/boot\\.js"/, "production HTML must load the classic boot monitor before modules");',
    'const moduleMatches=[...html.matchAll(/<script[^>]+type="module"[^>]+src="([^\"]+)"/g)].map(match=>match[1]);',
    'assert.equal(moduleMatches.length,1,"production HTML must load one statically bundled application module");',
    'assert.match(moduleMatches[0],/^\\/assets\\//);',
    '',
    'const assetDir = join(root, "assets");',
    'const javascript = readdirSync(assetDir).filter(name=>name.endsWith(".js")).map(name=>readFileSync(join(assetDir,name),"utf8"));',
    'assert.ok(javascript.some(code=>code.includes("data-agent-bus-mounted")),"built application must contain the React mount sentinel");',
    'assert.ok(javascript.some(code=>code.includes("createRoot invocation reached")),"built application must contain createRoot checkpoint instrumentation");',
    'assert.ok(javascript.some(code=>code.includes("POST /api/session started")),"built application must contain ticket exchange checkpoints");',
    'assert.equal(javascript.some(code=>/\\bReact\\.createElement\\b/.test(code)),false,"production bundle must not depend on an unbound global React namespace");',
    'assert.equal(javascript.some(code=>/\\bimport\\s*\\(/.test(code)),false,"production application must not rely on a runtime dynamic-import chunk");',
    'const boot=readFileSync(join(root,"boot.js"),"utf8");',
    'assert.match(boot,/securitypolicyviolation/);',
    'assert.match(boot,/Agent Bus boot timed out/);',
    'process.stdout.write("production bundle verification passed\\n");',
    '',
  ),
);

unlinkSync("scripts/apply-runtime-instrumentation.mjs");
