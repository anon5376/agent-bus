#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

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
  `import "./styles.css";\n\nconst bootMonitor=()=>((window as any).__AGENT_BUS_BOOT__ as {checkpoint?:(number:number,detail?:unknown)=>void;fail?:(title:string,detail:unknown)=>void;record?:(kind:string,detail:unknown)=>void}|undefined);\nconst checkpoint=(number:number,detail?:unknown)=>bootMonitor()?.checkpoint?.(number,detail);\ncheckpoint(3,"React application module evaluated");\ncheckpoint(4,"React and react-dom/client imports resolved");\n`,
);
replaceOnce(
  "web/src/main.tsx",
  'componentDidCatch(error:unknown){(globalThis as any).__AGENT_BUS_BOOTSTRAP__={phase:"react-error",error:error instanceof Error?error.message:String(error)}}',
  'componentDidCatch(error:unknown){bootMonitor()?.fail?.("Agent Bus React error boundary",error);(globalThis as any).__AGENT_BUS_BOOTSTRAP__={phase:"react-error",error:error instanceof Error?error.message:String(error)}}',
);
replaceOnce(
  "web/src/main.tsx",
  '  useEffect(()=>{const ticket=new URLSearchParams(location.search).get("ticket");if(!ticket)return;post("/api/session",{ticket}).then(()=>{history.replaceState(null,"",location.pathname);onReady()}).catch(e=>setError(e.message))},[]);',
  `  useEffect(()=>{\n    const ticket=new URLSearchParams(location.search).get("ticket");\n    if(!ticket)return;\n    checkpoint(8,"POST /api/session started");\n    post("/api/session",{ticket}).then(()=>{\n      checkpoint(9,"one-time ticket exchanged for HttpOnly session");\n      history.replaceState(null,"",location.pathname);\n      onReady();\n    }).catch(e=>{bootMonitor()?.record?.("ticket-exchange-error",e);setError(e.message)});\n  },[]);`,
);
replaceOnce(
  "web/src/main.tsx",
  'function App(){\n',
  'function App(){\n  checkpoint(7,"App component function executed");\n',
);
replaceOnce(
  "web/src/main.tsx",
  '  useEffect(()=>{api("/api/session").then(()=>setAuth(true)).catch(()=>setAuth(false))},[]);',
  `  useEffect(()=>{api("/api/session").then(()=>{checkpoint(9,"existing browser session restored");setAuth(true)}).catch(()=>setAuth(false))},[]);\n  useEffect(()=>{if(auth)window.setTimeout(()=>checkpoint(10,"authenticated dashboard committed to the DOM"),0)},[auth]);`,
);
replaceOnce(
  "web/src/main.tsx",
  'const rootElement=document.getElementById("root");\nif(!rootElement)throw new Error("Agent Bus root element is missing");\ncreateRoot(rootElement).render(<AppErrorBoundary><App/></AppErrorBoundary>);',
  'const rootElement=document.getElementById("root");\nif(!rootElement)throw new Error("Agent Bus root element is missing");\ncheckpoint(5,"createRoot invocation reached");\nconst reactRoot=createRoot(rootElement);\ncheckpoint(6,"React root created; render invocation reached");\nreactRoot.render(<AppErrorBoundary><App/></AppErrorBoundary>);',
);

