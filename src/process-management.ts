import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";

export interface ProductHealth {
  ok?: boolean;
  pid?: number;
  product?: string;
  productProtocol?: number;
  buildId?: string;
  dashboard?: boolean;
  uiBuilt?: boolean;
  durable?: boolean;
  agents?: number;
  tasks?: number;
  runs?: number;
}

export interface PortOwner {
  pid: number;
  command: string;
  kind: "current" | "agent-bus" | "unrelated";
  reason: string;
}

export interface StopResult {
  stoppedPids: number[];
  forcedPids: number[];
  unrelated: PortOwner[];
}

export function knownAgentBusCommand(command: string): boolean {
  const text = command.trim();
  if (!text) return false;
  return /(?:^|\s)(?:\S*node\S*\s+)?\S*\/agent-bus\/(?:dist\/(?:cli|broker|product-server)\.js|cli\.js)(?:\s+(?:broker|dashboard|supervise)(?:\s|$)|\s*$)/i.test(text)
    || /(?:^|\s)(?:\S*node\S*\s+)?\S*\/agent-bus\/src\/(?:broker|product-server)\.(?:js|ts)(?:\s|$)/i.test(text);
}

function legacyHealthShape(health: ProductHealth | null): boolean {
  if (!health || health.ok !== true || health.durable !== true) return false;
  return Number.isFinite(Number(health.pid))
    && Number.isFinite(Number(health.agents))
    && Number.isFinite(Number(health.tasks))
    && Number.isFinite(Number(health.runs));
}

export function classifyPortOwner(pid: number, command: string, health: ProductHealth | null, expectedBuildId: string): PortOwner {
  const healthBelongsToPid = Number(health?.pid) === pid;
  if (healthBelongsToPid && health?.product === PRODUCT_NAME) {
    const current = health.productProtocol === PRODUCT_PROTOCOL_VERSION
      && health.buildId === expectedBuildId
      && health.dashboard === true
      && health.uiBuilt === true;
    return {
      pid,
      command,
      kind: current ? "current" : "agent-bus",
      reason: current ? "current Agent Bus product" : "Agent Bus product with a different build/protocol",
    };
  }
  if (healthBelongsToPid && legacyHealthShape(health)) {
    return { pid, command, kind: "agent-bus", reason: "legacy Agent Bus health signature" };
  }
  if (knownAgentBusCommand(command)) {
    return { pid, command, kind: "agent-bus", reason: "known Agent Bus executable" };
  }
  return { pid, command, kind: "unrelated", reason: "listener does not identify as Agent Bus" };
}

export function listenerPids(port: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(output.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
  } catch {
    return [];
  }
}

export function processCommand(pid: number): string {
  if (process.platform === "win32") return "";
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export async function fetchHealth(url: string): Promise<ProductHealth | null> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const value = await response.json();
    return value && typeof value === "object" ? value as ProductHealth : null;
  } catch {
    return null;
  }
}

export async function inspectPort(port: number, url: string, expectedBuildId: string): Promise<PortOwner[]> {
  const pids = listenerPids(port);
  if (!pids.length) return [];
  const health = await fetchHealth(url);
  return pids.map((pid) => classifyPortOwner(pid, processCommand(pid), health, expectedBuildId));
}

function knownServicePids(includeSupervisors: boolean): number[] {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return [];
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return [];
      const command = match[2];
      if (!knownAgentBusCommand(command)) return [];
      if (!includeSupervisors && /\s+supervise(?:\s|$)/.test(command)) return [];
      return [pid];
    });
  } catch {
    return [];
  }
}

async function supervisorPids(url: string, health: ProductHealth | null): Promise<number[]> {
  if (!health || !(health.product === PRODUCT_NAME || legacyHealthShape(health))) return [];
  try {
    const response = await fetch(`${url}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return [];
    const body = await response.json() as { roster?: Array<{ supervisorPid?: number }> };
    return (body.roster ?? []).map((item) => Number(item.supervisorPid)).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); return; } catch {}
  try { process.kill(pid, signal); } catch {}
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter(alive);
  while (remaining.length && Date.now() < deadline) {
    await sleep(80);
    remaining = remaining.filter(alive);
  }
  return remaining;
}

export async function terminatePids(pids: number[]): Promise<{ stopped: number[]; forced: number[] }> {
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
  if (!unique.length) return { stopped: [], forced: [] };
  for (const pid of unique) signalPid(pid, "SIGTERM");
  let remaining = await waitForExit(unique, 3000);
  const forced = remaining.slice();
  for (const pid of remaining) signalPid(pid, "SIGKILL");
  remaining = await waitForExit(remaining, 1500);
  return { stopped: unique.filter((pid) => !remaining.includes(pid)), forced };
}

export async function stopAgentBusProcesses(options: {
  port: number;
  url: string;
  expectedBuildId: string;
  includeSupervisors: boolean;
}): Promise<StopResult> {
  const health = await fetchHealth(options.url);
  const owners = await inspectPort(options.port, options.url, options.expectedBuildId);
  const unrelated = owners.filter((owner) => owner.kind === "unrelated");
  const safeListenerPids = owners.filter((owner) => owner.kind !== "unrelated").map((owner) => owner.pid);
  const pids = [
    ...safeListenerPids,
    ...knownServicePids(options.includeSupervisors),
    ...(options.includeSupervisors ? await supervisorPids(options.url, health) : []),
  ];
  const { stopped, forced } = await terminatePids(pids);
  return { stoppedPids: stopped, forcedPids: forced, unrelated };
}

export async function waitForPortFree(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!listenerPids(port).length) return true;
    await sleep(80);
  }
  return !listenerPids(port).length;
}
