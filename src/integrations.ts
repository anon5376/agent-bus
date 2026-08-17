import { writeFileSync } from "node:fs";
import {
  AgentDefinition,
  BusConfig,
  CapabilityProfile,
  HarnessDefinition,
  ModelDefinition,
  ProviderDefinition,
  loadConfig,
  validateConfig,
} from "./config.js";

export interface IntegrationInput {
  kind?: "command" | "openai-compatible";
  providerId: string;
  providerName?: string;
  authKind?: ProviderDefinition["authKind"];
  authSource?: string;
  subscriptionBacked?: boolean;
  harnessId?: string;
  command?: string;
  args?: string[];
  modelId: string;
  exactModel?: string;
  family?: string;
  agentId?: string;
  role?: string;
  description?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  enabled?: boolean;
  autoStart?: boolean;
  capabilities?: Partial<CapabilityProfile>;
}

function safeId(value: unknown, label: string): string {
  const id = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`${label} must be 1-64 safe characters`);
  }
  return id;
}

function defaultCapabilities(
  source: CapabilityProfile["source"] = "user-configured",
): CapabilityProfile {
  return {
    coding: 0.65,
    reasoning: 0.65,
    planning: 0.60,
    debugging: 0.60,
    research: 0.60,
    toolUse: 0.60,
    speed: 0.60,
    tokenEfficiency: 0.60,
    reliability: 0.60,
    autonomy: 0.60,
    contextTokens: 128_000,
    costClass: "medium",
    source,
    notes: "Default capability placeholders. Adjust these manually; they are not benchmark claims.",
  };
}

function mergeCapabilities(input?: Partial<CapabilityProfile>): CapabilityProfile {
  const base = defaultCapabilities();
  if (!input) return base;
  const out = { ...base, ...input } as CapabilityProfile;
  out.source = input.source ?? "user-configured";
  return out;
}

function featureSet(mcp: boolean): HarnessDefinition["features"] {
  return {
    headless: true,
    resume: false,
    mcp,
    structuredOutput: false,
    streaming: false,
    cancellation: true,
    modelSelection: true,
    reasoningControl: false,
    usageReporting: false,
  };
}

export function addOrUpdateIntegration(
  configPath: string,
  input: IntegrationInput,
): {
  provider: ProviderDefinition;
  harness: HarnessDefinition;
  model: ModelDefinition;
  agent: AgentDefinition;
  config: BusConfig;
} {
  const config = structuredClone(loadConfig(configPath));
  const kind = input.kind ?? "command";
  const providerId = safeId(input.providerId, "providerId");
  const modelId = safeId(input.modelId, "modelId");
  const harnessId = safeId(input.harnessId ?? `${providerId}-${kind}`, "harnessId");
  const agentId = safeId(input.agentId ?? modelId, "agentId");
  const role = String(input.role ?? "implementation");
  if (!config.roles[role]) throw new Error(`unknown role: ${role}`);

  const provider: ProviderDefinition = {
    id: providerId,
    displayName: String(input.providerName ?? providerId),
    authKind: input.authKind ?? (kind === "openai-compatible" ? "api" : "local"),
    authSource: String(input.authSource ?? (kind === "openai-compatible" ? `API key from ${input.apiKeyEnv ?? "OPENAI_API_KEY"}` : "Custom command / local authentication")),
    subscriptionBacked: Boolean(input.subscriptionBacked),
    enabled: input.enabled !== false,
    optional: true,
    notes: "Added through Agent Bus integration editor.",
  };

  const command = kind === "openai-compatible"
    ? "agent-bus-openai-compatible"
    : String(input.command ?? "").trim();
  if (!command) throw new Error("command is required for command integrations");
  const harness: HarnessDefinition = {
    id: harnessId,
    adapter: "command",
    command,
    providers: [providerId],
    enabled: input.enabled !== false,
    probeArgs: kind === "openai-compatible" ? ["--help"] : ["--version"],
    features: featureSet(false),
    notes: kind === "openai-compatible"
      ? "Generic OpenAI-compatible chat-completions endpoint. This is a text model lane, not a coding harness with native MCP tools."
      : "Generic command-template harness. Use a native adapter when deeper tool integration exists.",
  };

  const model: ModelDefinition = {
    id: modelId,
    provider: providerId,
    harness: harnessId,
    family: String(input.family ?? providerId),
    exactModel: input.exactModel ?? modelId,
    enabled: input.enabled !== false,
    capabilities: mergeCapabilities(input.capabilities),
    notes: "User-added model. Capability values are configuration, not measured truth.",
  };

  const args = kind === "openai-compatible"
    ? [
        "--base-url",
        String(input.baseUrl ?? "http://127.0.0.1:1234/v1"),
        "--model",
        "{model}",
        "--prompt",
        "{prompt}",
        "--api-key-env",
        String(input.apiKeyEnv ?? "OPENAI_API_KEY"),
      ]
    : (Array.isArray(input.args) && input.args.length ? input.args.map(String) : ["{prompt}"]);

  const manager = role === "manager";
  const agent: AgentDefinition = {
    id: agentId,
    model: modelId,
    role,
    authority: manager ? "manager" : "worker",
    description: String(input.description ?? `${modelId} via ${harnessId}`),
    enabled: input.enabled !== false,
    autoStart: Boolean(input.autoStart),
    permissions: {
      canDelegate: manager,
      canReview: manager || role === "reviewer",
      filesystem: kind === "openai-compatible" ? "read" : (role === "implementation" || role === "tester" ? "write" : "read"),
      shell: kind !== "openai-compatible",
      network: kind === "openai-compatible" || role === "research",
      maxDelegationDepth: manager ? config.constraints.maxDelegationDepth : 0,
      allowedPaths: ["."],
    },
    harnessOptions: {
      args,
      autoReport: true,
      timeoutMs: 3_600_000,
    },
  };

  config.providers[providerId] = provider;
  config.harnesses[harnessId] = harness;
  config.models[modelId] = model;
  config.agents[agentId] = agent;
  validateConfig(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { provider, harness, model, agent, config };
}
