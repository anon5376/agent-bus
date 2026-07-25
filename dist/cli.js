#!/usr/bin/env node
import { join } from "node:path";
import { BUS_HOME, BUS_URL, brokerAlive, brokerCall } from "./protocol.js";
import { startBroker } from "./broker.js";
function fmtAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60)
        return `${s}s`;
    if (s < 3600)
        return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
}
const DOT = {
    idle: "\x1b[32m●\x1b[0m",
    working: "\x1b[33m●\x1b[0m",
    waiting: "\x1b[36m◐\x1b[0m",
    offline: "\x1b[90m○\x1b[0m",
};
async function renderState() {
    const state = await brokerCall("/state", {});
    const out = [];
    out.push("\x1b[1mAGENTS\x1b[0m");
    if (state.roster.length === 0)
        out.push("  (none registered yet)");
    for (const a of state.roster) {
        out.push(`  ${a.stalled ? "\x1b[31m▲\x1b[0m" : (DOT[a.status] ?? "?")} ${a.id.padEnd(12)} ${a.role.padEnd(8)} ` +
            `${(a.stalled ? "STALLED" : String(a.status)).padEnd(8)}` +
            `${a.currentTaskId ? ` ${a.currentTaskId}` : ""}` +
            `${a.pendingMessages ? `  \x1b[35m${a.pendingMessages} unread\x1b[0m` : ""}` +
            `  \x1b[90m${a.model} · seen ${a.lastSeenSecondsAgo}s ago\x1b[0m`);
    }
    out.push("");
    out.push("\x1b[1mTASKS\x1b[0m");
    const open = state.tasks.filter((t) => !["accepted", "cancelled"].includes(t.state));
    if (open.length === 0)
        out.push("  (no open tasks)");
    for (const t of open) {
        out.push(`  ${t.id}  \x1b[1m${t.state}\x1b[0m  ${t.assigner} → ${t.assignee}  r${t.round}  ${t.title}  \x1b[90m${fmtAgo(t.updatedAt)}\x1b[0m`);
    }
    const closed = state.tasks.length - open.length;
    if (closed)
        out.push(`  \x1b[90m(+${closed} closed)\x1b[0m`);
    return out.join("\n");
}
async function main() {
    const cmd = process.argv[2] ?? "status";
    switch (cmd) {
        case "broker": {
            await startBroker();
            // Keep the event loop alive forever.
            return;
        }
        case "supervise": {
            // agent-bus supervise <agent-id> [workdir]
            const id = process.argv[3];
            const workdir = process.argv[4] ?? process.cwd();
            if (!id) {
                console.error("usage: agent-bus supervise <agent-id> [workdir]");
                process.exit(1);
            }
            const { supervise } = await import("./supervisor.js");
            await supervise(id, workdir);
            return;
        }
        case "usage": {
            if (!(await brokerAlive())) {
                console.log(`broker not running at ${BUS_URL}`);
                process.exit(1);
            }
            const state = await brokerCall("/state", {});
            const bySub = {};
            console.log("\x1b[1mUSAGE BY AGENT\x1b[0m");
            for (const a of state.roster) {
                if (a.id === "operator")
                    continue;
                const u = a.usage ?? { turns: 0, tokens: 0, costUSD: 0 };
                const sub = a.auth || "unknown";
                const g = (bySub[sub] ??= { tokens: 0, cost: 0, turns: 0, agents: [] });
                g.tokens += u.tokens;
                g.cost += u.costUSD;
                g.turns += u.turns;
                g.agents.push(a.id);
                const cost = u.costUSD ? ` · $${u.costUSD.toFixed(4)}` : "";
                console.log(`  ${a.id.padEnd(10)} ${String(a.harness ?? "?").padEnd(9)} ${String(a.model).padEnd(12)}` +
                    `  ${String(u.turns).padStart(3)} turns · ${u.tokens.toLocaleString().padStart(9)} tok${cost}`);
            }
            console.log("\n\x1b[1mBY SUBSCRIPTION / HARNESS\x1b[0m");
            for (const [sub, g] of Object.entries(bySub)) {
                const cost = g.cost ? ` · $${g.cost.toFixed(4)}` : "";
                console.log(`  ${sub.padEnd(28)} ${g.turns} turns · ${g.tokens.toLocaleString()} tok${cost}  \x1b[90m(${g.agents.join(", ")})\x1b[0m`);
            }
            return;
        }
        case "status": {
            if (!(await brokerAlive())) {
                console.log(`broker not running at ${BUS_URL} (start it: agent-bus broker)`);
                process.exit(1);
            }
            console.log(await renderState());
            return;
        }
        case "watch": {
            if (!(await brokerAlive())) {
                console.log(`broker not running at ${BUS_URL}`);
                process.exit(1);
            }
            const tick = async () => {
                const body = await renderState().catch((e) => `broker unreachable: ${e.message}`);
                process.stdout.write(`\x1b[2J\x1b[H\x1b[1magent-bus\x1b[0m  ${new Date().toLocaleTimeString()}\n\n${body}\n`);
            };
            await tick();
            setInterval(tick, 1500);
            return;
        }
        case "tail": {
            const { createReadStream, statSync, watch } = await import("node:fs");
            const path = join(BUS_HOME, "bus.jsonl");
            let pos = statSync(path).size;
            const dump = () => {
                const size = statSync(path).size;
                if (size <= pos)
                    return;
                createReadStream(path, { start: pos, end: size })
                    .on("data", (chunk) => {
                    for (const line of chunk.toString().trim().split("\n")) {
                        if (!line)
                            continue;
                        const e = JSON.parse(line);
                        if (e.kind !== "message")
                            continue;
                        const m = e.data;
                        console.log(`\x1b[90m${new Date(m.ts).toLocaleTimeString()}\x1b[0m \x1b[1m${m.from}\x1b[0m → ${m.to} \x1b[36m[${m.type}]\x1b[0m ${m.subject}`);
                    }
                })
                    .on("end", () => (pos = size));
            };
            console.log(`tailing ${path} …`);
            watch(path, dump);
            return;
        }
        case "send": {
            // agent-bus send <to> <subject> [body]  — always sent as the operator
            const { readFileSync } = await import("node:fs");
            const [, , , to, subject, ...rest] = process.argv;
            if (!to || !subject) {
                console.error("usage: agent-bus send <to> <subject> [body]  (sends as operator)");
                process.exit(1);
            }
            let token = "";
            try {
                token = readFileSync(join(BUS_HOME, "operator.token"), "utf8").trim();
            }
            catch {
                console.error("no operator token found — is the broker running?");
                process.exit(1);
            }
            const res = await brokerCall("/send", {
                token,
                to,
                subject,
                body: rest.join(" ") || subject,
                type: "info",
            });
            console.log(JSON.stringify(res, null, 2));
            return;
        }
        default:
            console.log([
                "agent-bus — local message bus for CLI agents",
                "",
                "  agent-bus broker    run the broker daemon (agents auto-start it too)",
                "  agent-bus supervise <agent-id> [workdir]",
                "                      keep an agent permanently reachable: hold its wait,",
                "                      wake it with a fresh prompt whenever mail arrives",
                "  agent-bus status    one-shot roster + task board",
                "  agent-bus watch     live dashboard, refreshes every 1.5s",
                "  agent-bus tail      stream every message as it is delivered",
                "  agent-bus send <from> <to> <subject> [body]   inject a message by hand",
                "",
                `  broker: ${BUS_URL}   state dir: ${BUS_HOME}`,
            ].join("\n"));
    }
}
main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map