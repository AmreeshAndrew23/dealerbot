// Customer app API (apps/shop). A shop signs in with its phone number and the access code a
// distributor (dealer) gave it, and can add more dealers with their codes. For each dealer it can
// chat with the order assistant (or that dealer's staff), browse the dealer's price list and send
// a cart, and follow its orders. Every route below /dealers/:dealer is limited to a dealer this
// phone is linked to (dealerOf) and runs inside that dealer's tenant (row-level security).
//
// Every message runs the same turn as WhatsApp (runRetailerTurn): the model only extracts, code
// matches the Catalogue, prices and writes every reply. A cart from the price list skips the model
// (the products were picked, not typed). The chat is recorded like a WhatsApp chat (provider
// 'app'), so staff read it, take it over and reply on the dashboard Conversations page.
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPool, withTenantTx, withTx, writeAudit } from "@fmcg/db";
import { listProducts } from "@fmcg/catalogue";
import {
  cartMessage,
  ensureDirectChannel,
  getOrder,
  loadDraft,
  newDraft,
  resumeAfterStaff,
  normalisePhone,
  recordInbound,
  recordSentReply,
  runRetailerTurn,
  saveDraft,
  setOwnerMode,
  type Extractor,
} from "@fmcg/orders";
import { verifyPassword } from "../auth/password";
import {
  createRetailerSession,
  dealerOf,
  destroyRetailerSession,
  linkDealer,
  loadAccount,
  requireAccount,
  RETAILER_COOKIE,
  unlinkDealer,
  type RetailerAccount,
  type RetailerSession,
} from "../auth/retailer-sessions";
import { sha256 } from "../auth/sessions";
import { ApiError, notFound } from "../lib/errors";
import { parse } from "../lib/validate";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const SORRY = "Sorry, something went wrong on our side. Please send that again in a minute.\nமன்னிக்கவும், ஒரு பிழை ஏற்பட்டது. சிறிது நேரம் கழித்து மீண்டும் அனுப்பவும்.";
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";

/** What the shop owner is told about an order; the dealer's Tally steps are not their concern. */
function shopStatus(status: string): "received" | "accepted" | "rejected" | "cancelled" {
  if (status === "READY_FOR_REVIEW") return "received";
  if (status === "REJECTED") return "rejected";
  if (status === "CANCELLED" || status === "EXPIRED") return "cancelled";
  return "accepted";
}
const orderNo = (n: number | string) => `ORD-${String(n).padStart(6, "0")}`;

/** One message at a time per retailer and dealer, so quick follow-ups never race each other. */
const lanes = new Map<string, Promise<unknown>>();
function inLane<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (lanes.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => undefined);
  lanes.set(key, tail);
  void tail.then(() => {
    if (lanes.get(key) === tail) lanes.delete(key);
  });
  return next;
}

async function conversationOf(s: RetailerSession): Promise<string | null> {
  return withTenantTx(s.tenantId, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `SELECT c.id FROM conversations c
         JOIN channel_accounts ca ON ca.tenant_id = c.tenant_id AND ca.id = c.channel_account_id AND ca.provider = 'app'
         JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
        WHERE ct.phone_e164 = $1`,
      [s.phone],
    );
    return r.rows[0]?.id ?? null;
  });
}

/** Chat messages the shop sees: its own, the assistant's and staff's (sent ones only). */
const CHAT_ITEMS = `
  SELECT m.id, 'me' AS "from", m.body AS text, COALESCE(m.provider_timestamp, m.received_at) AS at
    FROM messages m WHERE m.conversation_id = $1 AND m.body IS NOT NULL
  UNION ALL
  SELECT o.id, CASE WHEN o.origin = 'human' THEN 'staff' ELSE 'assistant' END, o.payload_json->>'text', o.created_at
    FROM outbound_messages o
   WHERE o.conversation_id = $1 AND o.status IN ('sent','delivered','read') AND o.payload_json->>'text' IS NOT NULL`;