replaceOnce(
  "src/product-server.ts",
  'import { productBuildId, PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";',
  'import { productArtifactManifest, PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";',
);
replaceOnce(
  "src/product-server.ts",
  '  const buildId = productBuildId(staticRoot);',
  `  const artifact = productArtifactManifest(staticRoot);\n  const buildId = artifact.buildId;\n  const runtime = {\n    pid: process.pid,\n    applicationRoot: resolve(ROOT),\n    staticRoot: resolve(staticRoot),\n    entrypoint: resolve(process.argv[1] ?? CLI_PATH),\n    modulePath: fileURLToPath(import.meta.url),\n    launcherPath: process.env.AGENT_BUS_LAUNCHER_PATH ?? null,\n    installRoot: process.env.AGENT_BUS_INSTALL_ROOT ?? null,\n    nodePath: process.execPath,\n    nodeVersion: process.version,\n    cwd: process.cwd(),\n    argv: process.argv.slice(1),\n    ui: { index: artifact.index, scripts: artifact.scripts, styles: artifact.styles },\n  };`,
);
replaceOnce(
  "src/product-server.ts",
  '        uiBuilt: existsSync(join(staticRoot, "index.html")),',
  '        uiBuilt: artifact.uiBuilt,\n        runtime,',
);
replaceOnce(
  "src/product-server.ts",
  '      });\n    }\n\n    try {',
  '      });\n    }\n    if (pathname === "/diagnostics/runtime" && (req.method === "GET" || req.method === "HEAD")) {\n      return sendJson(res, 200, { ok: true, product: PRODUCT_NAME, productProtocol: PRODUCT_PROTOCOL_VERSION, buildId, runtime });\n    }\n\n    try {',
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
  `function isCurrentHealth(health: Awaited<ReturnType<typeof fetchHealth>>): boolean {\n  return health?.product === PRODUCT_NAME\n    && health.productProtocol === PRODUCT_PROTOCOL_VERSION\n    && health.buildId === EXPECTED_BUILD_ID\n    && health.dashboard === true\n    && health.uiBuilt === true;\n}`,
  `function isCurrentHealth(health: Awaited<ReturnType<typeof fetchHealth>>): boolean {\n  if (!health) return false;\n  const runtime = (health as typeof health & { runtime?: { applicationRoot?: string; staticRoot?: string } }).runtime;\n  return health.product === PRODUCT_NAME\n    && health.productProtocol === PRODUCT_PROTOCOL_VERSION\n    && health.buildId === EXPECTED_BUILD_ID\n    && health.dashboard === true\n    && health.uiBuilt === true\n    && resolve(runtime?.applicationRoot ?? "") === resolve(ROOT)\n    && resolve(runtime?.staticRoot ?? "") === resolve(join(ROOT, "dist", "web"));\n}`,
);
replaceOnce(
  "src/cli.ts",
  'async function ensureBrokerStarted():Promise<void>{',
  `function sha256(value: ArrayBuffer): string {\n  return createHash("sha256").update(Buffer.from(value)).digest("hex");\n}\n\nasync function runtimeDiagnostic(): Promise<Record<string, unknown> | null> {\n  try {\n    const response = await fetch(\`${BUS_URL}/diagnostics/runtime?probe=\${Date.now()}\`, {\n      headers: { "cache-control": "no-cache" },\n      signal: AbortSignal.timeout(2500),\n    });\n    if (!response.ok) return null;\n    return await response.json() as Record<string, unknown>;\n  } catch {\n    return null;\n  }\n}\n\nasync function verifyServedDashboard(): Promise<void> {\n  const nonce = randomBytes(8).toString("hex");\n  const assets = [EXPECTED_MANIFEST.index, ...EXPECTED_MANIFEST.scripts, ...EXPECTED_MANIFEST.styles].filter(Boolean) as Array<{path:string;url:string|null;sha256:string}>;\n  for (const asset of assets) {\n    const pathname = asset.path === "index.html" ? "/" : asset.url;\n    if (!pathname) throw new Error(\`production manifest has no browser URL for \${asset.path}\`);\n    const separator = pathname.includes("?") ? "&" : "?";\n    const response = await fetch(\`${BUS_URL}\${pathname}\${separator}agent_bus_verify=\${nonce}\`, {\n      headers: { "cache-control": "no-cache" },\n      signal: AbortSignal.timeout(3500),\n    });\n    if (!response.ok) throw new Error(\`served production asset \${pathname} returned HTTP \${response.status}\`);\n    const contentType = response.headers.get("content-type") ?? "";\n    if (asset.path.endsWith(".js") && !contentType.includes("javascript")) throw new Error(\`served \${pathname} with invalid JavaScript MIME type: \${contentType}\`);\n    if (asset.path.endsWith(".css") && !contentType.includes("text/css")) throw new Error(\`served \${pathname} with invalid CSS MIME type: \${contentType}\`);\n    const digest = sha256(await response.arrayBuffer());\n    if (digest !== asset.sha256) throw new Error(\`served \${pathname} hash \${digest.slice(0,12)} does not match installed artifact \${asset.sha256.slice(0,12)}\`);\n  }\n  const remote = await runtimeDiagnostic();\n  const remoteBuild = String(remote?.buildId ?? "");\n  if (remoteBuild !== EXPECTED_BUILD_ID) throw new Error(\`running build \${remoteBuild || "unknown"} does not match installed build \${EXPECTED_BUILD_ID}\`);\n}\n\nasync function ensureBrokerStarted():Promise<void>{`,
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
  `case "runtime":{const running=await runtimeDiagnostic();const payload={local:{buildId:EXPECTED_BUILD_ID,applicationRoot:resolve(ROOT),staticRoot:resolve(join(ROOT,"dist","web")),entrypoint:resolve(process.argv[1]??CLI_PATH),launcherPath:process.env.AGENT_BUS_LAUNCHER_PATH??null,installRoot:process.env.AGENT_BUS_INSTALL_ROOT??null,nodePath:process.execPath,nodeVersion:process.version,cwd:process.cwd(),ui:{index:EXPECTED_MANIFEST.index,scripts:EXPECTED_MANIFEST.scripts,styles:EXPECTED_MANIFEST.styles}},running};if(hasFlag("--json")){console.log(JSON.stringify(payload,null,2))}else{console.log(\`launcher: \${payload.local.launcherPath??"direct node invocation"}\`);console.log(\`application: \${payload.local.applicationRoot}\`);console.log(\`static: \${payload.local.staticRoot}\`);console.log(\`build: \${payload.local.buildId}\`);console.log(\`running: \${running?JSON.stringify(running):"not running"}\`)}return}\ncase "models":{`,
);

