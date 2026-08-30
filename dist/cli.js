#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverHarnessModels, probeHarness } from "./adapters.js";
import { DEFAULT_CONFIG_PATH, enabledAgents, loadConfig } from "./config.js";
import { scanProviders } from "./discover.js";
import { recordCurrentAgentBusProcess } from "./instance-processes.js";
import { renderBusState, renderUsage } from "./cli-view.js";
import { BUS_HOME, BUS_PORT, BUS_URL, brokerAlive, brokerCall, envValue, parseBusState, parseProvisionResponse, parseRoutePreview, parseRunCreateResponse, parseSendResponse, productEnvBindings, } from "./protocol.js";
import { productArtifactManifest, PRODUCT_NAME, PRODUCT_PROTOCOL_VERSION } from "./product-runtime.js";
import { OPERATOR_TOKEN_PATH, agentTokenPath, readTokenFile, writePrivateToken } from "./security.js";
import { DASHBOARD_URL, startProductServer } from "./product-server.js";
import { ensureAgentBusRunning, stopAgentBusInstance } from "./lifecycle.js";
import { launchSupervisor } from "./supervisor-launch.js";
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI_PATH = join(ROOT, "cli.js");
const STATIC_INDEX = join(ROOT, "dist", "web", "index.html");
const BROKER_LOG = join(BUS_HOME, "broker.log");
const BROKER_LOG_MAX_BYTES = 512 * 1024;
const EXPECTED_MANIFEST = productArtifactManifest(join(ROOT, "dist", "web"));
const EXPECTED_BUILD_ID = EXPECTED_MANIFEST.buildId;
const PROCESS_SCOPE = { applicationRoot: ROOT, busHome: BUS_HOME };
function flag(name) { const i = process.argv.indexOf(name); return i >= 0 ? String(process.argv[i + 1] ?? "") : null; }
function hasFlag(name) { return process.argv.includes(name); }
function operatorToken() { const token = readTokenFile(OPERATOR_TOKEN_PATH); if (!token)
    throw new Error(`operator token missing at ${OPERATOR_TOKEN_PATH}; start Qagent first`); return token; }
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
        && resolve(runtime?.staticRoot ?? "") === resolve(join(ROOT, "dist", "web"));
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
        const content = readFileSync(BROKER_LOG, "utf8");
        return content.slice(-maxBytes).trim();
    }
    catch {
        return "";
    }
}
function unrelatedDiagnostic(owners) {
    const owner = owners.find((item) => item.kind === "unrelated");
    if (!owner)
        return null;
    return `Port ${BUS_PORT} is already owned by an unrelated process (PID ${owner.pid}${owner.command ? `: ${owner.command}` : ""}). Qagent will not terminate it.`;
}
function sha256(value) {
    return createHash("sha256").update(Buffer.from(value)).digest("hex");
}
async function runtimeDiagnostic() {
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
async function verifyServedDashboard() {
    const nonce = randomBytes(8).toString("hex");
    const assets = [EXPECTED_MANIFEST.index, ...EXPECTED_MANIFEST.scripts, ...EXPECTED_MANIFEST.styles].filter(Boolean);
    for (const asset of assets) {
        const pathname = asset.path === "index.html" ? "/" : asset.url;
        if (!pathname)
            throw new Error(`production manifest has no browser URL for ${asset.path}`);
        const separator = pathname.includes("?") ? "&" : "?";
        const response = await fetch(`${BUS_URL}${pathname}${separator}qagent_verify=${nonce}`, {
            headers: { "cache-control": "no-cache" },
            signal: AbortSignal.timeout(3500),
        });
        if (!response.ok)
            throw new Error(`served production asset ${pathname} returned HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") ?? "";
        if (asset.path.endsWith(".js") && !contentType.includes("javascript"))
            throw new Error(`served ${pathname} with invalid JavaScript MIME type: ${contentType}`);
        if (asset.path.endsWith(".css") && !contentType.includes("text/css"))
            throw new Error(`served ${pathname} with invalid CSS MIME type: ${contentType}`);
        const digest = sha256(await response.arrayBuffer());
        if (digest !== asset.sha256)
            throw new Error(`served ${pathname} hash ${digest.slice(0, 12)} does not match installed artifact ${asset.sha256.slice(0, 12)}`);
    }
    const remote = await runtimeDiagnostic();
    const remoteBuild = String(remote?.buildId ?? "");
    if (remoteBuild !== EXPECTED_BUILD_ID)
        throw new Error(`running build ${remoteBuild || "unknown"} does not match installed build ${EXPECTED_BUILD_ID}`);
}
async function ensureBrokerStarted() { await ensureAgentBusRunning(); }
function openUrl(url) { const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"; const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]; const child = spawn(command, args, { detached: true, stdio: "ignore" }); child.unref(); }
async function browserUrl() {
    await ensureBrokerStarted();
    let response;
    try {
        response = await fetch(`${BUS_URL}/dashboard/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: operatorToken() }),
            signal: AbortSignal.timeout(3000),
        });
    }
    catch (error) {
        throw new Error(`could not create browser session: ${error.message}`);
    }
    const text = await response.text();
    if (!response.ok)
        throw new Error(`could not create browser session (${response.status}): ${text}`);
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        throw new Error(`dashboard login returned malformed JSON: ${text.slice(0, 500)}`);
    }
    if (!body.ticket)
        throw new Error("dashboard login did not return a one-time ticket");
    return `${DASHBOARD_URL}/?ticket=${encodeURIComponent(body.ticket)}&build=${encodeURIComponent(EXPECTED_BUILD_ID)}&launch=${randomBytes(8).toString("hex")}`;
}
async function provisionAgent(id, rotate = false) { await ensureBrokerStarted(); const existing = readTokenFile(agentTokenPath(id)); if (existing && !rotate)
    return existing; const response = await brokerCall("/agent/provision", { token: operatorToken(), id, rotate }, parseProvisionResponse); if (!response.token)
    throw new Error(`${response.message ?? `identity ${id} already exists`} and ${agentTokenPath(id)} is missing; rerun with --rotate to replace it`); writePrivateToken(agentTokenPath(id), response.token); return response.token; }
