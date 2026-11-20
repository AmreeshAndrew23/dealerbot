// Production hosting (Railway): the API also serves the two built web apps from the same address,
// so both sign-in cookies stay same-origin with the /v1 routes (no CORS, no third-party cookies).
//   /shop/...   the customer app (apps/shop/dist, built with base "/shop/")
//   /admin/...  the platform admin app (apps/admin/dist, built with base "/admin/")
//   /...        the staff dashboard (apps/web/dist; unknown paths get index.html for its router)
// /v1, /webhooks and /health are never answered with a page: unknown API paths stay JSON 404s.
// Off in development (Vite serves the apps); turned on with SERVE_STATIC=true.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const API_PREFIXES = ["/v1/", "/v1", "/webhooks", "/health"];

async function fileIn(root: string, rel: string): Promise<string | null> {
  const full = path.resolve(root, "." + path.posix.normalize("/" + rel));
  if (full !== root && !full.startsWith(root + path.sep)) return null; // no escaping the folder
  try {
    return (await stat(full)).isFile() ? full : null;
  } catch {
    return null;
  }
}

async function send(reply: FastifyReply, file: string) {
  const ext = path.extname(file).toLowerCase();
  // Vite puts a content hash in every asset name: those can be cached for good. index.html never.
  const hashed = file.includes(`${path.sep}assets${path.sep}`);
  return reply
    .header("content-type", TYPES[ext] ?? "application/octet-stream")
    .header("cache-control", hashed ? "public, max-age=31536000, immutable" : "no-cache")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY")
    .send(await readFile(file));
}

export function registerStaticSites(app: FastifyInstance, dirs: { web: string; shop: string; admin: string }) {
  const web = path.resolve(dirs.web);
  const notFound = (req: FastifyRequest, reply: FastifyReply) =>
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found.", details: {}, request_id: req.id } });

  // A single-page app under its own folder: a file if there is one, else its index.html.
  const subSite = (prefix: string, dir: string) => {
    const root = path.resolve(dir);
    app.get(prefix, (_req, reply) => reply.redirect(`${prefix}/`, 301));
    app.get(`${prefix}/*`, async (req, reply) => {
      const rel = (req.params as { "*": string })["*"];
      const file = (rel && (await fileIn(root, rel))) || (await fileIn(root, "index.html"));
      return file ? send(reply, file) : notFound(req, reply);
    });
  };
  subSite("/shop", dirs.shop);
  subSite("/admin", dirs.admin);
  app.get("/*", async (req, reply) => {
    const url = req.url.split("?")[0]!;
    if (API_PREFIXES.some((p) => url === p || url.startsWith(p.endsWith("/") ? p : p + "/"))) return notFound(req, reply);
    const rel = (req.params as { "*": string })["*"];
    // A missing asset is a real 404 (not the page), so a stale cached page fails loudly.
    if (rel.startsWith("assets/")) {
      const f = await fileIn(web, rel);
      return f ? send(reply, f) : notFound(req, reply);
    }
    const file = (rel && (await fileIn(web, rel))) || (await fileIn(web, "index.html"));
    return file ? send(reply, file) : notFound(req, reply);
  });
}
