import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUS_HOME, MAX_WAIT_MS, brokerAlive, brokerCall, } from "./protocol.js";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "mcp-server.js");
const LOG_DIR = join(BUS_HOME, "logs");
/** Human-readable per-agent conversation, one file per agent, for the GUI to open. */
const TRANSCRIPT_DIR = join(BUS_HOME, "transcripts");
function loadAgent(id) {
    const all = JSON.parse(readFileSync(join(ROOT, "agents.json"), "utf8"));
    const def = all[id];
    if (!def) {
        throw new Error(`unknown agent "${id}" — agents.json has: ${Object.keys(all).join(", ")}`);
    }
    // Migrate compatibly: harness is the new field, cli the old one.
    def.harness = def.harness ?? def.cli ?? "claude";
    def.cli = def.harness;
    return def;
}
function log(agentId, line) {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    process.stdout.write(stamped + "\n");
    try {
        appendFileSync(join(LOG_DIR, `${agentId}.log`), stamped + "\n");
    }
    catch {
        /* never let logging kill the supervisor */
    }
}
/** Pull the agent's readable reply out of a CLI's raw stdout. */
function extractResponseText(cli, stdout) {
    if (cli === "claude") {
        // Claude --output-format json emits one result envelope with a .result string.
        for (const line of stdout.trim().split("\n").reverse()) {
            try {
                const o = JSON.parse(line);
                if (o && typeof o.result === "string")
                    return o.result;
            }
            catch {
                /* not the envelope line */
            }
        }
    }
    if (cli === "opencode") {
        // --format json emits events; the assistant's prose is in text parts.
        const parts = [];
        for (const line of stdout.split("\n")) {
            try {
                const o = JSON.parse(line.trim());
                const p = o?.part;
                if (p && p.type === "text" && typeof p.text === "string")
                    parts.push(p.text);
            }
            catch {
                /* not a json event line */
            }
        }
        if (parts.length)
            return parts.join("");
    }
    if (cli === "aider") {
        // Aider prints THINKING then ANSWER sections. Extract the ANSWER block —
        // that's the model's actual response. Strip ANSI colours first.
        const clean = stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
        const m = clean.match(/►\s*ANSWER\s*([\s\S]*?)(?:Tokens:|$)/);
        if (m && m[1].trim())
            return m[1].trim();
        // Fallback: if no ANSWER marker, return everything after the last divider
        const lines = clean.split("\n");
        const lastDivider = lines.lastIndexOf(lines.find((l) => l.match(/^─{20,}$/)) ?? "");
        if (lastDivider >= 0 && lastDivider < lines.length - 1) {
            return lines.slice(lastDivider + 1).join("\n").trim();
        }
    }
    if (cli === "hermes") {
        // Hermes CLI in -q (quiet) mode prints the response between horizontal
        // divider lines, after the "Initializing agent..." preamble. Strip ANSI,
        // find the last ─ divider block and extract the content between them.
        const clean = stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
        const blocks = clean.split(/\n─{20,}\n/);
        if (blocks.length >= 2) {
            // The response is in the second-to-last block (between the two dividers)
            const response = blocks[blocks.length - 2].trim();
            if (response)
                return response;
        }
        // Fallback: strip lines that are just whitespace or UI noise
        const lines = clean.split("\n").filter((l) => {
            const t = l.trim();
            return t && !t.startsWith("Initializing") && !t.startsWith("Resume")
                && !t.startsWith("Session:") && !t.startsWith("Duration:")
                && !t.startsWith("Messages:");
        });
        return lines.join("\n").trim() || "(no textual output captured)";
    }
    // Codex/grok/kimi print prose directly; keep it as-is (trimmed) so the transcript
    // shows exactly what the agent said and did.
    const trimmed = stdout.trim();
    return trimmed || "(no textual output captured)";
}
/** Best-effort usage for one turn: tokens spent and USD cost where the harness reports it. */
function extractUsage(harness, stdout) {
    let tokens = 0;
    let costUSD = 0;
    if (harness === "claude") {
        for (const line of stdout.trim().split("\n").reverse()) {
            try {
                const o = JSON.parse(line);
                if (o?.usage) {
                    tokens =
                        (o.usage.input_tokens ?? 0) +
                            (o.usage.output_tokens ?? 0) +
                            (o.usage.cache_read_input_tokens ?? 0) +
                            (o.usage.cache_creation_input_tokens ?? 0);
                    costUSD = o.total_cost_usd ?? 0;
                    break;
                }
            }
            catch {
                /* not the envelope */
            }
        }
    }
    else if (harness === "codex") {
        // Codex prints "tokens used" then the number (e.g. "20,250") on the next line.
        const m = stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").match(/tokens used\s*\n\s*([\d,]+)/i);
        if (m)
            tokens = Number(m[1].replace(/,/g, "")) || 0;
    }
    else if (harness === "kimi" || harness === "opencode") {
        // step_finish events carry {"tokens":{"total":N,...}} — take the largest total.
        for (const m of stdout.matchAll(/"tokens":\{"total":(\d+)/g)) {
            tokens = Math.max(tokens, Number(m[1]) || 0);
        }
    }
    else if (harness === "grok") {
        const m = stdout.match(/"(total_tokens|totalTokens)":(\d+)/);
        if (m)
            tokens = Number(m[2]) || 0;
    }
    else if (harness === "aider") {
        // Aider prints "Tokens: 2.3k sent, 84 received" at the end of each turn.
        const clean = stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
        const m = clean.match(/Tokens:\s*([\d.]+k?)\s*sent,\s*([\d.]+k?)\s*received/i);
        if (m) {
            const parseTok = (s) => s.endsWith("k") ? Math.round(Number(s.slice(0, -1)) * 1000) : Number(s);
            tokens = parseTok(m[1]) + parseTok(m[2]);
        }
    }
    else if (harness === "hermes") {
        // Hermes prints "~3,688 tokens" or "Context: 2 msgs, ~3,688 tokens"
        const clean = stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
        const m = clean.match(/~?([\d,]+)\s*tokens/i);
        if (m)
            tokens = Number(m[1].replace(/,/g, "")) || 0;
    }
    return { tokens, costUSD };
}
/** Append one turn to the agent's readable transcript file. */
function appendTranscript(agentId, turn, promptMessages, cli, stdout, code) {
    const ts = new Date().toLocaleString();
    const incoming = promptMessages
        .map((m) => `**${m.from} → ${agentId}** (${m.type}${m.taskId ? ` · ${m.taskId}` : ""})\n${m.subject}\n\n${m.body}`)
        .join("\n\n");
    const response = extractResponseText(cli, stdout);
    const block = [
        `\n---\n`,
        `### Turn ${turn} · ${ts}${code === 0 ? "" : `  ⚠️ exited ${code}`}`,
        ``,
        `#### ▸ Received`,
        incoming,
        ``,
        `#### ◂ ${agentId} replied`,
        response,
        ``,
    ].join("\n");
    try {
        appendFileSync(join(TRANSCRIPT_DIR, `${agentId}.md`), block);
    }
    catch {
        /* transcript is best-effort */
    }
}
/** Turn the mail that woke us into the prompt we hand the agent. */
function buildPrompt(messages) {
    const rendered = messages
        .map((m) => [
        `── from ${m.from} · ${m.type}${m.taskId ? ` · ${m.taskId}` : ""}`,
        m.subject,
        "",
        m.body,
    ].join("\n"))
        .join("\n\n");
    return [
        `=== agent-bus: ${messages.length} new message(s) ===`,
        "",
        rendered,
        "",
        "=== end of messages ===",
        "",
        "Act on these now using the agent-bus tools (bus_submit_work, bus_review_work,",
        "bus_send, bus_assign_task). Do the actual work before you report it.",
        "",
        "Do NOT call bus_wait. A supervisor process is holding the wait for you and will",
        "wake you with a new prompt the moment more mail arrives. End your turn once you",
        "have responded — you will not miss anything.",
    ].join("\n");
}
/** Prompt for a harness with no bus tools (aider). Just do the work — the
 * supervisor will report to the bus on your behalf. */
function buildSlavePrompt(messages) {
    const rendered = messages
        .map((m) => [
        `── from ${m.from} · ${m.type}${m.taskId ? ` · ${m.taskId}` : ""}`,
        m.subject,
        "",
        m.body,
    ].join("\n"))
        .join("\n\n");
    return [
        `=== agent-bus: ${messages.length} new message(s) ===`,
        "",
        rendered,
        "",
        "=== end of messages ===",
        "",
        "Do the work described above. Edit the files directly. Do NOT try to call",
        "any bus tools, send messages, or report back — your supervisor handles all",
        "bus communication on your behalf. Just do the actual work and end your turn.",
    ].join("\n");
}
/** Per-CLI invocation, including how to resume the agent's own session. */
function buildCommand(def, agentId, prompt, session) {
    const env = {
        AGENT_ID: agentId,
        AGENT_ROLE: def.role,
        AGENT_MODEL: def.model,
        AGENT_DESC: def.description,
        AGENT_HARNESS: def.harness,
        AGENT_AUTH: def.auth ?? "",
        // Keep bus_wait's block shorter than the host CLI's own MCP tool timeout.
        AGENT_BUS_BLOCK_SEC: def.harness === "claude" ? "900" : "240",
    };
    switch (def.harness) {
        case "claude": {
            const mcp = JSON.stringify({
                mcpServers: {
                    "agent-bus": { command: process.execPath, args: [SERVER], env },
                },
            });
            const args = [
                "-p",
                prompt,
                "--mcp-config",
                mcp,
                "--output-format",
                "json",
                "--permission-mode",
                "acceptEdits",
                // acceptEdits covers file writes but NOT MCP tools — without this the agent
                // wakes, reasons correctly, and then has every bus call denied, which looks
                // exactly like the agent ignoring the protocol.
                "--allowedTools",
                "mcp__agent-bus,Bash,Read,Write,Edit,Glob,Grep",
            ];
            if (session)
                args.push("--resume", session);
            if (def.cliModel)
                args.push("--model", def.cliModel);
            if (def.effort)
                args.push("--effort", def.effort);
            return { cmd: "claude", args, env };
        }
        case "codex": {
            const cfg = [
                `mcp_servers.agent_bus.command="${process.execPath}"`,
                `mcp_servers.agent_bus.args=["${SERVER}"]`,
                `mcp_servers.agent_bus.startup_timeout_sec=30`,
                `mcp_servers.agent_bus.tool_timeout_sec=300`,
                `mcp_servers.agent_bus.env={AGENT_ID="${agentId}",AGENT_ROLE="${def.role}",` +
                    `AGENT_MODEL="${def.model}",AGENT_DESC="${def.description}",` +
                    `AGENT_BUS_BLOCK_SEC="240"}`,
            ].flatMap((c) => ["-c", c]);
            // Reasoning-effort override (e.g. "high"). Also required for OSS models like
            // glm-5.2 via Ollama, which reject codex's default "xhigh".
            if (def.reasoning)
                cfg.push("-c", `model_reasoning_effort="${def.reasoning}"`);
            if (def.oss)
                cfg.push("--oss", "--local-provider", def.oss);
            // The workspace-write sandbox silently cancels every MCP tool call in this
            // Codex build, which leaves a worker able to do the work but unable to report
            // it. Bypassing the sandbox is the only config where both work — so a
            // supervised Codex agent runs unsandboxed. Keep its workdir trusted.
            const auto = ["--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];
            // Options must precede the positional prompt; --last picks this agent's
            // most recent session rather than us tracking a uuid.
            const base = session
                ? ["exec", "resume", ...cfg, ...auto, "--last"]
                : ["exec", ...cfg, ...auto];
            const args = [...base, prompt];
            if (def.cliModel)
                args.push("-m", def.cliModel);
            return { cmd: "codex", args, env };
        }
        case "kimi": {
            // Kimi reads its MCP servers from ~/.kimi-code/config.toml (scripts/setup.sh).
            // -p is single-shot and already non-interactive (it rejects --auto/--yolo).
            // -r <session_id> resumes the prior conversation.
            const args = session ? ["-r", session, "-p", prompt] : ["-p", prompt];
            if (def.cliModel)
                args.push("-m", def.cliModel);
            return { cmd: "kimi", args, env };
        }
        case "grok": {
            // Official grok CLI: -p single-turn, json output for the session id, resume
            // with -r, --always-approve for headless tool use. MCP via `grok mcp add`.
            const args = ["-p", prompt, "--output-format", "json", "--always-approve"];
            if (session)
                args.push("-r", session);
            if (def.cliModel)
                args.push("-m", def.cliModel);
            return { cmd: "grok", args, env };
        }
        case "gemini": {
            const args = ["-p", prompt];
            if (def.cliModel)
                args.push("-m", def.cliModel);
            return { cmd: "gemini", args, env };
        }
        case "opencode": {
            // opencode reads its MCP servers + AGENT_ID from opencode.json in the workdir
            // (written in supervise()). --auto approves tool use headlessly; --format json
            // gives us the sessionID to resume and the text parts for the transcript.
            const args = ["run", "--auto", "--format", "json"];
            if (def.cliModel)
                args.push("-m", def.cliModel);
            if (def.effort)
                args.push("--variant", def.effort);
            if (session)
                args.push("-s", session); // resume this session
            args.push(prompt);
            return { cmd: "opencode", args, env };
        }
        case "aider": {
            // Aider is a code-editing assistant — no MCP support, no tool calling, no
            // command execution. It is a "literal slave": the supervisor drives it in
            // --message mode, it edits files, and the supervisor reports to the bus on
            // its behalf. --yes-always auto-accepts every SEARCH/REPLACE block.
            // --restore-chat-history keeps context across turns (aider saves to
            // --chat-history-file automatically). The supervisor auto-submits work
            // after each turn because aider cannot call bus_submit_work itself.
            const args = [
                "--config", process.env.AIDER_CONFIG ?? join(BUS_HOME, "aider.conf.yml"),
                "--message", prompt,
                "--no-git",
                "--yes-always",
                "--no-show-model-warnings",
                "--restore-chat-history",
            ];
            if (def.cliModel)
                args.push("--model", def.cliModel);
            return { cmd: "aider", args, env };
        }
        case "hermes": {
            // Hermes is a full agent framework with native MCP support. The agent-bus
            // MCP server is wired in the profile config (hermes mcp add), so the agent
            // gets all 9 bus tools directly. It calls bus_wait, bus_submit_work, etc.
            // itself — the supervisor just holds the wait and wakes it with a prompt.
            // --profile selects the dedicated macaron profile (novita endpoint).
            // HERMES_DISABLE_STREAMING=1 is set because novita rejects stream=true.
            const args = ["--profile", def.profile ?? "macaron", "chat", "-q", prompt];
            return { cmd: "hermes", args, env };
        }
        default:
            throw new Error(`supervisor doesn't know how to run cli "${def.harness}"`);
    }
}
/** Claude reports its session id in the JSON envelope; others we track by flag. */
function extractSession(cli, stdout) {
    if (cli === "claude") {
        for (const line of stdout.trim().split("\n").reverse()) {
            try {
                const obj = JSON.parse(line);
                if (obj && typeof obj.session_id === "string")
                    return obj.session_id;
            }
            catch {
                /* not the JSON envelope */
            }
        }
        return null;
    }
    if (cli === "opencode") {
        // Every event carries the sessionID; take the last one we see.
        let sid = null;
        for (const line of stdout.split("\n")) {
            try {
                const o = JSON.parse(line.trim());
                if (o && typeof o.sessionID === "string")
                    sid = o.sessionID;
            }
            catch {
                /* not a json event line */
            }
        }
        return sid;
    }
    if (cli === "kimi") {
        // kimi prints "To resume this session: kimi -r session_<uuid>".
        const m = stdout.match(/kimi -r (session_[\w-]+)/);
        return m ? m[1] : null;
    }
    if (cli === "grok") {
        // grok --output-format json includes a session id; also printed as "grok -r <id>".
        for (const line of stdout.split("\n").reverse()) {
            try {
                const o = JSON.parse(line.trim());
                const sid = o?.session_id ?? o?.sessionId ?? o?.session?.id;
                if (typeof sid === "string")
                    return sid;
            }
            catch {
                /* not json */
            }
        }
        const m = stdout.match(/grok -r ([\w-]+)/);
        return m ? m[1] : null;
    }
    if (cli === "hermes") {
        // Hermes prints "Resume this session with:\n  hermes --resume <id> -p ..."
        const m = stdout.match(/--resume\s+(\S+)/);
        return m ? m[1] : null;
    }
    return null;
}
function runAgent(def, agentId, prompt, session, workdir) {
    const { cmd, args } = buildCommand(def, agentId, prompt, session);
    const childEnv = {
        ...process.env,
        MCP_TOOL_TIMEOUT: "3600000",
    };
    // Aider needs the Novita API key. The supervisor doesn't have it in its own
    // env (it's in the aider env file), so read it and inject it for aider runs.
    if (def.harness === "aider") {
        try {
            const envPath = join(BUS_HOME, "aider.env");
            const envContent = readFileSync(envPath, "utf8");
            const match = envContent.match(/OPENAI_API_KEY=(.+)/);
            if (match)
                childEnv.OPENAI_API_KEY = match[1].trim();
        }
        catch { /* env file missing — aider will warn */ }
    }
    // Agents should draw on the subscription login (Keychain OAuth), not API credits.
    // The supervisor inherits the whole environment, so a stray key set for some other
    // purpose would silently switch every agent turn onto metered billing.
    // Set AGENT_BUS_ALLOW_API_KEY=1 if you actually want key-based auth.
    if (process.env.AGENT_BUS_ALLOW_API_KEY !== "1") {
        delete childEnv.ANTHROPIC_API_KEY;
        delete childEnv.ANTHROPIC_AUTH_TOKEN;
    }
    return new Promise((resolve) => {
        const child = spawn(cmd, args, {
            cwd: workdir,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });
        // Capture both streams: some harnesses (codex) print usage/session info to
        // stderr, so the extractors need the combined output.
        let stdout = "";
        child.stdout.on("data", (d) => {
            stdout += d.toString();
            process.stdout.write(d);
        });
        child.stderr.on("data", (d) => {
            stdout += d.toString();
            process.stderr.write(d);
        });
        child.on("error", (err) => {
            log(agentId, `spawn failed: ${err.message}`);
            resolve({ code: -1, stdout });
        });
        child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
    });
}
/**
 * Hold the blocking wait on the agent's behalf and wake it with a fresh prompt
 * whenever mail arrives. A shell loop cannot decide it is finished, so the agent
 * is structurally incapable of going deaf — and it burns nothing while idle
 * because its process isn't even running.
 */
export async function supervise(agentId, workdir) {
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    const def = loadAgent(agentId);
    if (!(await brokerAlive())) {
        throw new Error("broker is not running — start it with: agent-bus broker");
    }
    const reg = await brokerCall("/register", {
        id: agentId,
        role: def.role,
        model: def.model,
        description: def.description,
        harness: def.harness,
        auth: def.auth ?? "",
    });
    const token = reg.token ?? "";
    // opencode discovers MCP servers + the agent's AGENT_ID from opencode.json in the
    // working directory. Write/refresh it so the bus tools are present and the MCP
    // server registers as this agent. (Merge-safe: only touches the agent-bus key.)
    if (def.harness === "opencode") {
        const cfgPath = join(workdir, "opencode.json");
        let cfg = {};
        try {
            cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        }
        catch { /* new file */ }
        cfg["$schema"] = "https://opencode.ai/config.json";
        cfg.mcp = cfg.mcp ?? {};
        cfg.mcp["agent-bus"] = {
            type: "local",
            command: [process.execPath, SERVER],
            environment: {
                AGENT_ID: agentId,
                AGENT_ROLE: def.role,
                AGENT_MODEL: def.model,
                AGENT_DESC: def.description,
            },
            enabled: true,
        };
        try {
            writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        }
        catch (err) {
            log(agentId, `could not write opencode.json: ${err.message}`);
        }
    }
    // Announce our pid (for the kill switch), workdir and cli (for the GUI's
    // "open session in terminal" action).
    await brokerCall("/presence", {
        token,
        pid: process.pid,
        workdir,
        cli: def.harness,
    }).catch(() => { });
    // Start each supervised run with a session header so the transcript reads cleanly.
    try {
        appendFileSync(join(TRANSCRIPT_DIR, `${agentId}.md`), `\n\n# ═══ Session started ${new Date().toLocaleString()} — ${agentId} (${def.role}, ${def.model}, ${def.harness}) ═══\n`);
    }
    catch { /* best-effort */ }
    log(agentId, `supervising ${agentId} (${def.role}, ${def.harness}) in ${workdir}`);
    let session = null;
    let turn = 0;
    let cumTokens = 0;
    let cumCost = 0;
    let consecutiveFailures = 0;
    for (;;) {
        await brokerCall("/status", { token, status: "waiting" });
        const res = await brokerCall("/wait", { token, timeoutMs: MAX_WAIT_MS, reason: "supervisor holding the wait" }, MAX_WAIT_MS + 15_000).catch((err) => {
            log(agentId, `broker wait failed: ${err.message}`);
            return { messages: [] };
        });
        if (res.messages.length === 0)
            continue; // idle timeout, go straight back to waiting
        log(agentId, `woke on ${res.messages.length} message(s): ` +
            res.messages.map((m) => `${m.from}/${m.type}`).join(", "));
        await brokerCall("/status", { token, status: "working" });
        turn += 1;
        const prompt = def.harness === "aider"
            ? buildSlavePrompt(res.messages)
            : buildPrompt(res.messages);
        const { code, stdout } = await runAgent(def, agentId, prompt, session, workdir);
        appendTranscript(agentId, turn, res.messages, def.harness, stdout, code);
        // Accumulate and report usage so the GUI can show spend per agent/subscription.
        const u = extractUsage(def.harness, stdout);
        cumTokens += u.tokens;
        cumCost += u.costUSD;
        await brokerCall("/usage", {
            token,
            turns: turn,
            tokens: cumTokens,
            costUSD: cumCost,
        }).catch(() => { });
        // Most harnesses hand back a real session id to resume. Codex is the exception:
        // it has no id in exec output, so "resume" is just a marker and `resume --last`
        // reopens its most recent session.
        const found = extractSession(def.harness, stdout);
        if (found)
            session = found;
        else if (def.harness === "codex" && code === 0)
            session = "resume";
        // Aider cannot call bus_submit_work — it has no MCP tools. The supervisor
        // auto-reports on its behalf: the ANSWER block from aider's output becomes
        // the submission summary, and any task that woke us gets submitted.
        if (code === 0 && def.harness === "aider") {
            const answer = extractResponseText("aider", stdout);
            // Find the task that woke us (if any) and submit it.
            const taskMsg = res.messages.find((m) => m.taskId);
            if (taskMsg?.taskId) {
                await brokerCall("/task/submit", {
                    token,
                    taskId: taskMsg.taskId,
                    summary: answer.slice(0, 500),
                    details: "(auto-submitted by supervisor — aider has no bus tools)",
                }).catch((err) => log(agentId, `auto-submit failed: ${err.message}`));
                log(agentId, `auto-submitted task ${taskMsg.taskId} on behalf of aider`);
            }
        }
        if (code === 0) {
            consecutiveFailures = 0;
            log(agentId, `turn complete`);
        }
        else {
            consecutiveFailures += 1;
            const backoff = Math.min(60_000, 2_000 * 2 ** (consecutiveFailures - 1));
            log(agentId, `turn FAILED (exit ${code}); backing off ${backoff / 1000}s`);
            // Put the mail back so the work isn't silently dropped. We hold the agent's
            // token, so this redelivers as the agent to itself — a self-addressed retry.
            await brokerCall("/send", {
                token,
                to: agentId,
                type: "info",
                subject: "Retry: your previous turn failed",
                body: `Your last run exited with code ${code}. The messages below are being redelivered.\n\n` +
                    res.messages.map((m) => `${m.subject}\n${m.body}`).join("\n\n"),
            }).catch(() => { });
            await new Promise((r) => setTimeout(r, backoff));
        }
    }
}
//# sourceMappingURL=supervisor.js.map