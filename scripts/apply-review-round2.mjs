#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`${label}: target missing`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`${label}: target ambiguous`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

function replaceRegex(text, pattern, after, label) {
  const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`${label}: expected one match, found ${matches.length}`);
  return text.replace(pattern, after);
}

function update(path, transform) {
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`${path}: no change`);
  writeFileSync(path, after);
}

update("src/config.ts", (source) => replaceOnce(
  source,
  `export function configPathFromProject(projectRoot: string): string {\n  const local = join(projectRoot, ".agent-bus", "config.json");\n  return existsSync(local) ? local : (process.env.AGENT_BUS_CONFIG ?? DEFAULT_CONFIG_PATH);\n}`,
  `export function configPathFromProject(projectRoot: string): string {\n  const explicit = process.env.AGENT_BUS_CONFIG?.trim();\n  if (explicit) return explicit;\n  const local = join(projectRoot, ".agent-bus", "config.json");\n  return existsSync(local) ? local : DEFAULT_CONFIG_PATH;\n}`,
  "explicit config precedence",
));

update("src/integrations.ts", (source) => {
  let text = source;
  text = replaceOnce(text,
    `export function addOrUpdateIntegration(\n  configPath: string,\n  input: IntegrationInput,\n): {`,
    `export function addOrUpdateIntegration(\n  configPath: string,\n  input: IntegrationInput,\n  options: { persist?: boolean } = {},\n): {`,
    "integration preview option",
  );
  text = replaceOnce(text,
    `  validateConfig(config);\n  writeFileSync(configPath, \`${'${JSON.stringify(config, null, 2)}'}\\n\`, "utf8");\n  return { provider, harness, model, agent, config };`,
    `  validateConfig(config);\n  if (options.persist !== false) writeFileSync(configPath, \`${'${JSON.stringify(config, null, 2)}'}\\n\`, "utf8");\n  return { provider, harness, model, agent, config };`,
    "integration conditional persistence",
  );
  return text;
});

