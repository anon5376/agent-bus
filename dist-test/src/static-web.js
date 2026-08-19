import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
].join("; ");
function contentType(path) {
    switch (extname(path).toLowerCase()) {
        case ".js":
        case ".mjs": return "text/javascript; charset=utf-8";
        case ".css": return "text/css; charset=utf-8";
        case ".svg": return "image/svg+xml";
        case ".json": return "application/json; charset=utf-8";
        case ".ico": return "image/x-icon";
        case ".png": return "image/png";
        case ".jpg":
        case ".jpeg": return "image/jpeg";
        case ".webp": return "image/webp";
        case ".woff": return "font/woff";
        case ".woff2": return "font/woff2";
        default: return "text/html; charset=utf-8";
    }
}
function isHashedAsset(pathname) {
    return /^\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(pathname);
}
function sendJson(res, status, error) {
    const body = JSON.stringify({ error });
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    res.end(body);
}
function securityHeaders() {
    return {
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "content-security-policy": CSP,
    };
}
export function serveDashboardStatic(req, res, staticRoot, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, "method not allowed");
        return;
    }
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    }
    catch {
        sendJson(res, 400, "malformed path encoding");
        return;
    }
    const root = resolve(staticRoot);
    const requestPath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    let target = resolve(root, requestPath);
    if (target !== root && !target.startsWith(root + sep)) {
        sendJson(res, 404, "not found");
        return;
    }
    const requestedFileExists = existsSync(target) && statSync(target).isFile();
    const isAssetPath = decoded.startsWith("/assets/");
    const hasExtension = extname(decoded) !== "";
    if (!requestedFileExists) {
        if (isAssetPath || hasExtension) {
            sendJson(res, 404, "static asset not found");
            return;
        }
        target = join(root, "index.html");
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
        sendJson(res, 503, "dashboard build missing; run `npm run build`");
        return;
    }
    const body = readFileSync(target);
    const index = target.endsWith(`${sep}index.html`) || target.endsWith("/index.html");
    const cacheControl = index
        ? "no-store, max-age=0"
        : isHashedAsset(decoded)
            ? "public, max-age=31536000, immutable"
            : "no-cache, max-age=0";
    res.writeHead(200, {
        "content-type": contentType(target),
        "content-length": String(body.length),
        "cache-control": cacheControl,
        ...securityHeaders(),
    });
    if (req.method === "HEAD")
        res.end();
    else
        res.end(body);
}
