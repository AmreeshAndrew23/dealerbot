// Customer app with several dealers (user request, 19 Nov 2026): one phone, one sign-in, a link per
// dealer proven with that dealer's own access code. Each dealer has its own price list, chat and
// orders, and a dealer can never see or reach another dealer's data through the app.
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
const PHONE = "+919845000001";

/** Fake model. A cart must never reach it (the products were picked, not typed). */
const seen: string[] = [];
const extract: Extractor = async (msg) => {
  seen.push(msg);
  const base = { language: "en" as const, choice: 0, lines: [], model: "fake", prompt_version: "test" };
  if (msg === "yes") return { ...base, intent: "confirm" };
  return { ...base, intent: "other" };
};

describe.skipIf(!enabled)("Customer app with several dealers (integration)", () => {
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
  const del = (cookie: string, url: string) => app.inject({ method: "DELETE", url, headers: { cookie } });

  async function dealer(name: string, products: Array<Record<string, unknown>>) {
    const cat = await import("@fmcg/catalogue");
    const { hashPassword } = await import("../src/auth/password");
    const t = (await q(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [name]))[0].id;
    for (const p of products) await db.withTx((tx) => cat.insertProduct(tx, t, cat.ProductInput.parse(p)));
    const email = `owner@${t}.test`;
    const u = (await q(`INSERT INTO users (auth_subject, email, display_name, password_hash) VALUES ($1,$2,'Owner',$3) RETURNING id`, [`local:${email}`, email, await hashPassword(PW)]))[0].id;
    await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'OWNER')`, [t, u]);
    const owner = cookieOf(await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PW } }), "fmcg_session");
    return { t, owner };
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

    const a = await dealer("Alpha Distributor", [{ sku: "GD-10", name: "Good Day", category: "Biscuits", pack_units: { BOX: 12, CASE: 144 }, mrp: 10, purchase_rate: "7.10", dealer_price: "8.60" }]);
    const b = await dealer("Beta Agencies", [
      { sku: "MG-10", name: "Marie Gold", category: "Biscuits", pack_units: { BOX: 10 }, mrp: 10, dealer_price: "8.20" },
      { sku: "MILK-1", name: "Milk Bikis", category: "Biscuits", pack_units: { BOX: 24 }, mrp: 5, dealer_price: "4.30" },
    ]);
    const z = await dealer("Zeta Traders", [{ sku: "Z-1", name: "Zeta Rusk", pack_units: { BOX: 6 }, mrp: 40, dealer_price: "33.00" }]);
    Object.assign(c, { A: a.t, B: b.t, Z: z.t, ownerA: a.owner, ownerB: b.owner, ownerZ: z.owner });
    // The same shop is a customer of all three dealers; Zeta has not given it app access.
    c.rA = (await post(a.owner, "/v1/retailers", { shop_name: "Murugan Stores", phone: PHONE })).json().id;
    c.rB = (await post(b.owner, "/v1/retailers", { shop_name: "Murugan Stores (Main Rd)", phone: "98450 00001" })).json().id;
    c.rZ = (await post(z.owner, "/v1/retailers", { shop_name: "Murugan", phone: PHONE })).json().id;
    c.codeA = (await post(a.owner, `/v1/retailers/${c.rA}/app-code`)).json().code;
    c.codeB = (await post(b.owner, `/v1/retailers/${c.rB}/app-code`)).json().code;
    // Prime the products' stock counts: Milk Bikis is out of stock at Beta.
    const cat = await import("@fmcg/catalogue");
    const milk = (await q(`SELECT id FROM skus WHERE tenant_id = $1 AND sku_code = 'MILK-1'`, [c.B]))[0].id;
    await db.withTx((tx) => cat.changeStock(tx, c.B!, milk, { mode: "set", quantity: 0 }, { type: "system", id: null }));
  });

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false, wait: true });
    await db?.closePool();
  });

  it("signs in with one dealer's code, then adds another dealer with that dealer's code", async () => {
    const login = await app.inject({ method: "POST", url: "/v1/app/login", payload: { phone: PHONE, code: c.codeA } });
    expect(login.json().dealers.map((d: { name: string }) => d.name)).toEqual(["Alpha Distributor"]);
    c.s = cookieOf(login, "fmcg_retailer");

    // A's code again, or a made-up one, adds nothing.
    expect((await post(c.s!, "/v1/app/dealers", { code: c.codeA })).statusCode).toBe(401);
    const add = await post(c.s!, "/v1/app/dealers", { code: c.codeB });
    expect(add.statusCode).toBe(200);
    expect(add.json().added).toBe(c.B);
    const me = (await get(c.s!, "/v1/app/me")).json();
    expect(me.dealers.map((d: { name: string; shop_name: string }) => [d.name, d.shop_name])).toEqual([
      ["Alpha Distributor", "Murugan Stores"],
      ["Beta Agencies", "Murugan Stores (Main Rd)"],
    ]);
    // Zeta knows the number but gave no code: it is not listed, and its data cannot be reached.
    expect(JSON.stringify(me)).not.toContain("Zeta");
    for (const url of [`/v1/app/dealers/${c.Z}/catalogue`, `/v1/app/dealers/${c.Z}/messages`, `/v1/app/dealers/${c.Z}/orders`]) expect((await get(c.s!, url)).statusCode).toBe(404);
  });

  it("each dealer shows its own price list with the shop's rates, never the dealer's cost", async () => {
    const a = (await get(c.s!, `/v1/app/dealers/${c.A}/catalogue`)).json();
    expect(a.items).toEqual([
      {
        sku: "GD-10",
        name: "Good Day",
        category: "Biscuits",
        mrp: "10.00",
        rate: "8.60",
        base_unit: "PCS",
        packs: [
          { unit: "CASE", per: 144, price: "1238.40" },
          { unit: "BOX", per: 12, price: "103.20" },
          { unit: "PCS", per: 1, price: "8.60" },
        ],
        in_stock: true,
      },
    ]);
    expect(JSON.stringify(a)).not.toContain("7.10");
    const b = (await get(c.s!, `/v1/app/dealers/${c.B}/catalogue`)).json();
    expect(b.items.map((i: { name: string; in_stock: boolean }) => [i.name, i.in_stock])).toEqual([
      ["Marie Gold", true],
      ["Milk Bikis", false],
    ]);
    expect(JSON.stringify(b)).not.toContain("Good Day");
  });

  it("a cart from the price list becomes a chat message and an order summary, without the model", async () => {
    // Choose English first, so the cart is answered at once.
    await post(c.s!, `/v1/app/dealers/${c.B}/messages`, { text: "english", client_id: randomUUID() });
    seen.length = 0;
    const id = randomUUID();
    const r = await post(c.s!, `/v1/app/dealers/${c.B}/cart`, { client_id: id, items: [{ sku: "MG-10", unit: "BOX", qty: 3 }, { sku: "GONE-1", unit: "BOX", qty: 1 }] });
    expect(r.json()).toMatchObject({ ok: true, replied: true, dropped: ["GONE-1"] });
    expect(seen).toEqual([]);
    // A retry with the same id is not a second message.
    expect((await post(c.s!, `/v1/app/dealers/${c.B}/cart`, { client_id: id, items: [{ sku: "MG-10", unit: "BOX", qty: 3 }] })).json().replied).toBe(false);
    const chat = (await get(c.s!, `/v1/app/dealers/${c.B}/messages`)).json().items;
    expect(chat.at(-2)).toMatchObject({ from: "me", text: "3 box Marie Gold" });
    expect(chat.at(-1).text).toContain("Marie Gold");
    expect(chat.at(-1).text).toContain("₹246.00");
    expect(chat.at(-1).text).toContain("Reply *YES*");
    expect(await q(`SELECT 1 FROM orders`)).toHaveLength(0); // nothing is ordered before YES

    await post(c.s!, `/v1/app/dealers/${c.B}/messages`, { text: "yes", client_id: randomUUID() });
    const orders = await q(`SELECT tenant_id, retailer_id, channel FROM orders`);
    expect(orders).toEqual([{ tenant_id: c.B, retailer_id: c.rB, channel: "app" }]);
    // Alpha's chat is separate and untouched.
    expect((await get(c.s!, `/v1/app/dealers/${c.A}/messages`)).json().items).toEqual([]);
  });

  it("the home screen shows unread replies per dealer, and 'all orders' spans dealers", async () => {
    const conv = (await q(`SELECT conversation_id FROM orders WHERE tenant_id = $1`, [c.B]))[0].conversation_id;
    // The order confirmation is unread until the chat is opened.
    expect((await get(c.s!, "/v1/app/me")).json().dealers.find((d: { id: string }) => d.id === c.B).unread).toBe(1);
    await get(c.s!, `/v1/app/dealers/${c.B}/messages`);
    await post(c.ownerB!, `/v1/conversations/${conv}/takeover`);
    await post(c.ownerB!, `/v1/conversations/${conv}/messages`, { text: "Thank you, delivery on Friday." }, { "idempotency-key": randomUUID() });
    const me = (await get(c.s!, "/v1/app/me")).json();
    const beta = me.dealers.find((d: { id: string }) => d.id === c.B);
    expect(beta).toMatchObject({ unread: 1, waiting_orders: 1, with_staff: true, last_message: { from: "staff", text: "Thank you, delivery on Friday." } });
    expect(me.dealers.find((d: { id: string }) => d.id === c.A)).toMatchObject({ unread: 0, waiting_orders: 0, last_message: null });
    await get(c.s!, `/v1/app/dealers/${c.B}/messages`); // opening the chat reads it
    expect((await get(c.s!, "/v1/app/me")).json().dealers.find((d: { id: string }) => d.id === c.B).unread).toBe(0);

    const all = (await get(c.s!, "/v1/app/orders")).json().orders;
    expect(all.map((o: { dealer: { name: string }; status: string }) => [o.dealer.name, o.status])).toEqual([["Beta Agencies", "received"]]);
    // An order id only opens under its own dealer.
    expect((await get(c.s!, `/v1/app/dealers/${c.A}/orders/${all[0].id}`)).statusCode).toBe(404);
    expect((await get(c.s!, `/v1/app/dealers/${c.B}/orders/${all[0].id}`)).json()).toMatchObject({ order_number: "ORD-000001", total: "246.00", dealer: { name: "Beta Agencies" } });
  });

  it("a new code at one dealer drops only that dealer from the phone; removing the last dealer signs out", async () => {
    await post(c.ownerA!, `/v1/retailers/${c.rA}/app-code`);
    const me = (await get(c.s!, "/v1/app/me")).json();
    expect(me.dealers.map((d: { name: string }) => d.name)).toEqual(["Beta Agencies"]);
    expect((await get(c.s!, `/v1/app/dealers/${c.A}/catalogue`)).statusCode).toBe(404);

    const gone = await del(c.s!, `/v1/app/dealers/${c.B}`);
    expect(gone.json()).toMatchObject({ dealers: [], signed_out: true });
    expect((await get(c.s!, "/v1/app/me")).statusCode).toBe(401);
    // The dealer's record of the shop is untouched.
    expect((await q(`SELECT active, app_code_hash IS NOT NULL AS access FROM retailers WHERE id = $1`, [c.rB]))[0]).toEqual({ active: true, access: true });
  });
});
