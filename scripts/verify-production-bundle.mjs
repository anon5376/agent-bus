#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = "dist/web";
const html = readFileSync(join(root, "index.html"), "utf8");
assert.match(html, /id="agent-bus-boot"/, "production HTML must contain the pre-React boot diagnostic");
assert.match(html, /<script[^>]+type="module"[^>]+src="\/assets\//, "production HTML must load a hashed module asset");

const assetDir = join(root, "assets");
const javascript = readdirSync(assetDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(join(assetDir, name), "utf8"));

assert.ok(javascript.length >= 2, "expected bootstrap and React application chunks");
assert.ok(javascript.some((code) => code.includes("data-agent-bus-mounted")), "built application chunk must contain the React mount sentinel");
assert.ok(javascript.some((code) => code.includes("react-module-loaded")), "built bootstrap chunk must contain boot diagnostics");
assert.equal(javascript.some((code) => /\bReact\.createElement\b/.test(code)), false, "production bundle must not depend on an unbound global React namespace");

process.stdout.write("production bundle verification passed\n");
