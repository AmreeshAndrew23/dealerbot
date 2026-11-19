import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { persistWebhook, verifyMetaSignature } from "@fmcg/channel";
import type { ServerDeps } from "../server";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * GET  /webhooks/whatsapp  Meta verification handshake.
 * POST /webhooks/whatsapp  Verify signature on raw body, persist + enqueue, then acknowledge.
 *   401 invalid signature; 503 storage failure (Meta retries); 200 stored or duplicate.
 */
export const whatsappWebhookRoutes: FastifyPluginAsync<ServerDeps> = async (app, { config, boss }) => {
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const mode = q["hub.mode"];
    const token = q["hub.verify_token"] ?? "";
    const challenge = q["hub.challenge"] ?? "";
    if (mode === "subscribe" && config.WHATSAPP_VERIFY_TOKEN && safeEqual(token, config.WHATSAPP_VERIFY_TOKEN)) {
      req.log.info("whatsapp webhook verified");
      return reply.type("text/plain").send(challenge);
    }
    req.log.warn("whatsapp webhook verification rejected");
    return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Verification failed", details: {}, request_id: req.id } });
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    const raw = req.rawBody ?? Buffer.alloc(0);
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyMetaSignature(raw, sig, config.WHATSAPP_APP_SECRET)) {
      req.log.warn({ metric: "webhook.signature_failure", has_header: Boolean(sig) }, "invalid webhook signature");
      return reply.status(401).send({ error: { code: "INVALID_SIGNATURE", message: "Signature check failed", details: {}, request_id: req.id } });
    }
    try {
      const result = await persistWebhook(req.body, boss);
      req.log.info({ metric: "webhook.intake", ...result }, "webhook stored");
      return reply.status(200).send("EVENT_RECEIVED");
    } catch (err) {
      req.log.error({ err }, "webhook persistence failed");
      return reply.status(503).send({ error: { code: "DEPENDENCY_UNAVAILABLE", message: "Try again", details: {}, request_id: req.id } });
    }
  });
};