writeFileSync(
  "scripts/verify-production-bundle.mjs",
  `#!/usr/bin/env node\nimport assert from "node:assert/strict";\nimport { readFileSync, readdirSync } from "node:fs";\nimport { join } from "node:path";\n\nconst root = "dist/web";\nconst html = readFileSync(join(root, "index.html"), "utf8");\nassert.match(html, /id="agent-bus-boot"/, "production HTML must contain the pre-React boot diagnostic");\nassert.match(html, /data-boot-stage="10"/, "production HTML must expose all ten boot checkpoints");\nassert.match(html, /<script[^>]+src="\\/boot\\.js"/, "production HTML must load the classic boot monitor before modules");\nconst moduleMatches=[...html.matchAll(/<script[^>]+type="module"[^>]+src="([^\"]+)"/g)].map(match=>match[1]);\nassert.equal(moduleMatches.length,1,"production HTML must load one statically bundled application module");\nassert.match(moduleMatches[0],/^\\/assets\\//);\n\nconst assetDir = join(root, "assets");\nconst javascript = readdirSync(assetDir).filter(name=>name.endsWith(".js")).map(name=>readFileSync(join(assetDir,name),"utf8"));\nassert.ok(javascript.some(code=>code.includes("data-agent-bus-mounted")),"built application must contain the React mount sentinel");\nassert.ok(javascript.some(code=>code.includes("createRoot invocation reached")),"built application must contain createRoot checkpoint instrumentation");\nassert.ok(javascript.some(code=>code.includes("POST /api/session started")),"built application must contain ticket exchange checkpoints");\nassert.equal(javascript.some(code=>/\\bReact\\.createElement\\b/.test(code)),false,"production bundle must not depend on an unbound global React namespace");\nassert.equal(javascript.some(code=>/\\bimport\\s*\\(/.test(code)),false,"production application must not rely on a runtime dynamic-import chunk");\nconst boot=readFileSync(join(root,"boot.js"),"utf8");\nassert.match(boot,/securitypolicyviolation/);\nassert.match(boot,/Agent Bus boot timed out/);\nprocess.stdout.write("production bundle verification passed\\n");\n`,
);

unlinkSync("scripts/apply-runtime-instrumentation.mjs");
