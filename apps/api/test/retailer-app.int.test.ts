// Customer app: a retailer signs in with phone + access code, chats with the assistant, places an
// order, and staff see and take over the same chat on the dashboard. Retailers only reach their own data.
// Runs only when TEST_DATABASE_URL points at a database whose name ends in "_test" (it is wiped).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Extractor } from "@fmcg/orders";

const TEST_DB = process.env.TEST_DATABASE_URL ?? "";
const enabled = /_test(\?.*)?$/.test(TEST_DB);
process.env.DATABASE_URL = TEST_DB || "postgres://unused@localhost/unused";
process.env.WHATSAPP_APP_SECRET = "s";
process.env.WHATSAPP_VERIFY_TOKEN = "v";
process.env.WHATSAPP_ACCESS_TOKEN = "t";
const PW = "correct-horse-battery";

/** Fake model: tests never call the network. */
const extract: Extractor = async (msg) => {
  const base = { language: "en" as const, choice: 0, lines: [], model: "fake", prompt_version: "test" };
  if (msg === "2 box good day") return { ...base, intent: "order", lines: [{ action: "add", product_text: "Good Day", qty_text: "2", unit_text: "box" }] };
  if (msg === "yes") return { ...base, intent: "confirm" };
  if (msg === "hi") return { ...base, intent: "greeting" };
  return { ...base, intent: "other" };
};

