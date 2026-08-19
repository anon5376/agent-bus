import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { join, resolve, sep } from "node:path";
import { ownedAgentBusPids, processCommand } from "./instance-processes.js";
import { PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function runtimeBelongsToScope(health, scope) {
    if (!scope.busHome)
        return true;
    const targetHome = resolve(scope.busHome);
    const reportedHome = String(health.runtime?.busHome ?? "").trim();
    if (reportedHome)
        return resolve(reportedHome) === targetHome;
    const applicationRoot = String(health.runtime?.applicationRoot ?? "").trim();
    if (!applicationRoot)
        return false;
    const appRoot = join(targetHome, "app");
    const resolvedApplication = resolve(applicationRoot);
    return resolvedApplication === appRoot || resolvedApplication.startsWith(`${appRoot}${sep}`);
}
export function knownAgentBusCommand(command, scope = {}) {
    const text = command.trim();
    if (!text)
        return false;
    const roots = [String.raw `\S*/agent-bus/`];
    if (scope.busHome)
        roots.push(`${escapeRegex(resolve(scope.busHome))}/app/(?:current|releases/[^/]+)/`);
    else
        roots.push(String.raw `\S*/\.agent-bus/app/(?:current|releases/[^/]+)/`);
    if (scope.applicationRoot)
        roots.push(`${escapeRegex(resolve(scope.applicationRoot))}/`);
    const root = `(?:${[...new Set(roots)].join("|")})`;
    return new RegExp(String.raw `(?:^|\s)(?:\S*node\S*\s+)?${root}(?:dist/(?:cli|broker|product-server)\.js|cli\.js)(?:\s+(?:broker|dashboard|supervise)(?:\s|$)|\s*$)`, "i").test(text)
        || new RegExp(String.raw `(?:^|\s)(?:\S*node\S*\s+)?${root}src/(?:broker|product-server)\.(?:js|ts)(?:\s|$)`, "i").test(text);
}
function legacyHealthShape(health) {
    if (!health || health.ok !== true || health.durable !== true)
        return false;
    return Number.isFinite(Number(health.pid))
        && Number.isFinite(Number(health.agents))
        && Number.isFinite(Number(health.tasks))
        && Number.isFinite(Number(health.runs));
}
export function classifyPortOwner(pid, command, health, expectedBuildId, legacyCatalogFingerprint = false, scope = {}) {
    const healthBelongsToPid = Number(health?.pid) === pid;
    if (healthBelongsToPid && health?.product === PRODUCT_NAME) {
        if (!runtimeBelongsToScope(health, scope)) {
            return { pid, command, kind: "unrelated", reason: "different Agent Bus instance/home" };
        }
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
    if (healthBelongsToPid && legacyHealthShape(health) && legacyCatalogFingerprint) {
        return { pid, command, kind: "agent-bus", reason: "legacy Agent Bus broker fingerprint" };
    }
    if (knownAgentBusCommand(command, scope)) {
        return { pid, command, kind: "agent-bus", reason: "known Agent Bus executable" };
    }
    return { pid, command, kind: "unrelated", reason: "listener does not identify as Agent Bus" };
}
export function listenerPids(port) {
    if (process.platform === "win32")
        return [];
    try {
        const output = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return [...new Set(output.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
    }
    catch {
        return [];
    }
}
export async function fetchHealth(url) {
    try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) });
        if (!response.ok)
            return null;
        const value = await response.json();
        return value && typeof value === "object" ? value : null;
    }
    catch {
        return null;
    }
}
async function legacyCatalogFingerprint(url) {
    try {
        const response = await fetch(`${url}/catalog`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(1200),
        });
        if (!response.ok)
            return false;
        const body = await response.json();
        return typeof body.capabilityNotice === "string"
            && body.providers !== null && typeof body.providers === "object"
            && body.harnesses !== null && typeof body.harnesses === "object"
            && body.models !== null && typeof body.models === "object"
            && body.roles !== null && typeof body.roles === "object"
            && body.agents !== null && typeof body.agents === "object"
            && body.constraints !== null && typeof body.constraints === "object";
    }
    catch {
        return false;
    }
}
export async function inspectPort(port, url, expectedBuildId, scope = {}) {
    const pids = listenerPids(port);
    if (!pids.length)
        return [];
    const health = await fetchHealth(url);
    const legacyFingerprint = legacyHealthShape(health) ? await legacyCatalogFingerprint(url) : false;
    return pids.map((pid) => classifyPortOwner(pid, processCommand(pid), health, expectedBuildId, legacyFingerprint, scope));
}
function installedServicePids(scope, includeSupervisors) {
    if (process.platform === "win32" || !scope.busHome)
        return [];
    const installedRoot = `${join(resolve(scope.busHome), "app")}${sep}`;
    try {
        const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return output.split("\n").flatMap((line) => {
            const match = line.trim().match(/^(\d+)\s+(.+)$/);
            if (!match)
                return [];
            const pid = Number(match[1]);
            const command = match[2];
            if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
                return [];
            if (!command.includes(installedRoot) || !knownAgentBusCommand(command, scope))
                return [];
            if (!includeSupervisors && /\s+supervise(?:\s|$)/.test(command))
                return [];
            return [pid];
        });
    }
    catch {
        return [];
    }
}
async function brokerSupervisorPids(url, health, scope) {
    if (!health || health.product !== PRODUCT_NAME || !runtimeBelongsToScope(health, scope))
        return [];
    try {
        const response = await fetch(`${url}/state`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(1200),
        });
        if (!response.ok)
            return [];
        const body = await response.json();
        const applicationRoot = health.runtime?.applicationRoot || scope.applicationRoot;
        return (body.roster ?? []).flatMap((item) => {
            const pid = Number(item.supervisorPid);
            const id = String(item.id ?? "");
            if (!Number.isInteger(pid) || pid <= 0 || !id)
                return [];
            const command = processCommand(pid);
            if (!knownAgentBusCommand(command, { ...scope, applicationRoot }))
                return [];
            if (!new RegExp(`\\ssupervise\\s+${escapeRegex(id)}(?:\\s|$)`).test(command))
                return [];
            return [pid];
        });
    }
    catch {
        return [];
    }
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function signalPid(pid, signal) {
    try {
        process.kill(-pid, signal);
        return;
    }
    catch { }
    try {
        process.kill(pid, signal);
    }
    catch { }
}
async function waitForExit(pids, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let remaining = pids.filter(alive);
    while (remaining.length && Date.now() < deadline) {
        await sleep(80);
        remaining = remaining.filter(alive);
    }
    return remaining;
}
export async function terminatePids(pids) {
    const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
    if (!unique.length)
        return { stopped: [], forced: [] };
    for (const pid of unique)
        signalPid(pid, "SIGTERM");
    let remaining = await waitForExit(unique, 3000);
    const forced = remaining.slice();
    for (const pid of remaining)
        signalPid(pid, "SIGKILL");
    remaining = await waitForExit(remaining, 1500);
    return { stopped: unique.filter((pid) => !remaining.includes(pid)), forced };
}
export async function stopAgentBusProcesses(options) {
    const scope = { busHome: options.busHome, applicationRoot: options.applicationRoot };
    const health = await fetchHealth(options.url);
    const owners = await inspectPort(options.port, options.url, options.expectedBuildId, scope);
    const unrelated = owners.filter((owner) => owner.kind === "unrelated");
    const safeListenerPids = owners.filter((owner) => owner.kind !== "unrelated").map((owner) => owner.pid);
    const registeredPids = options.busHome
        ? ownedAgentBusPids({ busHome: options.busHome, port: options.port, includeSupervisors: options.includeSupervisors })
        : [];
    const installedPids = installedServicePids(scope, options.includeSupervisors);
    const legacySupervisorPids = options.includeSupervisors && !unrelated.length
        ? await brokerSupervisorPids(options.url, health, scope)
        : [];
    const pids = [...safeListenerPids, ...registeredPids, ...installedPids, ...legacySupervisorPids];
    const { stopped, forced } = await terminatePids(pids);
    return { stoppedPids: stopped, forcedPids: forced, unrelated };
}
export async function waitForPortFree(port, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!listenerPids(port).length)
            return true;
        await sleep(80);
    }
    return !listenerPids(port).length;
}
//# sourceMappingURL=process-management.js.map