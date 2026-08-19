import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
export function temporaryDirectory(prefix = "agent-bus-test-") {
    return mkdtempSync(join(tmpdir(), prefix));
}
export function testConfig() {
    const config = structuredClone(loadConfig());
    for (const model of Object.values(config.models))
        model.enabled = model.provider === "fake";
    for (const agent of Object.values(config.agents))
        agent.enabled = agent.id.startsWith("fake-");
    for (const provider of Object.values(config.providers))
        provider.enabled = provider.id === "fake";
    for (const harness of Object.values(config.harnesses))
        harness.enabled = harness.id === "fake";
    config.models["fake-small"].family = "fake-small-family";
    config.models["fake-strong"].family = "fake-strong-family";
    config.roles["cheap-worker"].families = ["fake-small-family", "fake-strong-family"];
    config.roles.implementation.families = ["fake-small-family", "fake-strong-family"];
    config.roles.manager.families = ["fake-strong-family"];
    config.roles.planner.families = ["fake-strong-family"];
    config.roles.reviewer.families = ["fake-small-family", "fake-strong-family"];
    config.roles.reviewer.minimumCapability = 0.20;
    config.roles.tester.families = ["fake-small-family", "fake-strong-family"];
    config.roles.research.families = ["fake-small-family", "fake-strong-family"];
    config.constraints.maxConcurrentTasks = 4;
    config.constraints.defaultWriteScopes = ["."];
    return config;
}
export async function post(baseUrl, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) };
}
