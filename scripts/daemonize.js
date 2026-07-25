#!/usr/bin/env node
// Start a node process in its own session so it survives the parent terminal
// dying, job-control signals, or a SIGTERM aimed at the parent's process group.
//
//   node scripts/daemonize.js <logfile> <script> [args...]
//
// `nohup ... &` is not enough: it only ignores SIGHUP, so anything that signals
// the whole process group still takes the daemon down with it.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

const [, , logFile, script, ...args] = process.argv;
if (!logFile || !script) {
  console.error("usage: daemonize.js <logfile> <script> [args...]");
  process.exit(1);
}

const fd = openSync(logFile, "a");
const child = spawn(process.execPath, [script, ...args], {
  detached: true, // setsid(): new session, new process group
  stdio: ["ignore", fd, fd],
});
child.unref();
console.log(child.pid);
