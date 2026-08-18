import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCT_NAME = "agent-bus";
export const PRODUCT_PROTOCOL_VERSION = 2;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function productBuildId(staticRoot = join(MODULE_DIR, "web")): string {
  const hash = createHash("sha256");
  const runtimePath = join(MODULE_DIR, "product-server.js");
  const indexPath = join(staticRoot, "index.html");
  let inputs = 0;
  for (const path of [runtimePath, indexPath]) {
    if (!existsSync(path)) continue;
    hash.update(readFileSync(path));
    inputs += 1;
  }
  if (!inputs) hash.update(`${PRODUCT_NAME}:${PRODUCT_PROTOCOL_VERSION}`);
  return hash.digest("hex").slice(0, 16);
}
