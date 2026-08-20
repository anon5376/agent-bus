import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchHealth, inspectPort, stopAgentBusProcesses, waitForPortFree, } from "./process-management.js";
import { productArtifactManifest, PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";
import { BUS_HOME, BUS_PORT, BUS_URL } from "./protocol.js";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = join(ROOT, "cli.js");
const STATIC_ROOT = join(ROOT, "dist", "web");
const STATIC_INDEX = join(STATIC_ROOT, "index.html");
const BROKER_LOG = join(BUS_HOME, "broker.log");
const BROKER_LOG_MAX_BYTES = 512 * 1024;
const EXPECTED_MANIFEST = productArtifactManifest(STATIC_ROOT);
export const EXPECTED_BUILD_ID = EXPECTED_MANIFEST.buildId;
export const APPLICATION_ROOT = ROOT;
function isCurrentHealth(health) {
    if (!health)
        return false;
    const runtime = health.runtime;
    return health.product === PRODUCT_NAME
        && health.productProtocol === PRODUCT_PROTOCOL_VERSION
        && health.buildId === EXPECTED_BUILD_ID
        && health.dashboard === true
        && health.uiBuilt === true
        && resolve(runtime?.busHome ?? "") === resolve(BUS_HOME)
        && resolve(runtime?.applicationRoot ?? "") === resolve(ROOT)
        && resolve(runtime?.staticRoot ?? "") === resolve(STATIC_ROOT);
}
function rotateBrokerLog() {
    mkdirSync(BUS_HOME, { recursive: true });
    if (!existsSync(BROKER_LOG))
        return;
    try {
        if (statSync(BROKER_LOG).size <= BROKER_LOG_MAX_BYTES)
            return;
        const previous = `${BROKER_LOG}.1`;
        try {
            unlinkSync(previous);
        }
        catch { }
        renameSync(BROKER_LOG, previous);
    }
    catch { }
}
function brokerLogTail(maxBytes = 16_000) {
    try {
        return readFileSync(BROKER_LOG, "utf8").slice(-maxBytes).trim();
    }
    catch {
        return "";
    }
}
function unrelatedDiagnostic(owners) {
    const owner = owners.find((item) => item.kind === "unrelated");
    if (!owner)
        return null;
    return `Port ${BUS_PORT} is already owned by an unrelated process (PID ${owner.pid}${owner.command ? `: ${owner.command}` : ""}). Agent Bus will not terminate it.`;
}
function sha256(value) {
    return createHash("sha256").update(Buffer.from(value)).digest("hex");
}
export async function runtimeDiagnostic() {
    try {
        const response = await fetch(`${BUS_URL}/diagnostics/runtime?probe=${Date.now()}`, {
            headers: { "cache-control": "no-cache" },
            signal: AbortSignal.timeout(2500),
        });
        if (!response.ok)
            return null;
        return await response.json();
    }
    catch {
        return null;
    }
}
export async function verifyServedDashboard() {
    const assets = [EXPECTED_MANIFEST.index, ...EXPECTED_MANIFEST.scripts, ...EXPECTED_MANIFEST.styles].filter(Boolean);
    const nonce = Date.now().toString(36);
    for (const asset of assets) {
        const pathname = asset.path === "index.html" ? "/" : asset.url;
        if (!pathname)
            throw new Error(`production manifest has no browser URL for ${asset.path}`);
        const separator = pathname.includes("?") ? "&" : "?";
        const response = await fetch(`${BUS_URL}${pathname}${separator}agent_bus_verify=${nonce}`, {
            headers: { "cache-control": "no-cache" },
            signal: AbortSignal.timeout(3500),
        });
        if (!response.ok)
            throw new Error(`served production asset ${pathname} returned HTTP ${response.status}`);
        const body = await response.arrayBuffer();
        if (sha256(body) !== asset.sha256)
            throw new Error(`served ${pathname} does not match the installed artifact`);
    }
}
export async function ensureAgentBusRunning() {
    if (!existsSync(STATIC_INDEX)) {
        throw new Error(`dashboard build missing at ${STATIC_INDEX}; run \`npm run build\` and reinstall Agent Bus`);
    }
    const initialHealth = await fetchHealth(BUS_URL);
    if (isCurrentHealth(initialHealth)) {
        await verifyServedDashboard();
        return { url: BUS_URL, buildId: EXPECTED_BUILD_ID, reused: true };
    }
    const scope = { applicationRoot: ROOT, busHome: BUS_HOME };
    const initialOwners = await inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID, scope);
    const unrelated = unrelatedDiagnostic(initialOwners);
    if (unrelated)
        throw new Error(unrelated);
    const stopped = await stopAgentBusProcesses({
        port: BUS_PORT,
        url: BUS_URL,
        expectedBuildId: EXPECTED_BUILD_ID,
        includeSupervisors: false,
        busHome: BUS_HOME,
        applicationRoot: ROOT,
    });
    if (stopped.unrelated.length)
        throw new Error(unrelatedDiagnostic(stopped.unrelated) ?? "Port is occupied by an unrelated process.");
    if (!(await waitForPortFree(BUS_PORT, 5000)))
        throw new Error(`Agent Bus could not release port ${BUS_PORT}.`);
    rotateBrokerLog();
    const log = openSync(BROKER_LOG, "a");
    const child = spawn(process.execPath, [CLI_PATH, "broker"], { detached: true, stdio: ["ignore", log, log] });
    child.unref();
    for (let i = 0; i < 80; i += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
        if (isCurrentHealth(await fetchHealth(BUS_URL))) {
            await verifyServedDashboard();
            return { url: BUS_URL, buildId: EXPECTED_BUILD_ID, reused: false };
        }
        if (child.exitCode !== null)
            break;
    }
    const owners = await inspectPort(BUS_PORT, BUS_URL, EXPECTED_BUILD_ID, scope);
    const conflict = unrelatedDiagnostic(owners);
    const tail = brokerLogTail();
    throw new Error([
        `Agent Bus failed to start at ${BUS_URL}.`,
        conflict ?? "The broker process did not become healthy.",
        tail ? `Broker log tail:\n${tail}` : "Broker log did not contain an error.",
        `Log: ${BROKER_LOG}`,
    ].join("\n"));
}
export async function stopAgentBusInstance(includeSupervisors = true) {
    return await stopAgentBusProcesses({
        port: BUS_PORT,
        url: BUS_URL,
        expectedBuildId: EXPECTED_BUILD_ID,
        includeSupervisors,
        busHome: BUS_HOME,
        applicationRoot: ROOT,
    });
}
//# sourceMappingURL=lifecycle.js.map