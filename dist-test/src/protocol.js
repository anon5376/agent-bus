import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
export const BUS_HOME = process.env.AGENT_BUS_HOME ?? join(homedir(), ".agent-bus");
export const BUS_PORT = Number(process.env.AGENT_BUS_PORT ?? 7717);
export const BUS_HOST = process.env.AGENT_BUS_HOST ?? "127.0.0.1";
export const BUS_URL = process.env.AGENT_BUS_URL ?? `http://${BUS_HOST}:${BUS_PORT}`;
export const MAX_WAIT_MS = 240_000;
export const DEFAULT_WAIT_MS = 180_000;
export const DEFAULT_BLOCK_MS = Number(process.env.AGENT_BUS_BLOCK_SEC ?? 900) * 1000;
export const MAX_BLOCK_MS = 3_600_000;
export const STALE_AGENT_MS = 15 * 60_000;
export function emptyUsage() {
    return { turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, latencyMs: 0 };
}
export function newId(prefix) {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
export async function brokerCall(path, payload, timeoutMs = 20_000) {
    const res = await fetch(`${BUS_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`broker ${path} -> ${res.status}: ${text.slice(0, 800)}`);
    return text ? JSON.parse(text) : {};
}
export async function brokerAlive() {
    try {
        const res = await fetch(`${BUS_URL}/health`, { signal: AbortSignal.timeout(1200) });
        return res.ok;
    }
    catch {
        return false;
    }
}