/** A dealer card for the home screen: last message, unread replies, orders waiting. */
async function dealerCard(s: RetailerSession) {
  const conversationId = await conversationOf(s);
  return withTenantTx(s.tenantId, async (tx) => {
    let last: { from: string; text: string; at: string } | null = null;
    let unread = 0;
    let withStaff = false;
    if (conversationId) {
      last = (await tx.query(`SELECT "from", left(text, 140) AS text, at FROM (${CHAT_ITEMS}) t ORDER BY at DESC, id DESC LIMIT 1`, [conversationId])).rows[0] ?? null;
      unread = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_messages WHERE conversation_id = $1 AND status IN ('sent','delivered')`, [conversationId])).rows[0]!.n;
      withStaff = (await tx.query<{ owner_mode: string }>(`SELECT owner_mode FROM conversations WHERE id = $1`, [conversationId])).rows[0]?.owner_mode === "HUMAN";
    }
    const open = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE retailer_id = $1 AND status = 'READY_FOR_REVIEW'`, [s.retailerId])).rows[0]!.n;
    return {
      id: s.tenantId,
      name: s.tenantName,
      shop_name: s.shopName,
      contact_name: s.contactName,
      unread,
      last_message: last,
      waiting_orders: open,
      with_staff: withStaff,
    };
  });
}

async function mePayload(a: RetailerAccount) {
  return { phone: a.phone, dealers: await Promise.all(a.dealers.map(dealerCard)) };
}

/**
 * Checks an access code against this phone's retailer records (optionally only dealers not yet
 * linked). Wrong codes count towards a 15-minute lock per record. System mode: the dealer is only
 * known once the code matches.
 */
async function matchCode(phone: string, code: string, exceptTenants: string[] = []): Promise<{ id: string; tenant_id: string }> {
  const invalid = new ApiError(401, "INVALID_CREDENTIALS", "The phone number or access code is not correct. Ask your distributor for a new code.");
  const rows = (
    await getPool().query<{ id: string; tenant_id: string; app_code_hash: string; locked: boolean }>(
      `SELECT id, tenant_id, app_code_hash, COALESCE(app_locked_until > now(), false) AS locked
         FROM retailers WHERE phone_e164 = $1 AND active AND app_code_hash IS NOT NULL AND NOT (tenant_id = ANY($2::uuid[]))
           AND tenant_id IN (SELECT id FROM tenants WHERE status = 'active') ORDER BY created_at`,
      [phone, exceptTenants],
    )
  ).rows;
  if (rows.length && rows.every((r) => r.locked)) {
    throw new ApiError(429, "RATE_LIMITED", `Too many wrong codes. Try again in ${LOCK_MINUTES} minutes, or ask your distributor for a new code.`);
  }
  // Always run one hash comparison, so timing does not reveal whether the number is registered.
  if (!rows.length) await verifyPassword(code, DUMMY_HASH);
  for (const r of rows) {
    if (!r.locked && (await verifyPassword(code, r.app_code_hash))) {
      await getPool().query(`UPDATE retailers SET app_failed_attempts = 0, app_locked_until = NULL WHERE id = $1`, [r.id]);
      return r;
    }
  }
  await getPool().query(
    `UPDATE retailers
        SET app_failed_attempts = CASE WHEN app_failed_attempts + 1 >= $2 THEN 0 ELSE app_failed_attempts + 1 END,
            app_locked_until = CASE WHEN app_failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE app_locked_until END
      WHERE id = ANY($1)`,
    [rows.filter((r) => !r.locked).map((r) => r.id), MAX_FAILED, LOCK_MINUTES],
  );
  throw invalid;
}

const Code = z.string().trim().min(1).max(20);
const DealerParam = z.object({ dealer: z.string().uuid() });