function startSupervisor(agentId, workdir, configPath) { return launchSupervisor({ agentId, projectRoot: workdir, configPath, busHome: BUS_HOME, port: BUS_PORT, url: BUS_URL }).pid; }
async function renderState() { return renderBusState(await brokerCall("/state", {}, parseBusState)); }
function printModels(config) { console.log("MODEL REGISTRY (capabilities are configured heuristics, not objective rankings)\n"); for (const model of Object.values(config.models)) {
    const p = config.providers[model.provider];
    const h = config.harnesses[model.harness];
    console.log(`${model.enabled ? "●" : "○"} ${model.id.padEnd(20)} family=${model.family.padEnd(8)} provider=${model.provider.padEnd(10)} harness=${model.harness.padEnd(10)} auth=${p.authKind}`);
    console.log(`  selector=${model.exactModel ?? "CLI default"} context=${model.capabilities.contextTokens.toLocaleString()} source=${model.capabilities.source} cost=${model.capabilities.costClass} command=${h.command}`);
} }
async function main() {
    const command = process.argv[2] ?? "status";
    switch (command) {
        case "start": {
            await ensureBrokerStarted();
            const url = await browserUrl();
            if (!hasFlag("--no-open"))
                openUrl(url);
            console.log("Qagent is running.");
            console.log(`Dashboard: ${DASHBOARD_URL}`);
            return;
        }
        case "open": {
            const url = await browserUrl();
            openUrl(url);
            console.log(DASHBOARD_URL);
            return;
        }
        case "stop": {
            const result = await stopAgentBusInstance(true);
            if (result.unrelated.length)
                console.log(`Preserved unrelated listener on port ${BUS_PORT}: PID ${result.unrelated[0].pid}${result.unrelated[0].command ? ` · ${result.unrelated[0].command}` : ""}`);
            console.log(result.stoppedPids.length ? `Stopped ${result.stoppedPids.length} Qagent process(es)${result.forcedPids.length ? ` (${result.forcedPids.length} forced)` : ""}.` : "Qagent is not running.");
            return;
        }
        case "broker": {
            const removeProcessRecord = recordCurrentAgentBusProcess({ busHome: BUS_HOME, port: BUS_PORT, applicationRoot: ROOT, kind: "broker" });
            try {
                const handle = await startProductServer();
                let shuttingDown = false;
                const shutdown = async () => { if (shuttingDown)
                    return; shuttingDown = true; await handle.close().catch(() => { }); removeProcessRecord(); process.exit(0); };
                process.on("SIGINT", shutdown);
                process.on("SIGTERM", shutdown);
                return;
            }
            catch (error) {
                removeProcessRecord();
                throw error;
            }
        }
        case "provision": {
            const id = process.argv[3];
            if (!id)
                throw new Error("usage: qagent provision <agent-id> [--rotate]");
            await provisionAgent(id, hasFlag("--rotate"));
            console.log(`${id} token stored at ${agentTokenPath(id)} (mode 0600)`);
            return;
        }
        case "supervise": {
            const id = process.argv[3];
            const workdir = resolve(process.argv[4] ?? process.cwd());
            if (!id)
                throw new Error("usage: qagent supervise <agent-id> [workdir]");
            const removeProcessRecord = recordCurrentAgentBusProcess({ busHome: BUS_HOME, port: BUS_PORT, applicationRoot: ROOT, kind: "supervisor", agentId: id });
            try {
                const { supervise } = await import("./supervisor.js");
                await supervise(id, workdir);
            }
            finally {
                removeProcessRecord();
            }
            return;
        }
        case "operator-mcp": {
            const { runOperatorMcpServer } = await import("./operator-mcp.js");
            await runOperatorMcpServer();
            return;
        }
        case "mcp-config": {
            const launcher = String(envValue("QAGENT_LAUNCHER_PATH", "AGENT_BUS_LAUNCHER_PATH") ?? "").trim();
            const configPath = resolve(envValue("QAGENT_CONFIG", "AGENT_BUS_CONFIG") ?? DEFAULT_CONFIG_PATH);
            const entry = resolve(process.argv[1] ?? CLI_PATH);
            const server = {
                command: launcher || process.execPath,
                args: launcher ? ["operator-mcp"] : [entry, "operator-mcp"],
                env: productEnvBindings({ home: resolve(BUS_HOME), config: configPath, port: BUS_PORT, url: BUS_URL }),
            };
            console.log(JSON.stringify({ mcpServers: { qagent: server, "agent-bus": server } }, null, 2));
            return;
        }
        case "run": {
            const workdir = resolve(process.argv[3] ?? "");
            const goal = flag("--goal");
            if (!process.argv[3] || !goal)
                throw new Error("usage: qagent run <project-dir> --goal \"Implement X\" [--role manager] [--no-autostart]");
            const configPath = envValue("QAGENT_CONFIG", "AGENT_BUS_CONFIG") ?? DEFAULT_CONFIG_PATH;
            await ensureBrokerStarted();
            const config = loadConfig(configPath);
            const started = [];
            if (!hasFlag("--no-autostart")) {
                for (const agent of enabledAgents(config).filter(a => a.autoStart)) {
                    await provisionAgent(agent.id);
                    started.push({ id: agent.id, pid: startSupervisor(agent.id, workdir, configPath) });
                }
                if (started.length)
                    await new Promise(r => setTimeout(r, 900));
            }
            const response = await brokerCall("/run/create", { token: operatorToken(), projectRoot: workdir, goal, role: flag("--role") ?? "manager", network: !hasFlag("--no-network") }, parseRunCreateResponse);
            console.log(`run: ${response.run.id}`);
            console.log(`project: ${response.run.projectRoot}`);
            console.log(`root task: ${response.rootTask.id} → ${response.rootTask.assignee}`);
            console.log(`routing: ${response.rootTask.routing?.reason ?? "unavailable"}`);
            if (started.length)
                console.log(`supervisors: ${started.map(x => `${x.id}:${x.pid}`).join(", ")}`);
            console.log(`dashboard: ${DASHBOARD_URL}`);
            return;
        }
        case "route": {
            await ensureBrokerStarted();
            const role = process.argv[3] ?? "implementation";
            const response = await brokerCall("/route/preview", { role, complexity: Number(flag("--complexity") ?? 3), contextTokens: Number(flag("--context") ?? 8000), writeAccess: hasFlag("--write"), shell: hasFlag("--shell") || hasFlag("--write"), network: hasFlag("--network"), families: flag("--families")?.split(",").filter(Boolean), providers: flag("--providers")?.split(",").filter(Boolean), exactModel: flag("--model") ?? undefined, exactAgent: flag("--agent") ?? undefined, implementationFamily: flag("--implementation-family") ?? undefined }, parseRoutePreview);
            console.log(response.decision.reason);
            for (const c of response.decision.candidates)
                console.log(`  ${c.eligible ? "✓" : "×"} ${c.agentId.padEnd(14)} ${c.score.toFixed(3)} ${c.rejectedBy.join("; ")}`);
            return;
        }
        case "runtime": {
            const running = await runtimeDiagnostic();
            const payload = { local: { buildId: EXPECTED_BUILD_ID, applicationRoot: resolve(ROOT), staticRoot: resolve(join(ROOT, "dist", "web")), entrypoint: resolve(process.argv[1] ?? CLI_PATH), launcherPath: envValue("QAGENT_LAUNCHER_PATH", "AGENT_BUS_LAUNCHER_PATH") ?? null, installRoot: envValue("QAGENT_INSTALL_ROOT", "AGENT_BUS_INSTALL_ROOT") ?? null, nodePath: process.execPath, nodeVersion: process.version, cwd: process.cwd(), ui: { index: EXPECTED_MANIFEST.index, scripts: EXPECTED_MANIFEST.scripts, styles: EXPECTED_MANIFEST.styles } }, running };
            if (hasFlag("--json")) {
                console.log(JSON.stringify(payload, null, 2));
            }
            else {
                console.log(`launcher: ${payload.local.launcherPath ?? "direct node invocation"}`);
                console.log(`application: ${payload.local.applicationRoot}`);
                console.log(`static: ${payload.local.staticRoot}`);
                console.log(`build: ${payload.local.buildId}`);
                console.log(`running: ${running ? JSON.stringify(running) : "not running"}`);
            }
            return;
        }
        case "models": {
            const config = loadConfig();
            printModels(config);
            if (hasFlag("--discover")) {
                console.log("\nLIVE DISCOVERY");
                const seen = new Set();
                for (const agent of enabledAgents(config)) {
                    if (seen.has(agent.harnessDefinition.id))
                        continue;
                    seen.add(agent.harnessDefinition.id);
                    const result = await discoverHarnessModels(agent);
                    console.log(`  ${result.harness}: ${result.error ?? (result.models.join(", ") || "no models returned")}`);
                }
            }
            return;
        }
        case "doctor": {
            const config = loadConfig();
            const scans = await scanProviders(config);
            let failures = 0;
            for (const scan of scans) {
                const mark = scan.cliFound ? "✓" : scan.enabled ? "×" : "·";
                if (scan.enabled && !scan.cliFound)
                    failures += 1;
                console.log(`${mark} ${scan.displayName.padEnd(16)} ${scan.cliFound ? (scan.version ?? scan.resolvedPath) : scan.error}`);
                if (!scan.cliFound)
                    console.log(`    login: ${scan.loginCommand || scan.installHint}`);
            }
            const seen = new Set();
            for (const agent of enabledAgents(config)) {
                if (seen.has(agent.harnessDefinition.id))
                    continue;
                seen.add(agent.harnessDefinition.id);
                const probe = await probeHarness(agent);
                if (!probe.available)
                    failures += 1;
            }
            console.log("CLI discovery proves executable availability only. Authentication, subscription entitlement, quota, and exact model access remain live-unverified until a real provider call succeeds.");
            process.exitCode = failures ? 1 : 0;
            return;
        }
        case "status": {
            if (!(await brokerAlive()))
                throw new Error(`broker not running at ${BUS_URL}`);
            console.log(await renderState());
            return;
        }
        case "watch": {
            if (!(await brokerAlive()))
                throw new Error(`broker not running at ${BUS_URL}`);
            const tick = async () => { const content = await renderState().catch(e => `broker unreachable: ${e.message}`); process.stdout.write(`\x1b[2J\x1b[H\x1b[1mqagent\x1b[0m ${new Date().toLocaleTimeString()}\n\n${content}\n`); };
            await tick();
            setInterval(tick, 1500);
            return;
        }
        case "usage": {
            if (!(await brokerAlive()))
                throw new Error(`broker not running at ${BUS_URL}`);
            const usage = renderUsage(await brokerCall("/state", {}, parseBusState));
            if (usage)
                console.log(usage);
            return;
        }
        case "send": {
            await ensureBrokerStarted();
            const to = process.argv[3];
            const subject = process.argv[4];
            const body = process.argv.slice(5).join(" ") || subject;
            if (!to || !subject)
                throw new Error("usage: qagent send <to> <subject> [body]");
            console.log(JSON.stringify(await brokerCall("/send", { token: operatorToken(), to, subject, body, type: "info" }, parseSendResponse), null, 2));
            return;
        }
        default: console.log(["qagent — local multi-model agent control plane", "", "  qagent start [--no-open]", "  qagent open", "  qagent stop", "  qagent run <project> --goal \"...\"", "  qagent broker", "  qagent provision <agent-id> [--rotate]", "  qagent supervise <agent-id> [workdir]", "  qagent operator-mcp", "  qagent mcp-config", "  qagent route <role> [--complexity 1..5] [--write]", "  qagent models [--discover]", "  qagent doctor", "  qagent status | watch | usage", "  qagent send <to> <subject> [body]", "", `  dashboard + broker: ${DASHBOARD_URL} · state: ${BUS_HOME}`].join("\n"));
    }
}
main().catch(error => { console.error(error?.stack ?? error?.message ?? error); process.exit(1); });
//# sourceMappingURL=cli.js.map