update("src/product-server.ts", (source) => {
  let text = source;
  text = replaceOnce(text,
    `import { fileURLToPath } from "node:url";\n`,
    `import { fileURLToPath } from "node:url";\nimport { isDeepStrictEqual } from "node:util";\n`,
    "deep equality import",
  );
  const helper = `function executionConfigSnapshot(config: BusConfig, id: string): unknown {\n  const resolved = resolveAgent(config, id);\n  return {\n    agent: {\n      id: resolved.id,\n      model: resolved.model,\n      role: resolved.role,\n      authority: resolved.authority,\n      enabled: resolved.enabled,\n      permissions: resolved.permissions,\n      harnessOptions: resolved.harnessOptions ?? null,\n    },\n    model: {\n      id: resolved.modelDefinition.id,\n      provider: resolved.modelDefinition.provider,\n      harness: resolved.modelDefinition.harness,\n      family: resolved.modelDefinition.family,\n      exactModel: resolved.modelDefinition.exactModel ?? null,\n      enabled: resolved.modelDefinition.enabled,\n      capabilities: resolved.modelDefinition.capabilities,\n    },\n    provider: {\n      id: resolved.providerDefinition.id,\n      authKind: resolved.providerDefinition.authKind,\n      authSource: resolved.providerDefinition.authSource,\n      subscriptionBacked: resolved.providerDefinition.subscriptionBacked,\n      enabled: resolved.providerDefinition.enabled,\n    },\n    harness: {\n      id: resolved.harnessDefinition.id,\n      adapter: resolved.harnessDefinition.adapter,\n      command: resolved.harnessDefinition.command,\n      providers: resolved.harnessDefinition.providers,\n      enabled: resolved.harnessDefinition.enabled,\n      probeArgs: resolved.harnessDefinition.probeArgs ?? [],\n      modelDiscovery: resolved.harnessDefinition.modelDiscovery ?? null,\n      features: resolved.harnessDefinition.features,\n    },\n  };\n}\n\nfunction supervisedExecutionChanges(service: BrokerService, before: BusConfig, after: BusConfig): string[] {\n  const changed: string[] = [];\n  for (const [id] of service.supervisorMeta) {\n    try {\n      if (!isDeepStrictEqual(executionConfigSnapshot(before, id), executionConfigSnapshot(after, id))) changed.push(id);\n    } catch {\n      changed.push(id);\n    }\n  }\n  return changed;\n}\n\n`;
  text = replaceOnce(text, `function applyConfig(service: BrokerService, config: BusConfig): void {`, `${helper}function applyConfig(service: BrokerService, config: BusConfig): void {`, "execution config guard helper");
  text = replaceOnce(text,
    `async function startAgent(service: BrokerService, operatorTokenPath: string, id: string, requested?: string): Promise<Record<string, unknown>> {\n  const definition = service.config.agents[id];`,
    `async function startAgent(service: BrokerService, operatorTokenPath: string, configPath: string | null, id: string, requested?: string): Promise<Record<string, unknown>> {\n  if (!configPath) throw new Error("agent supervision is unavailable with an in-memory config");\n  const definition = service.config.agents[id];`,
    "supervisor config source parameter",
  );
  text = replaceOnce(text,
    `  const child = spawn(process.execPath, [CLI_PATH, "supervise", id, projectRoot], {\n    detached: true,\n    stdio: ["ignore", log, log],\n  });`,
    `  const child = spawn(process.execPath, [CLI_PATH, "supervise", id, projectRoot], {\n    detached: true,\n    stdio: ["ignore", log, log],\n    env: { ...process.env, AGENT_BUS_CONFIG: configPath },\n  });`,
    "supervisor spawn explicit config",
  );
  text = replaceOnce(text,
    `  if (pathname === "/api/integrations" && req.method === "POST") {\n    if (!configPath) throw new Error("integration editing is unavailable with an in-memory config");\n    const result = addOrUpdateIntegration(configPath, await readJson(req) as unknown as IntegrationInput);\n    applyConfig(service, result.config);`,
    `  if (pathname === "/api/integrations" && req.method === "POST") {\n    if (!configPath) throw new Error("integration editing is unavailable with an in-memory config");\n    const input = await readJson(req) as unknown as IntegrationInput;\n    const beforeConfig = structuredClone(loadConfig(configPath));\n    const result = addOrUpdateIntegration(configPath, input, { persist: false });\n    const affected = supervisedExecutionChanges(service, beforeConfig, result.config);\n    if (affected.length) throw new Error(\`integration update changes supervised agent execution (${ '${affected.join(", ")}' }); stop it before editing configuration\`);\n    writeFileSync(configPath, \`${'${JSON.stringify(result.config, null, 2)}'}\\n\`, "utf8");\n    applyConfig(service, result.config);`,
    "integration supervisor guard",
  );
  text = replaceOnce(text,
    `      return sendJson(res, 200, await startAgent(service, operatorTokenPath, id, body.projectRoot ? String(body.projectRoot) : undefined));`,
    `      return sendJson(res, 200, await startAgent(service, operatorTokenPath, configPath, id, body.projectRoot ? String(body.projectRoot) : undefined));`,
    "dashboard supervisor spawn config",
  );
  return text;
});

