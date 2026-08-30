import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AgentDefinition,
  BusConfig,
  BusConstraints,
  ProviderDefinition,
  ResolvedAgent,
  resolveAgent,
  validateConfig,
} from "./config.js";

export interface ConfigTransitionConflict {
  agentId: string;
  before: unknown;
  after: unknown;
}

export function configDigest(config: BusConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function executionConfigSnapshot(config: BusConfig, agentId: string): unknown {
  const resolved = resolveAgent(config, agentId);
  return {
    agent: {
      id: resolved.id,
      model: resolved.model,
      role: resolved.role,
      authority: resolved.authority,
      enabled: resolved.enabled,
      permissions: resolved.permissions,
      harnessOptions: resolved.harnessOptions ?? null,
    },
    role: config.roles[resolved.role],
    model: {
      id: resolved.modelDefinition.id,
      provider: resolved.modelDefinition.provider,
      harness: resolved.modelDefinition.harness,
      family: resolved.modelDefinition.family,
      exactModel: resolved.modelDefinition.exactModel ?? null,
      enabled: resolved.modelDefinition.enabled,
      capabilities: resolved.modelDefinition.capabilities,
    },
    provider: {
      id: resolved.providerDefinition.id,
      enabled: resolved.providerDefinition.enabled,
      authKind: resolved.providerDefinition.authKind,
      authSource: resolved.providerDefinition.authSource,
      subscriptionBacked: resolved.providerDefinition.subscriptionBacked,
    },
    harness: {
      id: resolved.harnessDefinition.id,
      adapter: resolved.harnessDefinition.adapter,
      command: resolved.harnessDefinition.command,
      providers: resolved.harnessDefinition.providers,
      enabled: resolved.harnessDefinition.enabled,
      features: resolved.harnessDefinition.features,
      probeArgs: resolved.harnessDefinition.probeArgs ?? [],
      modelDiscovery: resolved.harnessDefinition.modelDiscovery ?? null,
    },
  };
}

export function resolvedExecutionConfig(config: BusConfig, agentId: string): ResolvedAgent {
  return structuredClone(resolveAgent(config, agentId));
}

export function supervisedExecutionConflicts(
  liveConfig: BusConfig,
  candidateConfig: BusConfig,
  supervisedAgentIds: Iterable<string>,
): ConfigTransitionConflict[] {
  const conflicts: ConfigTransitionConflict[] = [];
  for (const agentId of supervisedAgentIds) {
    let before: unknown;
    let after: unknown;
    try { before = executionConfigSnapshot(liveConfig, agentId); }
    catch { before = { missing: true }; }
    try { after = executionConfigSnapshot(candidateConfig, agentId); }
    catch { after = { missing: true }; }
    if (!isDeepStrictEqual(before, after)) conflicts.push({ agentId, before, after });
  }
  return conflicts;
}

function normalizedPermissions(
  value: unknown,
  fallback?: AgentDefinition["permissions"],
): AgentDefinition["permissions"] {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const filesystem = ["none", "read", "write"].includes(String(row.filesystem))
    ? String(row.filesystem) as "none" | "read" | "write"
    : fallback?.filesystem ?? "read";
  return {
    canDelegate: row.canDelegate === undefined ? fallback?.canDelegate ?? false : Boolean(row.canDelegate),
    canReview: row.canReview === undefined ? fallback?.canReview ?? false : Boolean(row.canReview),
    filesystem,
    shell: row.shell === undefined ? fallback?.shell ?? false : Boolean(row.shell),
    network: row.network === undefined ? fallback?.network ?? false : Boolean(row.network),
    maxDelegationDepth: Math.max(0, Number(row.maxDelegationDepth ?? fallback?.maxDelegationDepth ?? 0) || 0),
    allowedPaths: Array.isArray(row.allowedPaths)
      ? row.allowedPaths.map(String).filter(Boolean)
      : fallback?.allowedPaths ?? ["."],
  };
}

export function stageAgentUpdate(baseConfig: BusConfig, body: Record<string, unknown>): {
  agent: AgentDefinition;
  config: BusConfig;
} {
  const config = structuredClone(baseConfig);
  const id = String(body.id ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new Error("agent id must be 1-64 safe characters");
  const existing = config.agents[id];
  const modelId = String(body.model ?? existing?.model ?? "");
  const role = String(body.role ?? existing?.role ?? "");
  if (!config.models[modelId]) throw new Error(`unknown model: ${modelId}`);
  if (!config.roles[role]) throw new Error(`unknown role: ${role}`);
  if (body.modelFamily !== undefined || body.exactModel !== undefined) {
    throw new Error("model definitions are shared; agent edits cannot change model family or exact model");
  }

  const authority = String(body.authority ?? existing?.authority ?? (role === "manager" ? "manager" : "worker"));
  if (authority !== "manager" && authority !== "worker") throw new Error("agent authority must be manager or worker");
  const harnessOptions: Record<string, unknown> = { ...(existing?.harnessOptions ?? {}) };
  if (body.harnessOptions && typeof body.harnessOptions === "object") Object.assign(harnessOptions, body.harnessOptions);
  if (body.reasoning !== undefined) harnessOptions.reasoning = String(body.reasoning);
  if (body.effort !== undefined) harnessOptions.effort = String(body.effort);

  const agent: AgentDefinition = {
    id,
    model: modelId,
    role,
    authority,
    description: String(body.description ?? existing?.description ?? `${role} agent`),
    enabled: body.enabled === undefined ? existing?.enabled ?? true : Boolean(body.enabled),
    autoStart: body.autoStart === undefined ? existing?.autoStart ?? false : Boolean(body.autoStart),
    permissions: normalizedPermissions(body.permissions, existing?.permissions),
    harnessOptions,
  };
  config.agents[id] = agent;
  validateConfig(config);
  return { agent, config };
}

export function stageProviderEnabled(baseConfig: BusConfig, body: Record<string, unknown>): {
  provider: ProviderDefinition;
  config: BusConfig;
} {
  const config = structuredClone(baseConfig);
  const id = String(body.id ?? "").trim();
  const provider = config.providers[id];
  if (!provider) throw new Error(`unknown provider: ${id}`);
  if (body.enabled === undefined) throw new Error("enabled is required");
  provider.enabled = Boolean(body.enabled);
  validateConfig(config);
  return { provider, config };
}

export function stageConstraintsPatch(baseConfig: BusConfig, body: Record<string, unknown>): {
  constraints: BusConstraints;
  config: BusConfig;
} {
  const config = structuredClone(baseConfig);
  const constraints = config.constraints;
  function assign(key: "maxDelegationDepth" | "maxConcurrentTasks" | "maxRetries" | "independentReviewComplexity", min: number): void {
    if (body[key] === undefined) return;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < min) throw new Error(`${key} must be a number >= ${min}`);
    constraints[key] = value;
  }
  assign("maxDelegationDepth", 0);
  assign("maxConcurrentTasks", 1);
  assign("maxRetries", 0);
  assign("independentReviewComplexity", 1);
  if (body.preferSubscription !== undefined) constraints.preferSubscription = Boolean(body.preferSubscription);
  validateConfig(config);
  return { constraints, config };
}
