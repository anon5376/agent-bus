#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverHarnessModels, probeHarness } from "./adapters.js";
import { BusConfig, enabledAgents, loadConfig } from "./config.js";
import {
  BUS_HOME,
  BUS_URL,
  Run,
  Task,
  brokerAlive,
  brokerCall,
} from "./protocol.js";
import {
  OPERATOR_TOKEN_PATH,
  agentTokenPath,
  readTokenFile,
  writePrivateToken,
} from "./security.js";
import { startBroker } from "./broker.js";
import {
  DASHBOARD_URL,
  dashboardAlive,
  startDashboard,
} from "./dashboard.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI_PATH = join(ROOT, "cli.js");

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function operatorToken(): string {
  const token = readTokenFile(OPERATOR_TOKEN_PATH);
  if (!token) throw new Error(`operator token missing at ${OPERATOR_TOKEN_PATH}; start the broker first`);
  return token;
}

async function ensureBrokerStarted(): Promise<void> {
  if (await brokerAlive()) return;
  mkdirSync(BUS_HOME, { recursive: true });
  const log = openSync(join(BUS_HOME, "broker.log"), "a");
  spawn(process.execPath, [CLI_PATH, "broker"], { detached: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
    if (await brokerAlive()) return;
  }
  throw new Error(`could not start broker; see ${join(BUS_HOME, "broker.log")}`);
}

async function ensureDashboardStarted(): Promise<void> {
  if (await dashboardAlive()) return;
  await ensureBrokerStarted();
  mkdirSync(BUS_HOME, { recursive: true });
  const log = openSync(join(BUS_HOME, "dashboard.log"), "a");
  spawn(process.execPath, [CLI_PATH, "dashboard"], { detached: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
    if (await dashboardAlive()) return;
  }
  throw new Error(`could not start dashboard; see ${join(BUS_HOME, "dashboard.log")}`);
}

function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function provisionAgent(id: string, rotate = false): Promise<string> {
  await ensureBrokerStarted();
  const existingFile = readTokenFile(agentTokenPath(id));
  if (existingFile && !rotate) return existingFile;
  const response = await brokerCall<{ token: string | null; provisioned: boolean; message?: string }>("/agent/provision", {
    token: operatorToken(),
    id,
    rotate,
  });
  if (!response.token) {
    throw new Error(`${response.message ?? `identity ${id} already exists`} and ${agentTokenPath(id)} is missing; rerun with --rotate to deliberately replace the token`);
  }
  writePrivateToken(agentTokenPath(id), response.token);
  return response.token;
}

function startSupervisor(agentId: string, workdir: string): number {
  mkdirSync(join(BUS_HOME, "logs"), { recursive: true });
  const log = openSync(join(BUS_HOME, "logs", `${agentId}.out`), "a");
  const child = spawn(process.execPath, [CLI_PATH, "supervise", agentId, workdir], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  return child.pid ?? 0;
}

function fmtAgo(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

async function renderState(): Promise<string> {
  const state = await brokerCall<any>("/state", {});
  const out: string[] = [];
  out.push("\x1b[1mAGENTS\x1b[0m");
  for (const agent of state.roster) {
    if (agent.id === "operator") continue;
    const marker = agent.stalled ? "\x1b[31m▲\x1b[0m" : agent.status === "working" ? "\x1b[33m●\x1b[0m" : agent.status === "waiting" || agent.status === "idle" ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
    const route = `${agent.family}/${agent.model} via ${agent.harness}`;
    out.push(`  ${marker} ${String(agent.id).padEnd(12)} ${String(agent.role).padEnd(15)} ${String(agent.status).padEnd(9)} ${route}` +
      `${agent.currentTaskId ? ` · ${agent.currentTaskId}` : ""}${agent.pendingMessages ? ` · ${agent.pendingMessages} unread` : ""}`);
  }
  out.push("\n\x1b[1mRUNS\x1b[0m");
  if (!state.runs.length) out.push("  (none)");
  for (const run of state.runs) {
    out.push(`  ${run.id}  ${run.status.padEnd(9)} ${run.projectRoot} · ${run.goal.slice(0, 90)}`);
  }
  out.push("\n\x1b[1mTASK GRAPH\x1b[0m");
  const open = state.tasks.filter((task: Task) => !["accepted", "failed", "cancelled"].includes(task.state));
  if (!open.length) out.push("  (no open tasks)");
  for (const task of open) {
    const indent = "  ".repeat(Math.min(6, task.depth + 1));
    const deps = task.dependencyIds.length ? ` deps=${task.dependencyIds.join(",")}` : "";
    const route = task.routing?.reason ? `\n${indent}  \x1b[90m${task.routing.reason}\x1b[0m` : "";
    out.push(`${indent}${task.id} \x1b[1m${task.state}\x1b[0m ${task.assigner}→${task.assignee || "?"} ${task.role}/c${task.complexity} r${task.round}${deps} · ${task.title} · ${fmtAgo(task.updatedAt)}${route}`);
  }
  if (state.pathLeases.length) {
    out.push("\n\x1b[1mPATH LEASES\x1b[0m");
    for (const lease of state.pathLeases) out.push(`  ${lease.taskId} · ${lease.path}`);
  }
  return out.join("\n");
}

function printModels(config: BusConfig): void {
  console.log("MODEL REGISTRY (capabilities are configured heuristics, not objective rankings)\n");
  for (const model of Object.values(config.models)) {
    const provider = config.providers[model.provider];
    const harness = config.harnesses[model.harness];
    console.log(`${model.enabled ? "●" : "○"} ${model.id.padEnd(20)} family=${model.family.padEnd(8)} provider=${model.provider.padEnd(10)} harness=${model.harness.padEnd(10)} auth=${provider.authKind}`);
    console.log(`  selector=${model.exactModel ?? "CLI default"} context=${model.capabilities.contextTokens.toLocaleString()} source=${model.capabilities.source} cost=${model.capabilities.costClass} command=${harness.command}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";

  switch (command) {
    case "start": {
      await ensureBrokerStarted();
      await ensureDashboardStarted();
      if (!hasFlag("--no-open")) openUrl(DASHBOARD_URL);
      console.log("Agent Bus is running.");
      console.log(`Dashboard: ${DASHBOARD_URL}`);
      console.log(`Broker:    ${BUS_URL}`);
      return;
    }

    case "open": {
      await ensureDashboardStarted();
      openUrl(DASHBOARD_URL);
      console.log(DASHBOARD_URL);
      return;
    }

    case "dashboard": {
      await ensureBrokerStarted();
      const handle = await startDashboard();
      const shutdown = async () => {
        await handle.close().catch(() => {});
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }

    case "broker": {
      const handle = await startBroker();
      const shutdown = async () => {
        await handle.close().catch(() => {});
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }

    case "provision": {
      const id = process.argv[3];
      if (!id) throw new Error("usage: agent-bus provision <agent-id> [--rotate]");
      await provisionAgent(id, hasFlag("--rotate"));
      console.log(`${id} token stored at ${agentTokenPath(id)} (mode 0600)`);
      return;
    }

    case "supervise": {
      const id = process.argv[3];
      const workdir = resolve(process.argv[4] ?? process.cwd());
      if (!id) throw new Error("usage: agent-bus supervise <agent-id> [workdir]");
      const { supervise } = await import("./supervisor.js");
      await supervise(id, workdir);
      return;
    }

    case "run": {
      const workdir = resolve(process.argv[3] ?? "");
      const goal = flag("--goal");
      if (!process.argv[3] || !goal) throw new Error("usage: agent-bus run <project-dir> --goal \"Implement X\" [--role manager] [--no-autostart]");
      await ensureBrokerStarted();
      const config = loadConfig();
      const started: { id: string; pid: number }[] = [];
      if (!hasFlag("--no-autostart")) {
        for (const agent of enabledAgents(config).filter((candidate) => candidate.autoStart)) {
          await provisionAgent(agent.id);
          const pid = startSupervisor(agent.id, workdir);
          started.push({ id: agent.id, pid });
        }
        if (started.length) await new Promise((resolveWait) => setTimeout(resolveWait, 900));
      }
      const response = await brokerCall<{ run: Run; rootTask: Task }>("/run/create", {
        token: operatorToken(),
        projectRoot: workdir,
        goal,
        role: flag("--role") ?? "manager",
        network: !hasFlag("--no-network"),
      });
      console.log(`run: ${response.run.id}`);
      console.log(`project: ${response.run.projectRoot}`);
      console.log(`root task: ${response.rootTask.id} → ${response.rootTask.assignee}`);
      console.log(`routing: ${response.rootTask.routing?.reason ?? "unavailable"}`);
      if (started.length) console.log(`supervisors: ${started.map((item) => `${item.id}:${item.pid}`).join(", ")}`);
      console.log(`dashboard: ${DASHBOARD_URL}`);
      return;
    }

    case "route": {
      await ensureBrokerStarted();
      const role = process.argv[3] ?? "implementation";
      const response = await brokerCall<any>("/route/preview", {
        role,
        complexity: Number(flag("--complexity") ?? 3),
        contextTokens: Number(flag("--context") ?? 8000),
        writeAccess: hasFlag("--write"),
        shell: hasFlag("--shell") || hasFlag("--write"),
        network: hasFlag("--network"),
        families: flag("--families")?.split(",").filter(Boolean),
        providers: flag("--providers")?.split(",").filter(Boolean),
        exactModel: flag("--model") ?? undefined,
        exactAgent: flag("--agent") ?? undefined,
        implementationFamily: flag("--implementation-family") ?? undefined,
      });
      console.log(response.decision.reason);
      for (const candidate of response.decision.candidates) {
        console.log(`  ${candidate.eligible ? "✓" : "×"} ${candidate.agentId.padEnd(14)} ${candidate.score.toFixed(3)} ${candidate.rejectedBy.join("; ")}`);
      }
      return;
    }

    case "models": {
      const config = loadConfig();
      printModels(config);
      if (hasFlag("--discover")) {
        console.log("\nLIVE DISCOVERY");
        const seen = new Set<string>();
        for (const agent of enabledAgents(config)) {
          if (seen.has(agent.harnessDefinition.id)) continue;
          seen.add(agent.harnessDefinition.id);
          const result = await discoverHarnessModels(agent);
          console.log(`  ${result.harness}: ${result.error ?? (result.models.join(", ") || "no models returned")}`);
        }
      }
      return;
    }

    case "doctor": {
      const config = loadConfig();
      const seen = new Set<string>();
      let failures = 0;
      for (const agent of enabledAgents(config)) {
        if (seen.has(agent.harnessDefinition.id)) continue;
        seen.add(agent.harnessDefinition.id);
        const probe = await probeHarness(agent);
        if (!probe.available) failures += 1;
        console.log(`${probe.available ? "✓" : "×"} ${probe.harness.padEnd(10)} ${probe.version ?? probe.error}`);
      }
      console.log("Authentication is intentionally not inferred from binary availability. Run each official CLI's normal login flow where required.");
      process.exitCode = failures ? 1 : 0;
      return;
    }

    case "status": {
      if (!(await brokerAlive())) throw new Error(`broker not running at ${BUS_URL}`);
      console.log(await renderState());
      return;
    }

    case "watch": {
      if (!(await brokerAlive())) throw new Error(`broker not running at ${BUS_URL}`);
      const tick = async () => {
        const content = await renderState().catch((error) => `broker unreachable: ${error.message}`);
        process.stdout.write(`\x1b[2J\x1b[H\x1b[1magent-bus\x1b[0m ${new Date().toLocaleTimeString()}\n\n${content}\n`);
      };
      await tick();
      setInterval(tick, 1500);
      return;
    }

    case "usage": {
      if (!(await brokerAlive())) throw new Error(`broker not running at ${BUS_URL}`);
      const state = await brokerCall<any>("/state", {});
      for (const agent of state.roster.filter((item: any) => item.id !== "operator")) {
        const usage = agent.usage;
        console.log(`${agent.id.padEnd(14)} ${agent.provider.padEnd(10)} ${agent.harness.padEnd(10)} ${usage.turns} turns · ${usage.totalTokens.toLocaleString()} tok · ${Math.round(usage.latencyMs / 1000)}s${usage.costUSD ? ` · $${usage.costUSD.toFixed(4)}` : ""}`);
      }
      return;
    }

    case "send": {
      await ensureBrokerStarted();
      const to = process.argv[3];
      const subject = process.argv[4];
      const body = process.argv.slice(5).join(" ") || subject;
      if (!to || !subject) throw new Error("usage: agent-bus send <to> <subject> [body]");
      const response = await brokerCall("/send", { token: operatorToken(), to, subject, body, type: "info" });
      console.log(JSON.stringify(response, null, 2));
      return;
    }

    default:
      console.log([
        "agent-bus — universal local harness for heterogeneous coding/research agents",
        "",
        "  agent-bus start [--no-open]               start broker + dashboard",
        "  agent-bus open                            open the dashboard",
        "  agent-bus run <project> --goal \"...\"     create an autonomous run",
        "  agent-bus broker | dashboard              run services in foreground",
        "  agent-bus provision <agent-id> [--rotate]",
        "  agent-bus supervise <agent-id> [workdir]",
        "  agent-bus route <role> [--complexity 1..5] [--write] [--families gpt,claude]",
        "  agent-bus models [--discover]",
        "  agent-bus doctor",
        "  agent-bus status | watch | usage",
        "  agent-bus send <to> <subject> [body]",
        "",
        `  dashboard: ${DASHBOARD_URL}`,
        `  broker:    ${BUS_URL} · state: ${BUS_HOME}`,
      ].join("\n"));
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? error);
  process.exit(1);
});