update("src/process-management.ts", (source) => {
  let text = source;
  text = replaceOnce(text,
    `  const roots = [String.raw\`\\S*/agent-bus/\`];\n  if (scope.busHome) roots.push(\`${'${escapeRegex(resolve(scope.busHome))}'}/app/(?:current|releases/[^/]+)/\`);\n  else roots.push(String.raw\`\\S*/\\.agent-bus/app/(?:current|releases/[^/]+)/\`);\n  if (scope.applicationRoot) roots.push(\`${'${escapeRegex(resolve(scope.applicationRoot))}'}/\`);`,
    `  const roots: string[] = [];\n  if (scope.busHome) roots.push(\`${'${escapeRegex(resolve(scope.busHome))}'}/app/(?:current|releases/[^/]+)/\`);\n  else if (scope.applicationRoot) roots.push(\`${'${escapeRegex(resolve(scope.applicationRoot))}'}/\`);\n  else {\n    roots.push(String.raw\`\\S*/agent-bus/\`);\n    roots.push(String.raw\`\\S*/\\.agent-bus/app/(?:current|releases/[^/]+)/\`);\n  }`,
    "scoped command roots",
  );
  text = replaceOnce(text,
    `  if (healthBelongsToPid && legacyHealthShape(health) && legacyCatalogFingerprint) {\n    return { pid, command, kind: "agent-bus", reason: "legacy Agent Bus broker fingerprint" };\n  }`,
    `  if (healthBelongsToPid && legacyHealthShape(health) && legacyCatalogFingerprint) {\n    if (scope.busHome && !knownAgentBusCommand(command, scope)) {\n      return { pid, command, kind: "unrelated", reason: "legacy Agent Bus listener cannot be tied to the requested instance" };\n    }\n    return { pid, command, kind: "agent-bus", reason: "legacy Agent Bus broker fingerprint" };\n  }`,
    "legacy scoped ownership",
  );
  text = replaceOnce(text,
    `export async function inspectPort(port: number, url: string, expectedBuildId: string, scope: AgentBusCommandScope = {}): Promise<PortOwner[]> {\n  const pids = listenerPids(port);\n  if (!pids.length) return [];\n  const health = await fetchHealth(url);\n  const legacyFingerprint = legacyHealthShape(health) ? await legacyCatalogFingerprint(url) : false;\n  return pids.map((pid) => classifyPortOwner(pid, processCommand(pid), health, expectedBuildId, legacyFingerprint, scope));\n}`,
    `export async function inspectPort(port: number, url: string, expectedBuildId: string, scope: AgentBusCommandScope = {}): Promise<PortOwner[]> {\n  const pids = listenerPids(port);\n  if (!pids.length) return [];\n  const registered = scope.busHome\n    ? new Set(ownedAgentBusPids({ busHome: scope.busHome, port, includeSupervisors: false }))\n    : new Set<number>();\n  const health = await fetchHealth(url);\n  const legacyFingerprint = legacyHealthShape(health) ? await legacyCatalogFingerprint(url) : false;\n  return pids.map((pid) => registered.has(pid)\n    ? { pid, command: processCommand(pid), kind: "agent-bus" as const, reason: "validated instance process registry" }\n    : classifyPortOwner(pid, processCommand(pid), health, expectedBuildId, legacyFingerprint, scope));\n}`,
    "registry-aware port inspection",
  );
  text = replaceRegex(text, /\nfunction installedServicePids[\s\S]*?\nfunction alive\(pid: number\): boolean \{/, `\nfunction alive(pid: number): boolean {`, "remove global process sweeps");
  text = replaceOnce(text,
    `  const scope: AgentBusCommandScope = { busHome: options.busHome, applicationRoot: options.applicationRoot };\n  const health = await fetchHealth(options.url);\n  const owners = await inspectPort(options.port, options.url, options.expectedBuildId, scope);`,
    `  const scope: AgentBusCommandScope = { busHome: options.busHome, applicationRoot: options.applicationRoot };\n  const owners = await inspectPort(options.port, options.url, options.expectedBuildId, scope);`,
    "remove unused stop health",
  );
  text = replaceOnce(text,
    `  const installedPids = installedServicePids(scope, options.includeSupervisors);\n  const legacySupervisorPids = options.includeSupervisors && !unrelated.length\n    ? await brokerSupervisorPids(options.url, health, scope)\n    : [];\n  const pids = [...safeListenerPids, ...registeredPids, ...installedPids, ...legacySupervisorPids];`,
    `  const pids = [...safeListenerPids, ...registeredPids];`,
    "positive instance PID selection",
  );
  return text;
});

update("install.sh", (source) => {
  let text = source;
  text = replaceOnce(text,
    `STAGE_DIR=""\ntrap 'rm -rf "$TMP_DIR"; [[ -n "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"' EXIT`,
    `STAGE_DIR=""\nCURRENT_LINK_NEXT=""\ntrap 'rm -rf "$TMP_DIR"; [[ -n "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"; [[ -n "$CURRENT_LINK_NEXT" ]] && rm -f "$CURRENT_LINK_NEXT"' EXIT`,
    "atomic link cleanup trap",
  );
  text = replaceOnce(text,
    `rm -f "$APP_ROOT/current.next"\nln -s "$RELEASE_DIR" "$APP_ROOT/current.next"\nrm -f "$APP_ROOT/current"\nmv "$APP_ROOT/current.next" "$APP_ROOT/current"`,
    `CURRENT_LINK_NEXT="$APP_ROOT/.current.next.$$"\nrm -f "$CURRENT_LINK_NEXT"\nln -s "$RELEASE_DIR" "$CURRENT_LINK_NEXT"\n# rename(2) replaces the old symlink atomically on the same filesystem.\n"$FALLBACK_NODE_BIN" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$CURRENT_LINK_NEXT" "$APP_ROOT/current"\nCURRENT_LINK_NEXT=""`,
    "atomic current symlink replacement",
  );
  return text;
});

update("scripts/cli-lifecycle-smoke.mjs", (source) => {
  let text = source;
  text = replaceOnce(text,
    `import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";\n`,
    `import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";\n`,
    "lifecycle mkdir import",
  );
  text = replaceOnce(text,
    `import { join } from "node:path";\n`,
    `import { dirname, join } from "node:path";\n`,
    "lifecycle dirname import",
  );
  text = replaceOnce(text,
    `function startFixtureServer(port, kind) {`,
    `function startFixtureServer(port, kind, scriptPath = null) {`,
    "fixture script path",
  );
  text = replaceOnce(text,
    `  return spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: true });\n}`,
    `  if (scriptPath) {\n    mkdirSync(dirname(scriptPath), { recursive: true });\n    writeFileSync(scriptPath, code);\n    return spawn(process.execPath, [scriptPath], { stdio: "ignore", detached: true });\n  }\n  return spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: true });\n}`,
    "fixture installed command path",
  );
  const instanceBlock = `  const secondPort = await freePort();\n  const secondUrl = \`http://127.0.0.1:${'${secondPort}'}\`;\n  const secondEnv = { ...env, AGENT_BUS_HOME: join(temp, "home-b"), AGENT_BUS_PORT: String(secondPort), AGENT_BUS_URL: secondUrl };\n  const secondInstanceStart = runCli(secondEnv, "start", "--no-open");\n  assert.equal(secondInstanceStart.status, 0, \`second isolated instance failed:\\n${'${secondInstanceStart.stdout}'}\\n${'${secondInstanceStart.stderr}'}\`);\n  const secondInstanceHealth = await waitForHealth(secondUrl, (body) => body.product === "agent-bus");\n\n  const stop = runCli(env, "stop");\n  assert.equal(stop.status, 0, \`stop failed:\\n${'${stop.stdout}'}\\n${'${stop.stderr}'}\`);\n  await waitForDown(url);\n  const secondAfterStop = await waitForHealth(secondUrl, (body) => body.product === "agent-bus");\n  assert.equal(secondAfterStop.pid, secondInstanceHealth.pid, "stopping instance A must not terminate instance B");\n  assert.equal(runCli(secondEnv, "stop").status, 0);\n  await waitForDown(secondUrl);`;
  const replacement = `  const secondPort = await freePort();\n  const secondUrl = \`http://127.0.0.1:${'${secondPort}'}\`;\n  const sameHomeEnv = { ...env, AGENT_BUS_PORT: String(secondPort), AGENT_BUS_URL: secondUrl };\n  const secondInstanceStart = runCli(sameHomeEnv, "start", "--no-open");\n  assert.equal(secondInstanceStart.status, 0, \`same-home second instance failed:\\n${'${secondInstanceStart.stdout}'}\\n${'${secondInstanceStart.stderr}'}\`);\n  const secondInstanceHealth = await waitForHealth(secondUrl, (body) => body.product === "agent-bus");\n\n  const stop = runCli(env, "stop");\n  assert.equal(stop.status, 0, \`stop failed:\\n${'${stop.stdout}'}\\n${'${stop.stderr}'}\`);\n  await waitForDown(url);\n  const secondAfterStop = await waitForHealth(secondUrl, (body) => body.product === "agent-bus");\n  assert.equal(secondAfterStop.pid, secondInstanceHealth.pid, "same-home different-port instance must remain alive");\n  assert.equal(runCli(sameHomeEnv, "stop").status, 0);\n  await waitForDown(secondUrl);\n\n  const unhealthyPairStart = runCli(env, "start", "--no-open");\n  assert.equal(unhealthyPairStart.status, 0, \`unhealthy pair setup failed:\\n${'${unhealthyPairStart.stdout}'}\\n${'${unhealthyPairStart.stderr}'}\`);\n  const unhealthyPairHealth = await waitForHealth(url, (body) => body.product === "agent-bus");\n  const otherPort = await freePort();\n  const otherUrl = \`http://127.0.0.1:${'${otherPort}'}\`;\n  const otherEnv = { ...env, AGENT_BUS_HOME: join(temp, "home-b"), AGENT_BUS_PORT: String(otherPort), AGENT_BUS_URL: otherUrl };\n  const otherStart = runCli(otherEnv, "start", "--no-open");\n  assert.equal(otherStart.status, 0, \`different-home peer failed:\\n${'${otherStart.stdout}'}\\n${'${otherStart.stderr}'}\`);\n  const otherHealth = await waitForHealth(otherUrl, (body) => body.product === "agent-bus");\n  process.kill(unhealthyPairHealth.pid, "SIGSTOP");\n  const unhealthyPairStop = runCli(env, "stop");\n  assert.equal(unhealthyPairStop.status, 0, \`unhealthy scoped stop failed:\\n${'${unhealthyPairStop.stdout}'}\\n${'${unhealthyPairStop.stderr}'}\`);\n  await waitForProcessDown(unhealthyPairHealth.pid);\n  const otherAfter = await waitForHealth(otherUrl, (body) => body.product === "agent-bus");\n  assert.equal(otherAfter.pid, otherHealth.pid, "different-home peer from same checkout must remain alive");\n  assert.equal(runCli(otherEnv, "stop").status, 0);\n  await waitForDown(otherUrl);`;
  text = replaceOnce(text, instanceBlock, replacement, "lifecycle multi-instance cases");
  text = replaceOnce(text,
    `  const legacy = startFixtureServer(port, "legacy");`,
    `  const legacy = startFixtureServer(port, "legacy", join(env.AGENT_BUS_HOME, "app", "releases", "legacy-fixture", "dist", "broker.js"));`,
    "scoped legacy fixture",
  );
  return text;
});

update(".github/workflows/universal-harness-ci.yml", (source) => {
  let text = source;
  text = replaceOnce(text,
    `          cleanup() { agent-bus stop >/dev/null 2>&1 || true; }`,
    `          cleanup() {\n            agent-bus stop >/dev/null 2>&1 || true\n            if [[ -n "${'${alt_port:-}'}" ]]; then AGENT_BUS_PORT="$alt_port" AGENT_BUS_URL="http://127.0.0.1:$alt_port" agent-bus stop >/dev/null 2>&1 || true; fi\n          }`,
    "macOS multi-port cleanup",
  );
  const marker = `          second_pid="$(curl -fsS http://127.0.0.1:7717/health | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).pid')"\n          test "$first_pid" = "$second_pid"\n\n`;
  const insert = `${marker}          # Same home, different ports: stopping the primary must not kill its peer.\n          alt_port="$(python3 - <<'PY'\nimport socket\ns=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()\nPY\n)"\n          alt_url="http://127.0.0.1:$alt_port"\n          AGENT_BUS_PORT="$alt_port" AGENT_BUS_URL="$alt_url" agent-bus start --no-open\n          alt_health="$(curl -fsS "$alt_url/health")"\n          alt_pid="$(printf '%s' "$alt_health" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).pid')"\n          agent-bus stop\n          alt_after="$(curl -fsS "$alt_url/health")"\n          test "$(printf '%s' "$alt_after" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).pid')" = "$alt_pid"\n          AGENT_BUS_PORT="$alt_port" AGENT_BUS_URL="$alt_url" agent-bus stop\n          agent-bus start --no-open\n          health="$(curl -fsS http://127.0.0.1:7717/health)"\n          first_pid="$(printf '%s' "$health" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).pid')"\n\n`;
  text = replaceOnce(text, marker, insert, "installed same-home multi-port regression");
  return text;
});

process.stdout.write("review round2 fixes applied\n");
