import { BusConfig, enabledAgents } from "./config.js";

export interface DelegateTargetInput {
  agent?: string;
  exactAgent?: string;
  exactModel?: string;
  provider?: string;
  harness?: string;
  providers?: string[];
  role?: string;
}

export function resolveDelegateTarget(config: BusConfig, input: DelegateTargetInput): {
  exactAgent?: string;
  exactModel?: string;
  providers?: string[];
  harness?: string;
  role?: string;
} {
  const exactAgent = String(input.exactAgent ?? input.agent ?? "").trim();
  const exactModel = String(input.exactModel ?? "").trim();
  const provider = String(input.provider ?? "").trim();
  const harness = String(input.harness ?? "").trim();
  const providers = [
    ...new Set([
      ...(input.providers ?? []).map(String).filter(Boolean),
      ...(provider ? [provider] : []),
    ]),
  ];
  if (exactAgent) {
    if (!config.agents[exactAgent]) throw new Error(`unknown agent "${exactAgent}"`);
    return {
      exactAgent,
      exactModel: exactModel || undefined,
      providers: providers.length ? providers : undefined,
      harness: harness || undefined,
      role: input.role || config.agents[exactAgent].role,
    };
  }

  const agents = enabledAgents(config).filter((agent) => {
    if (providers.length && !providers.includes(agent.modelDefinition.provider)) return false;
    if (harness && agent.harnessDefinition.id !== harness && agent.harnessDefinition.adapter !== harness) return false;
    if (exactModel && exactModel !== agent.modelDefinition.id && exactModel !== agent.modelDefinition.exactModel) return false;
    if (input.role && agent.role !== input.role) return false;
    return true;
  });

  if ((exactModel || providers.length || harness) && agents.length === 1) {
    return {
      exactAgent: agents[0].id,
      exactModel: exactModel || undefined,
      providers: providers.length ? providers : undefined,
      harness: harness || undefined,
      role: input.role || agents[0].role,
    };
  }

  return {
    exactModel: exactModel || undefined,
    providers: providers.length ? providers : undefined,
    harness: harness || undefined,
    role: input.role,
  };
}
