import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OperatorControl, OperatorControlError } from "./operator-control.js";
function success(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value && typeof value === "object" ? value : { value },
    };
}
function failure(error) {
    const payload = error instanceof OperatorControlError
        ? { ok: false, code: error.code, error: error.message }
        : { ok: false, code: "INTERNAL_ERROR", error: String(error?.message ?? error) };
    return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
    };
}
function handler(fn) {
    return async (input) => {
        try {
            return success(await fn(input));
        }
        catch (error) {
            return failure(error);
        }
    };
}
export function createOperatorMcpServer(control = new OperatorControl()) {
    const server = new McpServer({ name: "qagent-operator", version: "0.2.0" });
    server.registerTool("qagent_status", {
        description: "Return the authoritative Qagent instance, agent roster, runs, tasks, supervisor PIDs, config identity, and state revision.",
        inputSchema: {},
    }, handler(async () => await control.status()));
    server.registerTool("qagent_catalog", {
        description: "Return the configured providers, harnesses, models, agents, roles, routing policy, and constraints from the running broker.",
        inputSchema: {},
    }, handler(async () => await control.catalog()));
    server.registerTool("qagent_start", {
        description: "Ensure the local Qagent broker and dashboard are running using the same ownership-safe lifecycle path as `qagent start`, without opening a browser.",
        inputSchema: {},
    }, handler(async () => await control.ensureRunning()));
    server.registerTool("qagent_create_run", {
        description: "Create a durable project run and routed root task, provision the assigned agent, and start its verified supervisor.",
        inputSchema: {
            projectRoot: z.string().describe("Absolute or relative project directory"),
            goal: z.string().min(1).describe("Outcome the agent team must deliver"),
            role: z.string().optional().describe("Root task role; defaults to manager"),
            network: z.boolean().optional(),
            startSupervisor: z.boolean().optional(),
        },
    }, handler(async (input) => await control.createRun(input)));
    server.registerTool("qagent_execute", {
        description: "Create a run, start the routed supervisor, and block on broker state notifications until the root task is submitted or terminal. Use qagent_review to accept or request revision.",
        inputSchema: {
            projectRoot: z.string(),
            goal: z.string().min(1),
            role: z.string().optional(),
            timeoutMs: z.number().int().positive().max(240_000).optional(),
        },
    }, handler(async (input) => await control.execute(input)));
    server.registerTool("qagent_delegate", {
        description: "Delegate work to a specific Qagent agent. Pass agent/exactAgent for a roster id, or exactModel + provider/harness (example: exactModel=claude-opus-4-6, provider=anthropic; or exactModel=grok-4.6, harness=cursor). Then start that assignee's supervisor.",
        inputSchema: {
            runId: z.string(),
            parentTaskId: z.string().optional(),
            title: z.string().min(1),
            description: z.string().min(1),
            role: z.string().optional(),
            complexity: z.number().int().min(1).max(5).optional(),
            contextTokens: z.number().int().positive().optional(),
            writeAccess: z.boolean().optional(),
            shell: z.boolean().optional(),
            network: z.boolean().optional(),
            agent: z.string().optional().describe("Roster agent id; alias of exactAgent"),
            exactAgent: z.string().optional().describe("Roster agent id to assign"),
            exactModel: z.string().optional().describe("Model id or provider model slug, e.g. claude-opus-4-6"),
            provider: z.string().optional().describe("Provider id such as anthropic, openai, cursor, xai, moonshot"),
            harness: z.string().optional().describe("Harness id such as claude, codex, cursor, grok"),
            families: z.array(z.string()).optional(),
            providers: z.array(z.string()).optional(),
            implementationFamily: z.string().optional(),
            dependencies: z.array(z.string()).optional(),
            pathScopes: z.array(z.string()).optional(),
            validationRequirements: z.array(z.object({
                id: z.string().optional(),
                description: z.string(),
                command: z.string().optional(),
                required: z.boolean().optional(),
            })).optional(),
            reviewRequired: z.boolean().optional(),
        },
    }, handler(async (input) => await control.delegate(input)));
    server.registerTool("qagent_message", {
        description: "Send a durable operator message to an agent, optionally scoped to a task.",
        inputSchema: {
            to: z.string(),
            subject: z.string().min(1),
            body: z.string(),
            taskId: z.string().optional(),
        },
    }, handler(async (input) => await control.message(input)));
    server.registerTool("qagent_task", {
        description: "Read one durable task with routing, dependencies, history, submission, validation, and artifacts.",
        inputSchema: { taskId: z.string() },
    }, handler(async ({ taskId }) => await control.task(String(taskId))));
    server.registerTool("qagent_run", {
        description: "Read one durable run and its complete task DAG.",
        inputSchema: { runId: z.string() },
    }, handler(async ({ runId }) => await control.run(String(runId))));
    server.registerTool("qagent_wait", {
        description: "Block efficiently on broker state notifications until a task is submitted/terminal or a run is terminal. This does not busy-poll.",
        inputSchema: {
            taskId: z.string().optional(),
            runId: z.string().optional(),
            timeoutMs: z.number().int().positive().max(240_000).optional(),
        },
    }, handler(async (input) => await control.wait(input)));
    server.registerTool("qagent_review", {
        description: "Accept submitted work or request revision through the normal review state transition.",
        inputSchema: {
            taskId: z.string(),
            decision: z.enum(["accept", "revise"]),
            feedback: z.string().optional(),
        },
    }, handler(async (input) => await control.review(input)));
    server.registerTool("qagent_cancel", {
        description: "Cancel a task or an entire run using the broker's durable cancellation path.",
        inputSchema: {
            taskId: z.string().optional(),
            runId: z.string().optional(),
            reason: z.string().optional(),
        },
    }, handler(async (input) => await control.cancel(input)));
    server.registerTool("qagent_artifacts", {
        description: "Retrieve concise changed-file, validation, and artifact references for a task or all tasks in a run.",
        inputSchema: { taskId: z.string().optional(), runId: z.string().optional() },
    }, handler(async (input) => await control.artifacts(input)));
    server.registerTool("qagent_agent_start", {
        description: "Provision and start one configured agent supervisor for a project using verified process ownership.",
        inputSchema: { agentId: z.string(), projectRoot: z.string() },
    }, handler(async ({ agentId, projectRoot }) => await control.startAgent(String(agentId), String(projectRoot))));
    server.registerTool("qagent_agent_stop", {
        description: "Stop one agent's fingerprint-verified supervisor and harness processes. Arbitrary client-supplied PIDs are never trusted.",
        inputSchema: { agentId: z.string() },
    }, handler(async ({ agentId }) => await control.stopAgent(String(agentId))));
    return server;
}
export async function runOperatorMcpServer() {
    const server = createOperatorMcpServer();
    await server.connect(new StdioServerTransport());
}
//# sourceMappingURL=operator-mcp.js.map