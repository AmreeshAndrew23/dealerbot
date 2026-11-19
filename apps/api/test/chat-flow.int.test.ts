// Chat-flow fixes on the dealer side (review of 17 Nov 2026):
//  - approving / rejecting / cancelling tells the retailer, in their language, in the same transaction;
//  - chats where the assistant promised a person are flagged ("Needs reply") and cleared by staff;
//  - the dashboard shows the retailer's unconfirmed items;
//  - numbers that are not connected are listed for staff, and disappear once added.
// Runs only when TEST_DATABASE_URL points at a database whose name ends in "_test" (it is wiped).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const TEST_DB = process.env.TEST_DATABASE_URL ?? "";
const enabled = /_test(\?.*)?$/.test(TEST_DB);
process.env.DATABASE_URL = TEST_DB || "postgres://unused@localhost/unused";
process.env.WHATSAPP_APP_SECRET = "s";
process.env.WHATSAPP_VERIFY_TOKEN = "v";
process.env.WHATSAPP_ACCESS_TOKEN = "t";
const PW = "correct-horse-battery";

describe.skipIf(!enabled)("Chat flow on the dealer side (integration)", () => {
  let app: FastifyInstance;
  let db: typeof import("@fmcg/db");
  let orders: typeof import("@fmcg/orders");
  let boss: import("@fmcg/channel").Boss;
  const c: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => (await db.getPool().query(sql, p)).rows;
  const cookieOf = (res: LightMyRequestResponse) => {
    const k = res.cookies.find((x) => x.name === "fmcg_session");
    return k ? `fmcg_session=${k.value}` : "";
  };
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: c.owner! } });
  const post = (url: string, payload: object = {}, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload, headers: { cookie: c.owner!, ...headers } });

  /** A retailer chat on a direct channel with one confirmed order. */
  async function chatWithOrder(provider: "app" | "whatsapp_test", phone: string, lang: "en" | "ta") {
    return db.withTx(async (tx) => {
      const accountId = await orders.ensureDirectChannel(tx, c.T!, provider, null);
      const rec = await orders.recordInbound(tx, { tenantId: c.T!, accountId, phone, profileName: null, providerMessageId: `${provider}:${phone}:1`, text: "yes", at: new Date() });
      await orders.saveDraft(tx, c.T!, rec.conversationId, { ...orders.newDraft(lang), list_sent: true });
      const o = await orders.createConfirmedOrder(tx, {
        tenantId: c.T!,
        retailerName: "Murugan Stores",
        contactPhone: phone,
        conversationId: rec.conversationId,
        channel: provider,
        summaryHash: "h",
        total: "103.20",
        lines: [{ sku: "GD-10", name: "Good Day", unit: "BOX", qty: 1, base_unit: "PCS", base_qty: 12, rate: "8.60", amount: "103.20" }],
        evidence: "yes",
      });
      return { conversationId: rec.conversationId, orderId: o.id };
    });
  }

  beforeAll(async () => {
    db = await import("@fmcg/db");
    orders = await import("@fmcg/orders");
    const ch = await import("@fmcg/channel");
    const pool = db.getPool();
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;");
    await db.runMigrations(pool);
    boss = await ch.startBoss(TEST_DB, "api");
    const { getConfig } = await import("@fmcg/config");
    const { buildServer } = await import("../src/server");
    app = buildServer({ config: getConfig(), boss, storage: new ch.LocalStorage(process.cwd() + "/storage-test"), secureCookie: false }, { logger: false });
    await app.ready();
    c.T = (await q(`INSERT INTO tenants (name) VALUES ('Britannia Distributor') RETURNING id`))[0].id;
    const cat = await import("@fmcg/catalogue");
    await db.withTx((tx) => cat.insertProduct(tx, c.T!, cat.ProductInput.parse({ sku: "GD-10", name: "Good Day", pack_units: { BOX: 12 }, mrp: 10, dealer_price: "8.60" })));
    const { hashPassword } = await import("../src/auth/password");
    const u = (await q(`INSERT INTO users (auth_subject, email, display_name, password_hash) VALUES ('local:o@t.test','o@t.test','Owner',$1) RETURNING id`, [await hashPassword(PW)]))[0].id;
    await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'OWNER')`, [c.T, u]);
    c.owner = cookieOf(await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "o@t.test", password: PW } }));
  });

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false, wait: true });
    await db?.closePool();
  });

  const decide = async (orderId: string, kind: "approve" | "reject" | "cancel", reason?: string) => {
    const d = (await get(`/v1/orders/${orderId}`)).json();
    const body =
      kind === "approve"
        ? { version: d.current_version, summary_hash: d.summary_hash, acknowledged_warnings: d.checks.filter((x: { severity: string }) => x.severity === "warning").map((x: { code: string }) => x.code) }
        : { reason };
    const r = await post(`/v1/orders/${orderId}/${kind}`, body, { "if-match": String(d.lock_version), "idempotency-key": `${kind}-${orderId}` });
    expect([200, 202]).toContain(r.statusCode);
  };
  const outbound = (conversationId: string) => q(`SELECT origin, status, payload_json->>'text' AS text FROM outbound_messages WHERE conversation_id = $1 ORDER BY created_at`, [conversationId]);

  it("approving tells the retailer in the app at once, in their language", async () => {
    const x = await chatWithOrder("app", "+919800000001", "ta");
    await decide(x.orderId, "approve");
    const out = await outbound(x.conversationId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ origin: "system", status: "sent" });
    expect(out[0].text).toContain("ORD-000001");
    expect(out[0].text).toContain("ஏற்றுக்கொள்ளப்பட்டது");
  });

  it("rejecting queues the message for the WhatsApp bridge, with the reason", async () => {
    const x = await chatWithOrder("whatsapp_test", "+919800000002", "en");
    await decide(x.orderId, "reject", "Out of stock");
    const out = await outbound(x.conversationId);
    expect(out).toEqual([{ origin: "system", status: "queued", text: expect.stringContaining("could not be accepted.\nReason: Out of stock") }]);
    // The bridge picks it up like a staff reply.
    const accountId = await db.withTx((tx) => orders.ensureDirectChannel(tx, c.T!, "whatsapp_test", null));
    const claimed = await db.withTx((tx) => orders.claimStaffReplies(tx, c.T!, accountId));
    expect(claimed.map((r) => r.phone)).toEqual(["+919800000002"]);
  });

  it("cancelling an approved order sends a second, different message", async () => {
    const x = await chatWithOrder("app", "+919800000003", "en");
    await decide(x.orderId, "approve");
    await decide(x.orderId, "cancel", "Cancelled as you asked");
    const texts = (await outbound(x.conversationId)).map((o) => o.text);
    expect(texts[0]).toContain("has been accepted by Britannia Distributor");
    expect(texts[1]).toContain("has been cancelled.\nReason: Cancelled as you asked");
  });

  it("a flagged chat shows as 'Needs reply' and clears when staff reply, hand back, or mark it done", async () => {
    const x = await chatWithOrder("app", "+919800000004", "en");
    await db.withTx((tx) => orders.flagAttention(tx, c.T!, x.conversationId, "question"));
    const list = (await get(`/v1/conversations?attention=1`)).json().items;
    expect(list.map((i: { id: string; needs_attention: string }) => [i.id, i.needs_attention])).toEqual([[x.conversationId, "question"]]);

    await post(`/v1/conversations/${x.conversationId}/takeover`);
    const r = await post(`/v1/conversations/${x.conversationId}/messages`, { text: "Yes, 7 days credit" }, { "idempotency-key": "reply-1" });
    expect(r.statusCode).toBe(202);
    expect((await get(`/v1/conversations/${x.conversationId}`)).json().needs_attention).toBeNull();

    await db.withTx((tx) => orders.flagAttention(tx, c.T!, x.conversationId, "cancel_request"));
    await post(`/v1/conversations/${x.conversationId}/resume`);
    expect((await get(`/v1/conversations/${x.conversationId}`)).json().needs_attention).toBeNull();

    await db.withTx((tx) => orders.flagAttention(tx, c.T!, x.conversationId, "missed_message"));
    const done = await post(`/v1/conversations/${x.conversationId}/attention/clear`);
    expect(done.json().needs_attention).toBeNull();
  });

  it("the conversation shows the retailer's unconfirmed items", async () => {
    const x = await chatWithOrder("app", "+919800000005", "en");
    const line = { sku: "GD-10", name: "Good Day", unit: "BOX", qty: 2, base_unit: "PCS", base_qty: 24, rate: "8.60", amount: "206.40" };
    await db.withTx((tx) => orders.saveDraft(tx, c.T!, x.conversationId, { ...orders.newDraft("en"), status: "AWAITING_RETAILER", lines: [line] }));
    const d = (await get(`/v1/conversations/${x.conversationId}`)).json();
    expect(d.draft).toEqual({ status: "AWAITING_RETAILER", lines: [{ name: "Good Day", qty: 2, unit: "BOX", base_qty: 24, base_unit: "PCS", amount: "206.40" }] });
    expect(d).not.toHaveProperty("draft_json");
  });

  it("numbers that tried to order are listed, and drop off once added as a retailer", async () => {
    for (let i = 0; i < 2; i++) {
      await db.withTx((tx) => orders.recordUnknownSender(tx, { tenantId: c.T!, phone: "+919811111111", profileName: "Selvi", text: "2 box good day", reason: "not_a_retailer" }));
    }
    const s = (await get(`/v1/retailers/unknown-senders`)).json().senders;
    expect(s).toEqual([expect.objectContaining({ phone: "+919811111111", profile_name: "Selvi", last_text: "2 box good day", attempts: 2, reason: "not_a_retailer" })]);
    const add = await post(`/v1/retailers`, { shop_name: "Selvi Stores", phone: "98111 11111" });
    expect(add.statusCode).toBe(201);
    expect((await get(`/v1/retailers/unknown-senders`)).json().senders).toEqual([]);
  });

  it("a retailer's change before acceptance is the next version of the same order, with stock re-reserved", async () => {
    const cat = await import("@fmcg/catalogue");
    const skuId = (await q(`SELECT id FROM skus WHERE tenant_id = $1 AND sku_code = 'GD-10'`, [c.T]))[0].id;
    await db.withTx((tx) => cat.changeStock(tx, c.T!, skuId, { mode: "set", quantity: 100 }, { type: "system", id: null }));
    const x = await chatWithOrder("app", "+919800000006", "en"); // 1 box = 12 pcs reserved
    expect((await q(`SELECT available FROM stock_levels WHERE sku_id = $1`, [skuId]))[0].available).toBe("88.000");
    const before = (await get(`/v1/orders/${x.orderId}`)).json();

    const open = await db.withTx((tx) => orders.openOrderFor(tx, null, "+919800000006"));
    expect(open).toMatchObject({ id: x.orderId, lines: [{ sku: "GD-10", qty: 1, unit: "BOX", base_qty: 12 }] });

    const three = { sku: "GD-10", name: "Good Day", unit: "BOX", qty: 3, base_unit: "PCS", base_qty: 36, rate: "8.60", amount: "309.60" };
    const r = await db.withTx((tx) =>
      orders.amendConfirmedOrder(tx, { tenantId: c.T!, orderId: x.orderId, contactPhone: "+919800000006", channel: "app", summaryHash: "h2", total: "309.60", lines: [three], evidence: "yes" }),
    );
    expect(r.version).toBe(2);
    const after = (await get(`/v1/orders/${x.orderId}`)).json();
    expect(after).toMatchObject({ order_number: before.order_number, current_version: 2, total: "309.60", status: "READY_FOR_REVIEW" });
    expect(after.lines.map((l: { quantity: string }) => l.quantity)).toEqual(["3.000"]);
    expect(after.lock_version).toBe(before.lock_version + 1);
    expect((await q(`SELECT available FROM stock_levels WHERE sku_id = $1`, [skuId]))[0].available).toBe("64.000");
    expect((await q(`SELECT count(*)::int AS n FROM confirmations c JOIN order_versions v ON v.id = c.order_version_id WHERE v.order_id = $1`, [x.orderId]))[0].n).toBe(2);
    expect(after.history.map((h: { action: string }) => h.action)).toContain("order.changed_by_retailer");

    // A reviewer still looking at version 1 cannot approve it.
    const stale = await post(
      `/v1/orders/${x.orderId}/approve`,
      { version: 1, summary_hash: before.summary_hash, acknowledged_warnings: [] },
      { "if-match": String(before.lock_version), "idempotency-key": "stale-approve" },
    );
    expect(stale.statusCode).toBe(409);

    // Once accepted, it can no longer be changed from chat, and is no longer "open".
    await decide(x.orderId, "approve");
    await expect(
      db.withTx((tx) =>
        orders.amendConfirmedOrder(tx, { tenantId: c.T!, orderId: x.orderId, contactPhone: "+919800000006", channel: "app", summaryHash: "h3", total: "103.20", lines: [{ ...three, qty: 1, base_qty: 12, amount: "103.20" }], evidence: "yes" }),
      ),
    ).rejects.toMatchObject({ closed: "APPROVED" });
    expect(await db.withTx((tx) => orders.openOrderFor(tx, null, "+919800000006"))).toBeNull();
    expect((await q(`SELECT available FROM stock_levels WHERE sku_id = $1`, [skuId]))[0].available).toBe("64.000");
  });

  it("another retailer's order cannot be changed", async () => {
    const x = await chatWithOrder("app", "+919800000007", "en");
    const line = { sku: "GD-10", name: "Good Day", unit: "BOX", qty: 2, base_unit: "PCS", base_qty: 24, rate: "8.60", amount: "206.40" };
    await expect(
      db.withTx((tx) => orders.amendConfirmedOrder(tx, { tenantId: c.T!, orderId: x.orderId, contactPhone: "+919899999999", channel: "app", summaryHash: "h", total: "206.40", lines: [line], evidence: "yes" })),
    ).rejects.toThrow("Order not found for this retailer");
  });

  it("a number can be dismissed from the list", async () => {
    await db.withTx((tx) => orders.recordUnknownSender(tx, { tenantId: c.T!, phone: "+919822222222", profileName: null, text: null, reason: "not_a_retailer" }));
    const r = await app.inject({ method: "DELETE", url: `/v1/retailers/unknown-senders/${encodeURIComponent("+919822222222")}`, headers: { cookie: c.owner! } });
    expect(r.statusCode).toBe(200);
    expect((await get(`/v1/retailers/unknown-senders`)).json().senders).toEqual([]);
  });
});
