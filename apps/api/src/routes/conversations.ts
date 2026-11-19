import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withTenantTx, writeAudit, type Tx } from "@fmcg/db";
import { clearAttention, listOrdersForConversation, recordSentReply, type DraftState } from "@fmcg/orders";
import { queueOutbound, isOptedOut, SERVICE_WINDOW_MS, type Boss, type ObjectStorage } from "@fmcg/channel";
import { requireStaff } from "../auth/plugin";
import { ApiError, notFound } from "../lib/errors";
import { idempotent } from "../lib/idempotency";
import { decodeCursor, encodeCursor, parseLimit } from "../lib/pagination";
import { parse } from "../lib/validate";

const IdParams = z.object({ id: z.string().uuid() });

async function conversationDetail(tx: Tx, id: string) {
  const r = await tx.query(
    `SELECT c.id, c.owner_mode, c.assigned_user_id, au.display_name AS assigned_user_name, c.last_inbound_at,
            c.created_at, c.updated_at, ct.id AS contact_id, ct.phone_e164, ct.profile_name, ct.tenant_id,
            rt.shop_name AS retailer_name, ca.display_phone AS channel_phone, ca.provider AS channel,
            c.needs_attention, c.attention_at, c.draft_json
       FROM conversations c
       JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
       JOIN channel_accounts ca ON ca.tenant_id = c.tenant_id AND ca.id = c.channel_account_id
       LEFT JOIN retailers rt ON rt.tenant_id = ct.tenant_id AND rt.phone_e164 = ct.phone_e164
       LEFT JOIN users au ON au.id = c.assigned_user_id
      WHERE c.id = $1`,
    [id],
  );
  const c = r.rows[0];
  if (!c) throw notFound("Conversation");
  const optedOut = await isOptedOut(tx, c.tenant_id, c.contact_id);
  const windowEnds = c.last_inbound_at ? new Date(new Date(c.last_inbound_at).getTime() + SERVICE_WINDOW_MS) : null;
  const windowOpen = windowEnds !== null && windowEnds.getTime() > Date.now();
  // WhatsApp's 24-hour rule does not apply to chats in our own customer app.
  const inApp = c.channel === "app";
  delete c.tenant_id;
  // The retailer's unconfirmed items (what the assistant is holding), so staff can see them on takeover.
  const draft = c.draft_json as DraftState | null;
  delete c.draft_json;
  const pending =
    draft && draft.status !== "CONFIRMED" && draft.lines?.length
      ? { lines: draft.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, base_qty: l.base_qty, base_unit: l.base_unit, amount: l.amount })), status: draft.status }
      : null;
  return {
    ...c,
    draft: pending,
    opted_out: optedOut,
    service_window_ends_at: inApp ? null : windowEnds,
    // What a human may send right now (PRD: show the permitted messaging mode).
    messaging_mode: optedOut ? "NONE" : inApp || windowOpen ? "FREE_FORM" : "TEMPLATE_ONLY",
  };
}

