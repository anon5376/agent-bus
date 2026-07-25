import { homedir } from "node:os";
import { join } from "node:path";
export const BUS_HOME = process.env.AGENT_BUS_HOME ?? join(homedir(), ".agent-bus");
export const BUS_PORT = Number(process.env.AGENT_BUS_PORT ?? 7717);
export const BUS_HOST = "127.0.0.1";
export const BUS_URL = `http://${BUS_HOST}:${BUS_PORT}`;
/** Longest a single broker long-poll may block. Under undici's 300s header timeout. */
export const MAX_WAIT_MS = 240_000;
export const DEFAULT_WAIT_MS = 180_000;
/**
 * How long `bus_wait` blocks overall. The MCP shim re-issues broker polls back to
 * back for this long, so the agent gets one uninterrupted call rather than a string
 * of empty timeouts it might decide to stop re-calling. Must stay under the host
 * CLI's own MCP tool timeout, which the launcher raises to an hour.
 */
export const DEFAULT_BLOCK_MS = Number(process.env.AGENT_BUS_BLOCK_SEC ?? 900) * 1000;
export const MAX_BLOCK_MS = 3_600_000;
/** An agent is considered offline if it hasn't touched the broker in this long. */
export const STALE_AGENT_MS = 15 * 60_000;
export function newId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now()
        .toString(36)
        .slice(-4)}`;
}
/** POST JSON to the broker and parse the reply. Throws on non-2xx. */
export async function brokerCall(path, payload, timeoutMs = 20_000) {
    const res = await fetch(`${BUS_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`broker ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : {};
}
export async function brokerAlive() {
    try {
        const res = await fetch(`${BUS_URL}/health`, {
            signal: AbortSignal.timeout(1200),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=protocol.js.map