import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "@fmcg/config";
import type { Boss, ObjectStorage } from "@fmcg/channel";
import { getPool } from "@fmcg/db";
import { whatsappWebhookRoutes } from "./routes/whatsapp-webhook";
import { authPlugin } from "./auth/plugin";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/users";
import { conversationRoutes } from "./routes/conversations";
import { catalogueRoutes } from "./routes/catalogue";
import { orderRoutes } from "./routes/orders";
import { retailerRoutes } from "./routes/retailers";
import { retailerAppRoutes } from "./routes/retailer-app";
import { adminRoutes } from "./routes/admin";
import type { Extractor } from "@fmcg/orders";
import { ApiError } from "./lib/errors";
import { registerStaticSites } from "./static-sites";
import { repoRoot } from "@fmcg/config";
import path from "node:path";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface ServerDeps {
  config: AppConfig;
  boss: Boss;
  storage: ObjectStorage;
  /** Secure cookies require HTTPS; false only for local development over http. */
  secureCookie?: boolean;
  /** Order extraction for the customer app chat; tests pass a fake so nothing calls the network. */
  extract?: Extractor;
}

export function buildServer(deps: ServerDeps, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: deps.config.LOG_LEVEL,
            redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-hub-signature-256"]'],
          },
    genReqId: () => `req_${randomUUID()}`,
    trustProxy: deps.config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  // Keep the exact bytes: webhook signatures are computed over the raw body.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (buf.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(buf.toString("utf8")));
    } catch {
      const err = new Error("Malformed JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // PRD error envelope for anything that escapes a route.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details, request_id: req.id } });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    const code =
      status === 400 ? "MALFORMED_REQUEST" : status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : status === 503 ? "DEPENDENCY_UNAVAILABLE" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
    reply.status(status).send({
      error: { code, message: status >= 500 ? "Something went wrong." : err.message, details: {}, request_id: req.id },
    });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found.", details: {}, request_id: req.id } });
  });

  app.register(cookie);
  app.register(authPlugin);
  app.register(authRoutes, { secureCookie: deps.secureCookie ?? true });
  app.register(userRoutes);
  app.register(conversationRoutes, { boss: deps.boss, storage: deps.storage });
  app.register(catalogueRoutes);
  app.register(orderRoutes);
  app.register(retailerRoutes, { appUrl: deps.config.RETAILER_APP_URL });
  app.register(retailerAppRoutes, { secureCookie: deps.secureCookie ?? true, extract: deps.extract });
  app.register(adminRoutes, { secureCookie: deps.secureCookie ?? true });

  app.get("/health", async (_req, reply) => {
    try {
      await getPool().query("SELECT 1");
      return { status: "ok" };
    } catch {
      return reply.status(503).send({ status: "db_unavailable" });
    }
  });

  app.register(whatsappWebhookRoutes, deps);
  if (deps.config.SERVE_STATIC) {
    registerStaticSites(app, {
      web: path.join(repoRoot, "apps/web/dist"),
      shop: path.join(repoRoot, "apps/shop/dist"),
      admin: path.join(repoRoot, "apps/admin/dist"),
    });
  }
  return app;
}
