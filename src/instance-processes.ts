import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type AgentBusProcessKind = "broker" | "supervisor";

interface AgentBusProcessRecord {
  pid: number;
  kind: AgentBusProcessKind;
  agentId: string | null;
  busHome: string;
  port: number;
  applicationRoot: string;
  command: string;
  startFingerprint: string;
  recordedAt: number;
}

function psField(pid: number, field: string): string {
  if (process.platform === "win32") return "";
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function processCommand(pid: number): string {
  return psField(pid, "command");
}

export function processStartFingerprint(pid: number): string {
  return psField(pid, "lstart").replace(/\s+/g, " ").trim();
}

function processDirectory(busHome: string): string {
  return join(resolve(busHome), "runtime", "processes");
}

function recordPath(busHome: string, pid: number): string {
  return join(processDirectory(busHome), `${pid}.json`);
}

function removeRecord(path: string): void {
  try { unlinkSync(path); } catch {}
}

export function recordCurrentAgentBusProcess(options: {
  busHome: string;
  port: number;
  applicationRoot: string;
  kind: AgentBusProcessKind;
  agentId?: string | null;
}): () => void {
  if (process.platform === "win32") return () => {};
  const command = processCommand(process.pid);
  const startFingerprint = processStartFingerprint(process.pid);
  if (!command || !startFingerprint) return () => {};

  const directory = processDirectory(options.busHome);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = recordPath(options.busHome, process.pid);
  const temp = `${path}.${process.pid}.tmp`;
  const record: AgentBusProcessRecord = {
    pid: process.pid,
    kind: options.kind,
    agentId: options.agentId ?? null,
    busHome: resolve(options.busHome),
    port: options.port,
    applicationRoot: resolve(options.applicationRoot),
    command,
    startFingerprint,
    recordedAt: Date.now(),
  };
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);

  return () => {
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentBusProcessRecord>;
      if (Number(current.pid) === process.pid && current.startFingerprint === startFingerprint) removeRecord(path);
    } catch {}
  };
}

export function ownedAgentBusPids(options: {
  busHome: string;
  port: number;
  includeSupervisors: boolean;
}): number[] {
  if (process.platform === "win32") return [];
  const directory = processDirectory(options.busHome);
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }

  const owned: number[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    let record: AgentBusProcessRecord;
    try { record = JSON.parse(readFileSync(path, "utf8")) as AgentBusProcessRecord; }
    catch { removeRecord(path); continue; }

    const pid = Number(record.pid);
    const validShape = Number.isInteger(pid) && pid > 0
      && (record.kind === "broker" || record.kind === "supervisor")
      && resolve(String(record.busHome ?? "")) === resolve(options.busHome)
      && Number(record.port) === options.port
      && typeof record.command === "string" && record.command.length > 0
      && typeof record.startFingerprint === "string" && record.startFingerprint.length > 0;
    if (!validShape) { removeRecord(path); continue; }
    if (!options.includeSupervisors && record.kind === "supervisor") continue;

    const command = processCommand(pid);
    const startFingerprint = processStartFingerprint(pid);
    if (command !== record.command || startFingerprint !== record.startFingerprint) {
      removeRecord(path);
      continue;
    }
    if (pid !== process.pid) owned.push(pid);
  }
  return [...new Set(owned)];
}