export const conversationRoutes: FastifyPluginAsync<{ boss: Boss; storage: ObjectStorage }> = async (app, { boss, storage }) => {
  app.get("/v1/conversations", async (req) => {
    const s = requireStaff(req, "conversations.view");
    const q = parse(
      z.object({
        limit: z.string().optional(),
        cursor: z.string().optional(),
        owner_mode: z.enum(["BOT", "HUMAN"]).optional(),
        attention: z.enum(["1"]).optional(),
        q: z.string().trim().max(100).optional(),
      }),
      req.query,
    );
    const limit = parseLimit(q.limit, 30);
    const cursor = decodeCursor(q.cursor);
    return withTenantTx(s.tenantId, async (tx) => {
      const r = await tx.query(
        `WITH conv AS (
           SELECT c.id, c.owner_mode, c.assigned_user_id, au.display_name AS assigned_user_name, c.last_inbound_at,
                  ct.phone_e164, ct.profile_name, rt.shop_name AS retailer_name, ca.provider AS channel, last.preview, last.direction AS last_direction,
                  c.needs_attention, c.attention_at,
                  COALESCE(last.at, c.updated_at) AS activity_at
             FROM conversations c
             JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
             JOIN channel_accounts ca ON ca.tenant_id = c.tenant_id AND ca.id = c.channel_account_id
             LEFT JOIN retailers rt ON rt.tenant_id = ct.tenant_id AND rt.phone_e164 = ct.phone_e164
             LEFT JOIN users au ON au.id = c.assigned_user_id
             LEFT JOIN LATERAL (
               SELECT * FROM (
                 (SELECT COALESCE(m.body, '[' || m.type || ']') AS preview, 'inbound' AS direction, m.received_at AS at
                    FROM messages m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
                   ORDER BY m.received_at DESC LIMIT 1)
                 UNION ALL
                 (SELECT COALESCE(o.payload_json->>'text', o.payload_json->>'body', 'Template: ' || (o.payload_json->>'name')),
                         'outbound', o.created_at
                    FROM outbound_messages o WHERE o.tenant_id = c.tenant_id AND o.conversation_id = c.id
                   ORDER BY o.created_at DESC LIMIT 1)
               ) x ORDER BY at DESC LIMIT 1
             ) last ON true
            WHERE ($1::text IS NULL OR c.owner_mode = $1)
              AND ($6::boolean IS NOT TRUE OR c.needs_attention IS NOT NULL)
              AND ($2::text IS NULL OR ct.phone_e164 ILIKE '%' || $2 || '%' OR ct.profile_name ILIKE '%' || $2 || '%' OR rt.shop_name ILIKE '%' || $2 || '%')
         )
         SELECT * FROM conv
          WHERE ($3::timestamptz IS NULL OR (activity_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY activity_at DESC, id DESC
          LIMIT $5`,
        [q.owner_mode ?? null, q.q || null, cursor?.t ?? null, cursor?.id ?? null, limit + 1, q.attention === "1"],
      );
      const rows = r.rows.slice(0, limit);
      const now = Date.now();
      return {
        items: rows.map((c) => ({
          ...c,
          window_open: c.last_inbound_at ? now - new Date(c.last_inbound_at).getTime() < SERVICE_WINDOW_MS : false,
        })),
        next_cursor: r.rows.length > limit ? encodeCursor(rows[rows.length - 1]!.activity_at, rows[rows.length - 1]!.id) : null,
      };
    });
  });

  app.get("/v1/conversations/:id", async (req) => {
    const s = requireStaff(req, "conversations.view");
    const { id } = parse(IdParams, req.params);
    return withTenantTx(s.tenantId, (tx) => conversationDetail(tx, id));
  });

  // The retailer's orders, shown above the chat: placed in this conversation or from the same number.
  app.get("/v1/conversations/:id/orders", async (req) => {
    const s = requireStaff(req, "conversations.view");
    requireStaff(req, "orders.view");
    const { id } = parse(IdParams, req.params);
    return withTenantTx(s.tenantId, async (tx) => {
      const exists = await tx.query(`SELECT 1 FROM conversations WHERE id = $1`, [id]);
      if (!exists.rowCount) throw notFound("Conversation");
      return { orders: await listOrdersForConversation(tx, id) };
    });
  });

  app.get("/v1/conversations/:id/messages", async (req) => {
    const s = requireStaff(req, "conversations.view");
    const { id } = parse(IdParams, req.params);
    const q = parse(z.object({ limit: z.string().optional(), before: z.string().optional() }), req.query);
    const limit = parseLimit(q.limit, 60);
    const before = decodeCursor(q.before);
    return withTenantTx(s.tenantId, async (tx) => {
      const exists = await tx.query(`SELECT 1 FROM conversations WHERE id = $1`, [id]);
      if (!exists.rowCount) throw notFound("Conversation");
      const r = await tx.query(
        `SELECT * FROM (
           SELECT m.id, 'inbound' AS direction, m.type, m.body AS text, COALESCE(m.provider_timestamp, m.received_at) AS at,
                  NULL::text AS status, NULL::text AS policy_result, NULL::text AS policy_reason, NULL::jsonb AS error,
                  NULL::text AS origin, NULL::text AS sent_by_name, m.media_id, ma.mime_type AS media_mime_type,
                  m.media_mime_type AS declared_mime_type, m.review_reason, m.interactive_reply_id
             FROM messages m LEFT JOIN media_assets ma ON ma.tenant_id = m.tenant_id AND ma.id = m.media_id
            WHERE m.conversation_id = $1
           UNION ALL
           SELECT o.id, 'outbound', o.payload_json->>'kind',
                  COALESCE(o.payload_json->>'text', o.payload_json->>'body', 'Template: ' || (o.payload_json->>'name')),
                  o.created_at, o.status, o.policy_result, o.policy_reason, o.error_json, o.origin, u.display_name,
                  NULL, NULL, NULL, NULL, NULL
             FROM outbound_messages o LEFT JOIN users u ON u.id = o.sent_by
            WHERE o.conversation_id = $1
         ) t
         WHERE ($2::timestamptz IS NULL OR (at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY at DESC, id DESC
         LIMIT $4`,
        [id, before?.t ?? null, before?.id ?? null, limit + 1],
      );
      const rows = r.rows.slice(0, limit);
      return {
        items: rows.reverse().map((m) => ({ ...m, media_url: m.media_id ? `/v1/media/${m.media_id}` : null })),
        next_before: r.rows.length > limit ? encodeCursor(rows[0]!.at, rows[0]!.id) : null,
      };
    });
  });

  /** "Done": the flagged request was handled elsewhere (e.g. the order was cancelled on the Orders page). */
  app.post("/v1/conversations/:id/attention/clear", async (req) => {
    const s = requireStaff(req, "conversations.reply");
    const { id } = parse(IdParams, req.params);
    return withTenantTx(s.tenantId, async (tx) => {
      const exists = await tx.query(`SELECT 1 FROM conversations WHERE id = $1`, [id]);
      if (!exists.rowCount) throw notFound("Conversation");
      await clearAttention(tx, s.tenantId, id);
      await writeAudit(tx, { tenant_id: s.tenantId, actor_type: "user", actor_id: s.userId, action: "conversation.attention_cleared", entity_type: "conversation", entity_id: id });
      return conversationDetail(tx, id);
    });
  });

  app.post("/v1/conversations/:id/takeover", async (req) => {
    const s = requireStaff(req, "conversations.reply");
    const { id } = parse(IdParams, req.params);
    return withTenantTx(s.tenantId, async (tx) => {
      const r = await tx.query(
        `UPDATE conversations SET owner_mode = 'HUMAN', assigned_user_id = $2, updated_at = now() WHERE id = $1 RETURNING owner_mode`,
        [id, s.userId],
      );
      if (!r.rowCount) throw notFound("Conversation");
      await writeAudit(tx, { tenant_id: s.tenantId, actor_type: "user", actor_id: s.userId, action: "conversation.takeover", entity_type: "conversation", entity_id: id });
      return conversationDetail(tx, id);
    });
  });

  app.post("/v1/conversations/:id/resume", async (req) => {
    const s = requireStaff(req, "conversations.reply");
    const { id } = parse(IdParams, req.params);
    return withTenantTx(s.tenantId, async (tx) => {
      const r = await tx.query(
        `UPDATE conversations SET owner_mode = 'BOT', assigned_user_id = NULL, updated_at = now() WHERE id = $1 RETURNING owner_mode`,
        [id],
      );
      if (!r.rowCount) throw notFound("Conversation");
      await clearAttention(tx, s.tenantId, id);
      await writeAudit(tx, { tenant_id: s.tenantId, actor_type: "user", actor_id: s.userId, action: "conversation.resume", entity_type: "conversation", entity_id: id });
      return conversationDetail(tx, id);
    });
  });

  app.post("/v1/conversations/:id/messages", async (req, reply) => {
    const s = requireStaff(req, "conversations.reply");
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ text: z.string().trim().min(1).max(4096) }), req.body);
    const res = await withTenantTx(s.tenantId, (tx) =>
      idempotent(
        tx,
        { tenantId: s.tenantId, actorId: s.userId, route: `POST /conversations/${id}/messages`, key: req.headers["idempotency-key"] as string | undefined },
        body,
        async () => {
          const c = (
            await tx.query<{ owner_mode: string; provider: string }>(
              `SELECT c.owner_mode, ca.provider FROM conversations c
                 JOIN channel_accounts ca ON ca.tenant_id = c.tenant_id AND ca.id = c.channel_account_id
                WHERE c.id = $1`,
              [id],
            )
          ).rows[0];
          if (!c) throw notFound("Conversation");
          if (c.owner_mode !== "HUMAN") {
            throw new ApiError(409, "NOT_TAKEN_OVER", "Take over the conversation before replying, so the assistant does not reply at the same time.");
          }
          // Staff answered: whatever the assistant flagged for them is handled.
          await clearAttention(tx, s.tenantId, id);
          if (c.provider === "app") {
            // Customer app chat: the reply is in the retailer's app as soon as it is saved (no WhatsApp, no 24-hour rule).
            const outboundId = await recordSentReply(tx, {
              tenantId: s.tenantId,
              conversationId: id,
              key: `human:${s.userId}:${req.headers["idempotency-key"]}`,
              text: body.text,
              origin: "human",
              sentBy: s.userId,
            });
            if (outboundId) {
              await writeAudit(tx, { tenant_id: s.tenantId, actor_type: "user", actor_id: s.userId, action: "outbound.sent_in_app", entity_type: "outbound_message", entity_id: outboundId });
            }
            return { status: 202, body: { outbound_id: outboundId, status: "sent", policy_reason: "IN_APP" } };
          }
          const out = await queueOutbound(tx, boss, {
            tenantId: s.tenantId,
            conversationId: id,
            dedupeKey: `human:${s.userId}:${req.headers["idempotency-key"]}`,
            origin: "human",
            sentBy: s.userId,
            payload: { kind: "text", text: body.text },
          });
          if (out.decision.result === "DENY") {
            return {
              status: 422,
              body: {
                error: {
                  code: "POLICY_DENIED",
                  message:
                    out.decision.reason === "OUTSIDE_SERVICE_WINDOW"
                      ? "More than 24 hours since the customer's last message. Only an approved template can be sent."
                      : out.decision.reason === "OPTED_OUT"
                        ? "This contact has opted out of messages."
                        : "This message is not allowed right now.",
                  details: { reason: out.decision.reason, outbound_id: out.outboundId },
                  request_id: req.id,
                },
              },
            };
          }
          return { status: 202, body: { outbound_id: out.outboundId, status: "queued", policy_reason: out.decision.reason } };
        },
      ),
    );
    return reply.status(res.status).send(res.body);
  });

  // Authorised media access: the tenant check is the row-level-security lookup of the asset.
  app.get("/v1/media/:id", async (req, reply) => {
    const s = requireStaff(req, "conversations.view");
    const { id } = parse(IdParams, req.params);
    const asset = await withTenantTx(s.tenantId, async (tx) => {
      const r = await tx.query<{ storage_key: string; mime_type: string }>(`SELECT storage_key, mime_type FROM media_assets WHERE id = $1`, [id]);
      return r.rows[0];
    });
    if (!asset) throw notFound("Media");
    const data = await storage.get(asset.storage_key);
    return reply.header("Content-Type", asset.mime_type).header("Cache-Control", "private, max-age=300").send(data);
  });
};