describe.skipIf(!enabled)("Customer app (integration)", () => {
  let app: FastifyInstance;
  let db: typeof import("@fmcg/db");
  let boss: import("@fmcg/channel").Boss;
  const c: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => (await db.getPool().query(sql, p)).rows;
  const cookieOf = (res: LightMyRequestResponse, name: string) => {
    const k = res.cookies.find((x) => x.name === name);
    return k ? `${name}=${k.value}` : "";
  };
  const get = (cookie: string, url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const post = (cookie: string, url: string, payload: unknown = {}, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, headers: { cookie, ...headers }, payload: payload as object });
  const say = (cookie: string, text: string, client_id = randomUUID()) => post(cookie, `/v1/app/dealers/${c.tenant}/messages`, { text, client_id });
  const appLogin = (phone: string, code: string) => app.inject({ method: "POST", url: "/v1/app/login", payload: { phone, code } });

  async function staff(email: string, tenant: string, role: string) {
    const { hashPassword } = await import("../src/auth/password");
    const u = (await q(`INSERT INTO users (auth_subject, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [`local:${email}`, email, email, await hashPassword(PW)]))[0].id;
    await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tenant, u, role]);
    return cookieOf(await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PW } }), "fmcg_session");
  }

  beforeAll(async () => {
    db = await import("@fmcg/db");
    const ch = await import("@fmcg/channel");
    const pool = db.getPool();
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;");
    await db.runMigrations(pool);
    boss = await ch.startBoss(TEST_DB, "api");
    const { getConfig } = await import("@fmcg/config");
    const { buildServer } = await import("../src/server");
    app = buildServer({ config: getConfig(), boss, storage: new ch.LocalStorage(process.cwd() + "/storage-test"), secureCookie: false, extract }, { logger: false });
    await app.ready();
    const cat = await import("@fmcg/catalogue");
    c.tenant = (await q(`INSERT INTO tenants (name) VALUES ('Alpha Distributor') RETURNING id`))[0].id;
    await db.withTx((tx) => cat.insertProduct(tx, c.tenant!, cat.ProductInput.parse({ sku: "GD-10", name: "Good Day", pack_units: { BOX: 12, CASE: 144 }, mrp: 10, dealer_price: "8.60" })));
    c.owner = await staff("owner@alpha.test", c.tenant!, "OWNER");
    c.viewer = await staff("viewer@alpha.test", c.tenant!, "VIEWER");
    c.shopA = (await post(c.owner!, "/v1/retailers", { shop_name: "Thangamani Stores", phone: "+1 925 699 0000", contact_name: "Thangamani" })).json().id;
    c.shopB = (await post(c.owner!, "/v1/retailers", { shop_name: "Surya Stores", phone: "98765 43210" })).json().id;
  });

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false, wait: true });
    await db?.closePool();
  });

  it("no access code, no sign-in; only staff who manage retailers can create one", async () => {
    expect((await appLogin("+19256990000", "123456")).statusCode).toBe(401);
    expect((await post(c.viewer!, `/v1/retailers/${c.shopA}/app-code`)).statusCode).toBe(403);
    const res = await post(c.owner!, `/v1/retailers/${c.shopA}/app-code`);
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toMatch(/^\d{6}$/);
    expect(res.json().retailer.app_access).toBe(true);
    c.codeA = res.json().code;
    c.codeB = (await post(c.owner!, `/v1/retailers/${c.shopB}/app-code`)).json().code;
    // The code itself is never stored or listed.
    expect(JSON.stringify((await get(c.owner!, "/v1/retailers")).json())).not.toContain(c.codeA);
    expect((await q(`SELECT app_code_hash FROM retailers WHERE id = $1`, [c.shopA]))[0].app_code_hash).not.toContain(c.codeA);
  });

  it("signs in with phone and code; a wrong code is refused", async () => {
    const wrong = c.codeA === "000000" ? "111111" : "000000";
    expect((await appLogin("+19256990000", wrong)).statusCode).toBe(401);
    const ok = await appLogin("+1 (925) 699-0000", c.codeA!);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ phone: "+19256990000", dealers: [{ id: c.tenant, name: "Alpha Distributor", shop_name: "Thangamani Stores", unread: 0, waiting_orders: 0 }] });
    c.a = cookieOf(ok, "fmcg_retailer");
    c.b = cookieOf(await appLogin("9876543210", c.codeB!), "fmcg_retailer");
    expect((await get(c.a!, "/v1/app/me")).json().dealers.map((d: { shop_name: string }) => d.shop_name)).toEqual(["Thangamani Stores"]);
  });

  it("the two sign-ins are separate: staff cannot use the app routes, a retailer cannot use staff routes", async () => {
    expect((await get(c.owner!, "/v1/app/me")).statusCode).toBe(401);
    for (const url of ["/v1/orders", "/v1/conversations", "/v1/retailers", "/v1/catalogue/products"]) expect((await get(c.a!, url)).statusCode).toBe(401);
    expect((await get("", `/v1/app/dealers/${c.tenant}/messages`)).statusCode).toBe(401);
  });

  it("a chat message is answered by the assistant and stored once, even when retried", async () => {
    const id = randomUUID();
    expect((await say(c.a!, "hi", id)).json()).toMatchObject({ ok: true, replied: true });
    expect((await say(c.a!, "hi", id)).json()).toMatchObject({ ok: true, replied: false });
    const chat = (await get(c.a!, `/v1/app/dealers/${c.tenant}/messages`)).json();
    expect(chat.items.map((m: { from: string }) => m.from)).toEqual(["me", "assistant"]);
    expect(chat.items[0].text).toBe("hi");
    expect(chat.with_staff).toBe(false);
  });

  it("an order placed in the chat is saved for staff review, linked to the retailer and the conversation", async () => {
    for (const text of ["english", "2 box good day", "yes"]) expect((await say(c.a!, text)).statusCode).toBe(200);
    const chat = (await get(c.a!, `/v1/app/dealers/${c.tenant}/messages`)).json();
    const orders = await q(`SELECT id, channel, status, retailer_id, conversation_id, contact_phone FROM orders`);
    expect(orders, chat.items.map((m: { from: string; text: string }) => `${m.from}: ${m.text}`).join("\n---\n")).toHaveLength(1);
    expect(orders[0]).toMatchObject({ channel: "app", status: "READY_FOR_REVIEW", retailer_id: c.shopA, contact_phone: "+19256990000" });
    expect(orders[0].conversation_id).toBeTruthy();
    c.order = orders[0].id;
    c.conv = orders[0].conversation_id;
    expect(chat.items.at(-1).text).toContain("ORD-000001");

    const mine = (await get(c.a!, "/v1/app/orders")).json().orders;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ order_number: "ORD-000001", status: "received", total: "206.40", line_count: 1, dealer: { id: c.tenant, name: "Alpha Distributor" } });
    const detail = (await get(c.a!, `/v1/app/dealers/${c.tenant}/orders/${c.order}`)).json();
    expect(detail.lines).toEqual([{ line_no: 1, sku: "GD-10", name: "Good Day", unit: "BOX", quantity: "2.000", base_unit: "PCS", base_quantity: "24.000", rate: "8.60", amount: "206.40" }]);
    expect(detail.timeline.map((t: { event: string }) => t.event)).toEqual(["placed"]);
  });

  it("a retailer sees only their own chat and orders", async () => {
    expect((await get(c.b!, "/v1/app/orders")).json().orders).toEqual([]);
    expect((await get(c.b!, `/v1/app/dealers/${c.tenant}/orders/${c.order}`)).statusCode).toBe(404);
    expect((await get(c.b!, `/v1/app/dealers/${c.tenant}/messages`)).json().items).toEqual([]);
  });

  it("staff see the app chat with the shop name and its orders, take over, and their reply reaches the app", async () => {
    const list = (await get(c.owner!, "/v1/conversations")).json().items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: c.conv, retailer_name: "Thangamani Stores", channel: "app" });
    expect((await get(c.owner!, `/v1/conversations/${c.conv}/orders`)).json().orders.map((o: { order_number: string }) => o.order_number)).toEqual(["ORD-000001"]);
    const detail = (await get(c.owner!, `/v1/conversations/${c.conv}`)).json();
    expect(detail).toMatchObject({ channel: "app", messaging_mode: "FREE_FORM", service_window_ends_at: null });

    // Even long after the retailer's last message (no WhatsApp 24-hour rule in our own app).
    await q(`UPDATE conversations SET last_inbound_at = now() - interval '3 days' WHERE id = $1`, [c.conv]);
    expect((await post(c.owner!, `/v1/conversations/${c.conv}/takeover`)).statusCode).toBe(200);
    const sent = await post(c.owner!, `/v1/conversations/${c.conv}/messages`, { text: "Delivery tomorrow morning." }, { "idempotency-key": randomUUID() });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().status).toBe("sent");

    // While staff hold the chat the assistant stays silent.
    expect((await say(c.a!, "ok thanks")).json()).toMatchObject({ ok: true, replied: false });
    const chat = (await get(c.a!, `/v1/app/dealers/${c.tenant}/messages`)).json();
    expect(chat.with_staff).toBe(true);
    expect(chat.items.slice(-2).map((m: { from: string; text: string }) => [m.from, m.text])).toEqual([
      ["staff", "Delivery tomorrow morning."],
      ["me", "ok thanks"],
    ]);
    // Opening the chat marked the staff reply as read.
    expect((await q(`SELECT status FROM outbound_messages WHERE origin = 'human'`))[0].status).toBe("read");

    // Handed back: the assistant answers again.
    expect((await post(c.owner!, `/v1/conversations/${c.conv}/resume`)).statusCode).toBe(200);
    expect((await say(c.a!, "hi")).json()).toMatchObject({ ok: true, replied: true });
  });

  it("a decision by staff shows in the retailer's orders", async () => {
    const o = (await get(c.owner!, `/v1/orders/${c.order}`)).json();
    const res = await post(c.owner!, `/v1/orders/${c.order}/reject`, { reason: "Out of stock" }, { "idempotency-key": randomUUID(), "if-match": String(o.lock_version) });
    expect(res.statusCode).toBe(200);
    expect((await get(c.a!, "/v1/app/orders")).json().orders[0]).toMatchObject({ status: "rejected", reason: "Out of stock" });
  });

  it("five wrong codes lock sign-in for that number; a new code signs old phones out; removing access closes the app", async () => {
    const wrong = c.codeB === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await appLogin("9876543210", wrong)).statusCode).toBe(401);
    expect((await appLogin("9876543210", c.codeB!)).statusCode).toBe(429);

    const fresh = (await post(c.owner!, `/v1/retailers/${c.shopB}/app-code`)).json().code;
    expect((await get(c.b!, "/v1/app/me")).statusCode).toBe(401); // old phone signed out
    const again = await appLogin("9876543210", fresh); // a new code also clears the lock
    expect(again.statusCode).toBe(200);
    const b2 = cookieOf(again, "fmcg_retailer");

    expect((await app.inject({ method: "DELETE", url: `/v1/retailers/${c.shopB}/app-code`, headers: { cookie: c.owner! } })).statusCode).toBe(200);
    expect((await get(b2, "/v1/app/me")).statusCode).toBe(401);
    expect((await appLogin("9876543210", fresh)).statusCode).toBe(401);

    // A disconnected shop cannot use the app either.
    await app.inject({ method: "PATCH", url: `/v1/retailers/${c.shopA}`, headers: { cookie: c.owner! }, payload: { active: false } });
    expect((await get(c.a!, "/v1/app/me")).statusCode).toBe(401);
  });
});
