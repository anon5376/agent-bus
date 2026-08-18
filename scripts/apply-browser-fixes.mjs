#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

function replaceOnce(path, from, to) {
  const source = readFileSync(path, "utf8");
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`patch target not found in ${path}: ${from.slice(0, 160)}`);
  writeFileSync(path, source.replace(from, to));
}

replaceOnce(
  "scripts/browser-smoke.mjs",
  '  assert.equal(response.status, 200, await response.text());\n  const diagnostic = await response.json();',
  '  const diagnosticText = await response.text();\n  assert.equal(response.status, 200, diagnosticText);\n  const diagnostic = JSON.parse(diagnosticText);',
);
replaceOnce(
  "scripts/browser-smoke.mjs",
  '  const replay = await runChrome(`${handle.url}/?ticket=${encodeURIComponent(ticket)}`, replayProfile, async (state) => state.rootChildren > 0 && state.text.includes("invalid or expired") && state.boot?.diagnostic === true, "replayed ticket diagnostic");',
  '  const replay = await runChrome(`${handle.url}/?ticket=${encodeURIComponent(ticket)}`, replayProfile, async (state) => state.rootChildren > 0 && state.text.includes("invalid or expired") && state.boot?.diagnostic === true && state.search === "", "replayed ticket diagnostic");',
);
replaceOnce(
  "scripts/browser-smoke.mjs",
  '  const expired = await runChrome(`${expiredHandle.url}/?ticket=${encodeURIComponent(expiredTicket)}`, expiredProfile, async (state) => state.rootChildren > 0 && state.text.includes("invalid or expired") && state.boot?.diagnostic === true, "expired ticket diagnostic");',
  '  const expired = await runChrome(`${expiredHandle.url}/?ticket=${encodeURIComponent(expiredTicket)}`, expiredProfile, async (state) => state.rootChildren > 0 && state.text.includes("invalid or expired") && state.boot?.diagnostic === true && state.search === "", "expired ticket diagnostic");',
);

replaceOnce(
  "web/src/main.tsx",
  '    }).catch(e=>{bootMonitor()?.diagnose?.("Agent Bus ticket exchange failed",e);setError(e.message)});',
  '    }).catch(e=>{history.replaceState(null,"",location.pathname);bootMonitor()?.diagnose?.("Agent Bus ticket exchange failed",e);setError(e.message)});',
);

replaceOnce(
  "tests/process-management.test.ts",
  '  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/agent-bus/dist/broker.js"), true);',
  '  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/agent-bus/dist/broker.js"), true);\n  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/.agent-bus/app/current/cli.js broker"), true);\n  assert.equal(knownAgentBusCommand("/opt/homebrew/bin/node /Users/me/.agent-bus/app/releases/abc123/dist/cli.js broker"), true);',
);

unlinkSync("scripts/apply-browser-fixes.mjs");
