#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = "dist/web";
const html = readFileSync(join(root, "index.html"), "utf8");
assert.match(html, /id="agent-bus-boot"/, "production HTML must contain the pre-React boot diagnostic");
assert.match(html, /data-boot-stage="10"/, "production HTML must expose all ten boot checkpoints");
assert.match(html, /<script[^>]+src="\/boot\.js"/, "production HTML must load the classic boot monitor before modules");
const moduleMatches=[...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map(match=>match[1]);
assert.equal(moduleMatches.length,1,"production HTML must load one statically bundled application module");
assert.match(moduleMatches[0],/^\/assets\//);

const assetDir = join(root, "assets");
const javascript = readdirSync(assetDir).filter(name=>name.endsWith(".js")).map(name=>readFileSync(join(assetDir,name),"utf8"));
assert.ok(javascript.some(code=>code.includes("data-qagent-mounted")),"built application must contain the React mount sentinel");
assert.ok(javascript.some(code=>code.includes("createRoot returned successfully")),"built application must contain createRoot checkpoint instrumentation");
assert.ok(javascript.some(code=>code.includes("POST /api/session started")),"built application must contain ticket exchange checkpoints");
assert.equal(javascript.some(code=>/\bReact\.createElement\b/.test(code)),false,"production bundle must not depend on an unbound global React namespace");
assert.equal(javascript.some(code=>/\bimport\s*\(/.test(code)),false,"production application must not rely on a runtime dynamic-import chunk");
const boot=readFileSync(join(root,"boot.js"),"utf8");
assert.match(boot,/securitypolicyviolation/);
assert.match(boot,/Qagent boot timed out/);
process.stdout.write("production bundle verification passed\n");
