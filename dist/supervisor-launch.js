import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUS_HOME, BUS_HOST, BUS_PORT, BUS_URL } from "./protocol.js";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = join(ROOT, "cli.js");
export function launchSupervisor(options) {
    const busHome = resolve(options.busHome ?? BUS_HOME);
    const port = options.port ?? BUS_PORT;
    const host = options.host ?? BUS_HOST;
    const url = options.url ?? BUS_URL;
    const applicationRoot = resolve(options.applicationRoot ?? ROOT);
    const projectRoot = resolve(options.projectRoot);
    const configPath = resolve(options.configPath);
    const cliPath = options.cliPath ?? CLI_PATH;
    mkdirSync(join(busHome, "logs"), { recursive: true });
    const log = openSync(join(busHome, "logs", `${options.agentId}.out`), "a");
    const child = spawn(process.execPath, [cliPath, "supervise", options.agentId, projectRoot], {
        detached: true,
        stdio: ["ignore", log, log],
        env: {
            ...process.env,
            AGENT_BUS_HOME: busHome,
            AGENT_BUS_HOST: host,
            AGENT_BUS_PORT: String(port),
            AGENT_BUS_URL: url,
            AGENT_BUS_CONFIG: configPath,
            AGENT_BUS_APPLICATION_ROOT: applicationRoot,
        },
    });
    child.unref();
    return {
        agentId: options.agentId,
        pid: child.pid ?? 0,
        projectRoot,
        configPath,
    };
}
//# sourceMappingURL=supervisor-launch.js.map