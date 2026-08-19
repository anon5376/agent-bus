import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
export const PRODUCT_NAME = "agent-bus";
export const PRODUCT_PROTOCOL_VERSION = 3;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function filesBelow(root) {
    if (!existsSync(root) || !statSync(root).isDirectory())
        return [];
    const output = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const stat = statSync(path);
            if (stat.isDirectory())
                walk(path);
            else if (stat.isFile())
                output.push(path);
        }
    };
    walk(root);
    return output;
}
function artifactFile(path, root, browserVisible) {
    const body = readFileSync(path);
    const relativePath = relative(root, path).split(sep).join("/");
    return {
        path: relativePath,
        url: browserVisible ? `/${relativePath}` : null,
        size: body.length,
        sha256: sha256(body),
    };
}
function referencedUrls(indexHtml, extension) {
    const matches = [...indexHtml.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((url) => url.startsWith("/") && url.split(/[?#]/, 1)[0].endsWith(extension));
    return [...new Set(matches)];
}
function byUrl(files, url) {
    const pathname = url.split(/[?#]/, 1)[0];
    return files.find((file) => file.url === pathname) ?? null;
}
export function runtimeApplicationRoot() {
    return resolve(MODULE_DIR, "..");
}
export function defaultStaticRoot() {
    return join(runtimeApplicationRoot(), "dist", "web");
}
export function productArtifactManifest(staticRoot = defaultStaticRoot()) {
    const resolvedStaticRoot = resolve(staticRoot);
    const indexPath = join(resolvedStaticRoot, "index.html");
    const staticPaths = filesBelow(resolvedStaticRoot);
    const staticFiles = staticPaths.map((path) => artifactFile(path, resolvedStaticRoot, true));
    const index = existsSync(indexPath) && statSync(indexPath).isFile()
        ? artifactFile(indexPath, resolvedStaticRoot, true)
        : null;
    const indexHtml = index ? readFileSync(indexPath, "utf8") : "";
    const scripts = referencedUrls(indexHtml, ".js").flatMap((url) => {
        const match = byUrl(staticFiles, url);
        return match ? [match] : [];
    });
    const styles = referencedUrls(indexHtml, ".css").flatMap((url) => {
        const match = byUrl(staticFiles, url);
        return match ? [match] : [];
    });
    const runtimePaths = filesBelow(MODULE_DIR)
        .filter((path) => !(path === resolvedStaticRoot || path.startsWith(`${resolvedStaticRoot}${sep}`)));
    const hash = createHash("sha256");
    const hashInputs = [
        ...runtimePaths.map((path) => ({ key: `runtime/${relative(MODULE_DIR, path).split(sep).join("/")}`, path })),
        ...staticPaths.map((path) => ({ key: `web/${relative(resolvedStaticRoot, path).split(sep).join("/")}`, path })),
    ].sort((left, right) => left.key.localeCompare(right.key));
    for (const input of hashInputs) {
        hash.update(input.key);
        hash.update("\0");
        hash.update(readFileSync(input.path));
        hash.update("\0");
    }
    if (!hashInputs.length)
        hash.update(`${PRODUCT_NAME}:${PRODUCT_PROTOCOL_VERSION}`);
    const referencedCount = referencedUrls(indexHtml, ".js").length + referencedUrls(indexHtml, ".css").length;
    return {
        buildId: hash.digest("hex").slice(0, 20),
        moduleRoot: MODULE_DIR,
        staticRoot: resolvedStaticRoot,
        index,
        scripts,
        styles,
        staticFiles,
        uiBuilt: Boolean(index && scripts.length >= 1 && scripts.length + styles.length === referencedCount),
    };
}
export function productBuildId(staticRoot = defaultStaticRoot()) {
    return productArtifactManifest(staticRoot).buildId;
}
//# sourceMappingURL=product-runtime.js.map