export const retailerAppRoutes: FastifyPluginAsync<{ secureCookie: boolean; extract?: Extractor }> = async (app, { secureCookie, extract }) => {
  /** The signed-in phone and the dealer named in the URL (404 for any dealer it is not linked to). */
  const dealerFrom = async (req: FastifyRequest) => {
    const a = await requireAccount(req);
    const { dealer } = parse(DealerParam, req.params);
    return { a, s: dealerOf(a, dealer) };
  };

  // ---- sign-in and dealers ----------------------------------------------------------------------

  app.post("/v1/app/login", async (req, reply) => {
    const body = parse(z.object({ phone: z.string().min(1).max(30), code: Code }), req.body);
    const phone = normalisePhone(body.phone);
    if (!phone) throw new ApiError(401, "INVALID_CREDENTIALS", "The phone number or access code is not correct. Ask your distributor for a new code.");
    const match = await matchCode(phone, body.code);
    const tokenHash = await createRetailerSession(match.tenant_id, match.id, req, reply, secureCookie);
    await withTx((tx) =>
      writeAudit(tx, { tenant_id: match.tenant_id, actor_type: "system", actor_id: phone, action: "retailer.app_login", entity_type: "retailer", entity_id: match.id }),
    );
    const a = await loadAccount(tokenHash);
    if (!a) throw new Error("new retailer session not found");
    return mePayload(a);
  });

  /** Adds another dealer with the access code that dealer gave (same phone number). */
  app.post("/v1/app/dealers", async (req) => {
    const a = await requireAccount(req);
    const { code } = parse(z.object({ code: Code }), req.body);
    const match = await matchCode(a.phone, code, a.dealers.map((d) => d.tenantId));
    await linkDealer(a, match.tenant_id, match.id, req);
    await withTx((tx) =>
      writeAudit(tx, { tenant_id: match.tenant_id, actor_type: "system", actor_id: a.phone, action: "retailer.app_login", entity_type: "retailer", entity_id: match.id, details: { added_to_existing_sign_in: true } }),
    );
    const next = await requireAccount(req);
    return { ...(await mePayload(next)), added: match.tenant_id };
  });

  /** Removes a dealer from this phone (the dealer's record of the shop is not touched). */
  app.delete("/v1/app/dealers/:dealer", async (req, reply) => {
    const { a, s } = await dealerFrom(req);
    await unlinkDealer(a, s.tenantId);
    if (a.dealers.length === 1) {
      reply.clearCookie(RETAILER_COOKIE, { path: "/" });
      return { phone: a.phone, dealers: [], signed_out: true };
    }
    return mePayload(await requireAccount(req));
  });

  app.post("/v1/app/logout", async (req, reply) => {
    const token = req.cookies?.[RETAILER_COOKIE];
    if (token) await destroyRetailerSession(sha256(token));
    reply.clearCookie(RETAILER_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/app/me", async (req) => mePayload(await requireAccount(req)));

  // ---- chat with one dealer -------------------------------------------------------------------

  /** The chat, oldest first. Reading it marks the dealer's messages as read. */
  app.get("/v1/app/dealers/:dealer/messages", async (req) => {
    const { s } = await dealerFrom(req);
    const conversationId = await conversationOf(s);
    if (!conversationId) return { items: [], with_staff: false, awaiting_confirmation: false };
    return withTenantTx(s.tenantId, async (tx) => {
      const r = await tx.query(`SELECT * FROM (${CHAT_ITEMS}) t ORDER BY at DESC, id DESC LIMIT 300`, [conversationId]);
      await tx.query(
        `UPDATE outbound_messages SET status = 'read', read_at = now(), updated_at = now()
          WHERE conversation_id = $1 AND status IN ('sent','delivered')`,
        [conversationId],
      );
      const c = await tx.query<{ owner_mode: string; status: string | null }>(`SELECT owner_mode, draft_json->>'status' AS status FROM conversations WHERE id = $1`, [conversationId]);
      const withStaff = c.rows[0]?.owner_mode === "HUMAN";
      // The assistant has shown an order summary and waits for YES (the app shows a YES button).
      return { items: r.rows.reverse(), with_staff: withStaff, awaiting_confirmation: !withStaff && c.rows[0]?.status === "AWAITING_RETAILER" };
    });
  });

  /**
   * One retailer message to one dealer, answered by the assistant (or left for staff). client_id
   * makes a retry safe: the same id is stored and answered once.
   */
  async function chatTurn(req: FastifyRequest, s: RetailerSession, text: string, clientId: string, cart?: (lang: "en" | "ta" | null) => { text: string; extract: Extractor }) {
    return inLane(`${s.tenantId}:${s.retailerId}`, async () => {
      // A cart is written out as the message the shop sees in its chat (in its reply language).
      const conv = await conversationOf(s);
      const before = conv ? await withTx((tx) => loadDraft(tx, s.tenantId, conv)) : null;
      const c = cart?.(before?.lang ?? null);
      const body = c?.text ?? text;
      const rec = await withTx(async (tx) => {
        const accountId = await ensureDirectChannel(tx, s.tenantId, "app", null);
        return recordInbound(tx, { tenantId: s.tenantId, accountId, phone: s.phone, profileName: null, providerMessageId: `app:${clientId}`, text: body, at: new Date() });
      });
      if (rec.duplicate) return { ok: true, replied: false };
      if (rec.ownerMode === "HUMAN") return { ok: true, replied: false }; // staff hold the chat: the assistant stays silent
      const replyKey = `app:${clientId}:reply`;
      try {
        // Staff handed the chat back on the dashboard: the retailer's unconfirmed items are kept.
        const state = resumeAfterStaff((await withTx((tx) => loadDraft(tx, s.tenantId, rec.conversationId))) ?? newDraft());
        const turn = await runRetailerTurn({
          tenant: { id: s.tenantId, name: s.tenantName },
          state,
          text: body,
          shopName: s.shopName,
          retailerName: s.contactName ?? undefined,
          channel: "app",
          contactPhone: s.phone,
          retailerId: s.retailerId,
          conversationId: rec.conversationId,
          extract: c?.extract ?? extract,
        });
        await withTx(async (tx) => {
          await saveDraft(tx, s.tenantId, rec.conversationId, turn.state);
          if (turn.reply !== null) await recordSentReply(tx, { tenantId: s.tenantId, conversationId: rec.conversationId, key: replyKey, text: turn.reply });
          if (turn.state.status === "WITH_STAFF") await setOwnerMode(tx, s.tenantId, rec.conversationId, "HUMAN");
        });
        return { ok: true, replied: turn.reply !== null };
      } catch (err) {
        req.log.error({ err }, "app chat turn failed");
        await withTx((tx) => recordSentReply(tx, { tenantId: s.tenantId, conversationId: rec.conversationId, key: replyKey, text: SORRY, origin: "system" })).catch(() => undefined);
        return { ok: true, replied: true };
      }
    });
  }

  app.post("/v1/app/dealers/:dealer/messages", async (req) => {
    const { s } = await dealerFrom(req);
    const body = parse(z.object({ text: z.string().trim().min(1).max(2000), client_id: z.string().uuid() }), req.body);
    return chatTurn(req, s, body.text, body.client_id);
  });

  /**
   * Items picked on the price list. They go into the chat as one message and the assistant answers
   * with the order summary; the order is placed only when the shop replies YES there.
   */
  app.post("/v1/app/dealers/:dealer/cart", async (req) => {
    const { s } = await dealerFrom(req);
    const body = parse(
      z.object({
        client_id: z.string().uuid(),
        items: z.array(z.object({ sku: z.string().min(1).max(40), unit: z.string().min(1).max(20), qty: z.number().int().positive().max(100_000) })).min(1).max(100),
      }),
      req.body,
    );
    const products = await withTenantTx(s.tenantId, (tx) => listProducts(tx, { activeOnly: true }));
    const probe = cartMessage(body.items, products, null);
    if (!probe.text) throw new ApiError(422, "CART_EMPTY", "These items are no longer in the price list. Please pick them again.");
    const r = await chatTurn(req, s, probe.text, body.client_id, (lang) => cartMessage(body.items, products, lang));
    return { ...r, dropped: probe.dropped };
  });

  // ---- price list ------------------------------------------------------------------------------

  /** The dealer's products and the shop's rates (never the dealer's purchase cost or stock counts). */
  app.get("/v1/app/dealers/:dealer/catalogue", async (req) => {
    const { s } = await dealerFrom(req);
    const products = await withTenantTx(s.tenantId, (tx) => listProducts(tx, { activeOnly: true }));
    const paise = (v: string) => Math.round(Number(v) * 100);
    const items = products.map((p) => ({
      sku: p.sku,
      name: p.name,
      category: p.category || "Other",
      mrp: p.mrp,
      rate: p.dealer_price,
      base_unit: p.base_unit,
      packs: Object.entries(p.pack_units)
        .sort((x, y) => y[1] - x[1])
        .map(([unit, per]) => ({ unit, per, price: (paise(p.dealer_price) * per / 100).toFixed(2) })),
      in_stock: p.stock === null || Number(p.stock) > 0,
    }));
    const updated = products.reduce<Date | null>((t, p) => (!t || p.updated_at > t ? p.updated_at : t), null);
    return { dealer: { id: s.tenantId, name: s.tenantName }, items, updated_at: updated };
  });

  // ---- orders ----------------------------------------------------------------------------------

  async function ordersOf(s: RetailerSession, limit: number) {
    return withTenantTx(s.tenantId, async (tx) => {
      const r = await tx.query(
        `SELECT o.id, o.order_number, o.status, o.status_reason, o.current_version, v.total, o.confirmed_at, o.created_at,
                (SELECT count(*)::int FROM order_lines l WHERE l.order_version_id = v.id) AS line_count
           FROM orders o
           JOIN order_versions v ON v.tenant_id = o.tenant_id AND v.order_id = o.id AND v.version = o.current_version
          WHERE o.retailer_id = $1
          ORDER BY o.created_at DESC, o.id DESC LIMIT $2`,
        [s.retailerId, limit],
      );
      return r.rows.map((o) => ({
        id: o.id,
        dealer: { id: s.tenantId, name: s.tenantName },
        order_number: orderNo(o.order_number),
        status: shopStatus(o.status),
        reason: o.status === "REJECTED" || o.status === "CANCELLED" ? o.status_reason : null,
        total: o.total,
        line_count: o.line_count,
        updated: o.current_version > 1,
        placed_at: o.created_at,
      }));
    });
  }

  app.get("/v1/app/dealers/:dealer/orders", async (req) => {
    const { s } = await dealerFrom(req);
    return { orders: await ordersOf(s, 100) };
  });

  /** Every dealer's orders together, newest first. */
  app.get("/v1/app/orders", async (req) => {
    const a = await requireAccount(req);
    const all = (await Promise.all(a.dealers.map((d) => ordersOf(d, 100)))).flat();
    all.sort((x, y) => +new Date(y.placed_at) - +new Date(x.placed_at));
    return { orders: all.slice(0, 200) };
  });

  app.get("/v1/app/dealers/:dealer/orders/:id", async (req) => {
    const a = await requireAccount(req);
    const { dealer, id } = parse(DealerParam.extend({ id: z.string().uuid() }), req.params);
    const s = dealerOf(a, dealer);
    return withTenantTx(s.tenantId, async (tx) => {
      const own = await tx.query<{ status_reason: string | null; reviewed_at: Date | null; status: string }>(
        `SELECT status, status_reason, reviewed_at FROM orders WHERE id = $1 AND retailer_id = $2`,
        [id, s.retailerId],
      );
      const o = own.rowCount ? await getOrder(tx, id) : null;
      if (!o) throw notFound("Order");
      const versions = await tx.query<{ version: number; created_at: Date; total: string }>(
        `SELECT version, created_at, total FROM order_versions WHERE order_id = $1 ORDER BY version`,
        [id],
      );
      // What happened, as the shop should read it.
      const timeline: Array<{ at: Date; event: "placed" | "changed" | "accepted" | "rejected" | "cancelled"; total?: string }> = versions.rows.map((v) => ({
        at: v.created_at,
        event: v.version === 1 ? "placed" : "changed",
        total: v.total,
      }));
      const st = shopStatus(own.rows[0]!.status);
      if (st !== "received" && own.rows[0]!.reviewed_at) timeline.push({ at: own.rows[0]!.reviewed_at, event: st });
      return {
        id: o.id,
        dealer: { id: s.tenantId, name: s.tenantName },
        order_number: o.order_number,
        status: st,
        reason: o.status === "REJECTED" || o.status === "CANCELLED" ? own.rows[0]!.status_reason : null,
        total: o.total,
        placed_at: o.created_at,
        updated: o.current_version > 1,
        timeline,
        lines: o.lines.map((l) => ({
          line_no: l.line_no,
          sku: l.sku_code,
          name: l.name,
          unit: l.unit,
          quantity: l.quantity,
          base_unit: l.base_unit,
          base_quantity: l.base_quantity,
          rate: l.unit_price,
          amount: l.amount,
        })),
      };
    });
  });
};
