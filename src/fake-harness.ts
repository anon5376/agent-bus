#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : "";
}

const mode = arg("--mode") || "success";
const agent = arg("--agent") || "fake";
const prompt = arg("--prompt");
const existingSession = arg("--session");
const stateFile = process.env.FAKE_HARNESS_STATE;

if (mode === "malformed") {
  process.stdout.write("this is deliberately malformed provider output\n");
  process.exit(0);
}

if (mode === "fail") {
  process.stderr.write("deterministic fake harness failure\n");
  process.exit(23);
}

if (mode === "fail-once") {
  let seen = false;
  if (stateFile) {
    try { seen = readFileSync(stateFile, "utf8").trim() === "failed"; } catch { /* first attempt */ }
    if (!seen) writeFileSync(stateFile, "failed");
  }
  if (!seen) {
    process.stderr.write("deterministic first-attempt failure\n");
    process.exit(24);
  }
}

const inputTokens = Math.max(1, Math.ceil(prompt.length / 4));
const outputTokens = 24;
process.stdout.write(JSON.stringify({
  sessionId: existingSession || `fake-${agent}-session`,
  result: `fake ${agent} completed the assigned work`,
  usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUSD: 0 },
  changedFiles: [],
  validation: [{ passed: true, summary: "deterministic fake harness completed" }]
}) + "\n");
