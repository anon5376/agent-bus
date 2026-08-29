const CLOSED = ["accepted", "failed", "cancelled"];
export function fmtAgo(ts) {
    const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
}
export function renderBusState(state) {
    const out = [];
    out.push("\x1b[1mAGENTS\x1b[0m");
    for (const agent of state.roster) {
        if (agent.id === "operator")
            continue;
        const marker = agent.stalled
            ? "\x1b[31m▲\x1b[0m"
            : agent.status === "working"
                ? "\x1b[33m●\x1b[0m"
                : agent.status === "waiting" || agent.status === "idle"
                    ? "\x1b[32m●\x1b[0m"
                    : "\x1b[90m○\x1b[0m";
        const task = agent.currentTaskId ? ` · ${agent.currentTaskId}` : "";
        out.push(`  ${marker} ${agent.id.padEnd(12)} ${agent.role.padEnd(15)} ${agent.status.padEnd(9)} ${agent.family}/${agent.model} via ${agent.harness}${task}`);
    }
    out.push("\n\x1b[1mRUNS\x1b[0m");
    if (!state.runs.length)
        out.push("  (none)");
    for (const run of state.runs) {
        out.push(`  ${run.id}  ${run.status.padEnd(9)} ${run.projectRoot} · ${run.goal.slice(0, 90)}`);
    }
    out.push("\n\x1b[1mTASK GRAPH\x1b[0m");
    const open = state.tasks.filter((task) => !CLOSED.includes(task.state));
    if (!open.length)
        out.push("  (no open tasks)");
    for (const task of open) {
        const indent = "  ".repeat(Math.min(6, task.depth + 1));
        out.push(`${indent}${task.id} \x1b[1m${task.state}\x1b[0m ${task.assigner}→${task.assignee || "?"} ${task.role}/c${task.complexity} r${task.round} · ${task.title} · ${fmtAgo(task.updatedAt)}`);
    }
    return out.join("\n");
}
export function renderUsage(state) {
    return state.roster
        .filter((agent) => agent.id !== "operator")
        .map((agent) => {
        const usage = agent.usage;
        const cost = usage.costUSD ? ` · $${usage.costUSD.toFixed(4)}` : "";
        return `${agent.id.padEnd(14)} ${agent.provider.padEnd(10)} ${agent.harness.padEnd(10)} ${usage.turns} turns · ${usage.totalTokens.toLocaleString()} tok · ${Math.round(usage.latencyMs / 1000)}s${cost}`;
    })
        .join("\n");
}
