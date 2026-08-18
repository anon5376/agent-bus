#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

function replaceOnce(path, from, to) {
  const source = readFileSync(path, "utf8");
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`patch target not found in ${path}: ${from.slice(0, 180)}`);
  writeFileSync(path, source.replace(from, to));
}

for (const path of ["scripts/browser-smoke.mjs", "scripts/installed-browser-smoke.mjs"]) {
  replaceOnce(
    path,
    'import { mkdtempSync, readFileSync, rmSync } from "node:fs";',
    'import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";',
  );
  replaceOnce(
    path,
    '  const debugPort = await freePort();\n  const browser = spawn(chromeBinary(), [',
    '  const debugPort = await freePort();\n  mkdirSync(profileDir, { recursive: true });\n  const browser = spawn(chromeBinary(), [',
  );
  replaceOnce(
    path,
    '    `--remote-debugging-port=${debugPort}`,',
    '    `--remote-debugging-address=127.0.0.1`,\n    `--remote-debugging-port=${debugPort}`,',
  );
  replaceOnce(
    path,
    '    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);',
    '    try {\n      await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);\n    } catch (error) {\n      throw new Error(`${error.message}\\nChrome exit=${browser.exitCode} signal=${browser.signalCode}\\n${stderr.slice(-5000)}`);\n    }',
  );
}

replaceOnce(
  "scripts/installed-browser-smoke.mjs",
  'const processCommand = command("ps", "-p", String(runtime.pid), "-o", "command=");\nassert.match(processCommand, /\\.agent-bus\\/app\\/current\\/cli\\.js broker|\\.agent-bus\\/app\\/releases\\/[^/]+\\/cli\\.js broker/);',
  'const processCommand = command("ps", "-p", String(runtime.pid), "-o", "command=");\nassert.ok(processCommand.includes(`${releaseRoot}/cli.js broker`), `running PID command mismatch: ${processCommand}`);',
);

replaceOnce(
  "web/src/main.tsx",
  'checkpoint(5,"createRoot invocation reached");\nconst reactRoot=createRoot(rootElement);\ncheckpoint(6,"React root created; render invocation reached");\nreactRoot.render(<AppErrorBoundary><App/></AppErrorBoundary>);',
  'const reactRoot=createRoot(rootElement);\ncheckpoint(5,"createRoot returned successfully");\nreactRoot.render(<AppErrorBoundary><App/></AppErrorBoundary>);\ncheckpoint(6,"render returned successfully");',
);

replaceOnce(
  "scripts/verify-production-bundle.mjs",
  'assert.ok(javascript.some(code=>code.includes("createRoot invocation reached")),"built application must contain createRoot checkpoint instrumentation");',
  'assert.ok(javascript.some(code=>code.includes("createRoot returned successfully")),"built application must contain createRoot checkpoint instrumentation");',
);
replaceOnce(
  "scripts/browser-smoke.mjs",
  '  assert.match(applicationBody, /createRoot invocation reached/);',
  '  assert.match(applicationBody, /createRoot returned successfully/);',
);
replaceOnce(
  "scripts/installed-browser-smoke.mjs",
  'assert.match(artifactBodies.get(applicationScript.url).toString("utf8"), /createRoot invocation reached/);',
  'assert.match(artifactBodies.get(applicationScript.url).toString("utf8"), /createRoot returned successfully/);',
);

unlinkSync("scripts/apply-browser-launch-fixes.mjs");
