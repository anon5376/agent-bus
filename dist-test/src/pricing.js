/**
 * Substring-matched so `claude-opus-4-8`, `anthropic/claude-opus-4.8` and
 * `claude-opus-4-8-20260101` all resolve to the same row. Longest match wins, so
 * a specific entry always beats the family fallback above it.
 */
const TABLE = [
    // Anthropic
    ["claude-opus", { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 }],
    ["claude-sonnet", { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 }],
    ["claude-haiku", { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 }],
    ["claude-3-5-haiku", { inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1 }],
    // OpenAI
    ["gpt-5-codex", { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125 }],
    ["gpt-5-mini", { inputPerMTok: 0.25, outputPerMTok: 2, cacheReadPerMTok: 0.025 }],
    ["gpt-5-nano", { inputPerMTok: 0.05, outputPerMTok: 0.4, cacheReadPerMTok: 0.005 }],
    ["gpt-5", { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125 }],
    ["gpt-4.1-mini", { inputPerMTok: 0.4, outputPerMTok: 1.6, cacheReadPerMTok: 0.1 }],
    ["gpt-4.1", { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 }],
    ["o3", { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 }],
    // Google
    ["gemini-2.5-pro", { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.31 }],
    ["gemini-2.5-flash", { inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.075 }],
    ["gemini-3", { inputPerMTok: 2, outputPerMTok: 12, cacheReadPerMTok: 0.5 }],
    // Open-weight hosts
    ["deepseek", { inputPerMTok: 0.28, outputPerMTok: 0.42, cacheReadPerMTok: 0.028 }],
    ["qwen", { inputPerMTok: 0.4, outputPerMTok: 1.2 }],
    ["kimi", { inputPerMTok: 0.6, outputPerMTok: 2.5 }],
    ["glm", { inputPerMTok: 0.6, outputPerMTok: 2.2 }],
    ["llama", { inputPerMTok: 0.2, outputPerMTok: 0.6 }],
];
/** Models that run on the user's own hardware never cost anything. */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "local", "llamacpp", "vllm"]);
export function lookupPricing(modelName) {
    const needle = modelName.toLowerCase();
    let best = null;
    let bestLength = 0;
    for (const [key, pricing] of TABLE) {
        if (needle.includes(key) && key.length > bestLength) {
            best = pricing;
            bestLength = key.length;
        }
    }
    if (best)
        return { pricing: best, source: "table" };
    // Unknown model: bill it as nothing rather than inventing a rate. The event still
    // records the tokens, so the gap is visible as tokens-without-cost in the summary.
    return { pricing: { inputPerMTok: 0, outputPerMTok: 0 }, source: "unknown" };
}
function rate(pricing, counts) {
    const cacheRead = pricing.cacheReadPerMTok ?? pricing.inputPerMTok * 0.1;
    const cacheWrite = pricing.cacheWritePerMTok ?? pricing.inputPerMTok * 1.25;
    const millions = (n) => Math.max(0, n) / 1_000_000;
    return (millions(counts.inputTokens) * pricing.inputPerMTok +
        millions(counts.outputTokens + counts.reasoningTokens) * pricing.outputPerMTok +
        millions(counts.cacheReadTokens) * cacheRead +
        millions(counts.cacheWriteTokens) * cacheWrite);
}
export function costFor(model, modelName, counts) {
    const configured = model?.pricing;
    const { pricing, source } = configured
        ? { pricing: configured, source: "config" }
        : lookupPricing(model?.exactModel ?? modelName);
    const provider = (model?.provider ?? "").toLowerCase();
    const billing = LOCAL_PROVIDERS.has(provider)
        ? "local"
        : model?.capabilities?.costClass === "subscription"
            ? "subscription"
            : "metered";
    const notionalUSD = billing === "local" ? 0 : round6(rate(pricing, counts));
    return {
        costUSD: billing === "metered" ? notionalUSD : 0,
        notionalUSD,
        pricingSource: source,
        billing,
    };
}
/** Resolve a model id or an exact model name against the configured catalogue. */
export function findModel(config, modelName) {
    if (!modelName)
        return null;
    const direct = config.models?.[modelName];
    if (direct)
        return direct;
    const needle = modelName.toLowerCase();
    for (const model of Object.values(config.models ?? {})) {
        if (model.exactModel && model.exactModel.toLowerCase() === needle)
            return model;
    }
    return null;
}
function round6(value) {
    return Math.round(value * 1e6) / 1e6;
}
