// Retailers: staff record which WhatsApp numbers belong to which shop. Only Owners/Operators
// (contacts.authorise) may add or change them; numbers are normalised and unique per tenant;
// tenants are isolated (gate 12); orders remember the retailer.
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

describe.skipIf(!enabled)("Retailers (integration)", () => {
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
  const get = (cookie: string, url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const send = (cookie: string, method: "POST" | "PATCH", url: string, payload: object) => app.inject({ method, url, headers: { cookie }, payload });

  async function login(email: string, tenant: string, role: string) {
    const { hashPassword } = await import("../src/auth/password");
    const u = (await q(`INSERT INTO users (auth_subject, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [`local:${email}`, email, email, await hashPassword(PW)]))[0].id;
    await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tenant, u, role]);
    return cookieOf(await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PW } }));
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
    const cat = await import("@fmcg/catalogue");
    for (const name of ["Alpha", "Beta"]) {
      const t = (await q(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [name]))[0].id;
      c[name] = t;
      await db.withTx((tx) => cat.insertProduct(tx, t, cat.ProductInput.parse({ sku: "GD-10", name: "Good Day", pack_units: { BOX: 12 }, mrp: 10, dealer_price: "8.60" })));
    }
    c.ownerA = await login("owner@alpha.test", c.Alpha!, "OWNER");
    c.viewerA = await login("viewer@alpha.test", c.Alpha!, "VIEWER");
    c.ownerB = await login("owner@beta.test", c.Beta!, "OWNER");
  });

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false, wait: true });
    await db?.closePool();
  });

  it("an owner adds a retailer; the number is normalised to +91…", async () => {
    const res = await send(c.ownerA!, "POST", "/v1/retailers", { shop_name: " Murugan Stores ", contact_name: "Murugan anna", phone: "98765 43210", area: "T Nagar" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ shop_name: "Murugan Stores", contact_name: "Murugan anna", phone: "+919876543210", area: "T Nagar", active: true, orders: 0 });
    c.murugan = res.json().id;
  });

  it("refuses a bad number and a number another retailer already uses", async () => {
    expect((await send(c.ownerA!, "POST", "/v1/retailers", { shop_name: "X", phone: "123" })).statusCode).toBe(400);
    const dup = await send(c.ownerA!, "POST", "/v1/retailers", { shop_name: "Other", phone: "+91 98765-43210" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("PHONE_EXISTS");
  });

  it("viewers can see the list but not change it", async () => {
    expect((await get(c.viewerA!, "/v1/retailers")).json().retailers).toHaveLength(1);
    expect((await send(c.viewerA!, "POST", "/v1/retailers", { shop_name: "V", phone: "9000000001" })).statusCode).toBe(403);
    expect((await send(c.viewerA!, "PATCH", `/v1/retailers/${c.murugan}`, { active: false })).statusCode).toBe(403);
  });

  it("another distributor neither sees it nor is blocked by it (same number allowed there)", async () => {
    expect((await get(c.ownerB!, "/v1/retailers")).json().retailers).toEqual([]);
    expect((await send(c.ownerB!, "PATCH", `/v1/retailers/${c.murugan}`, { active: false })).statusCode).toBe(404);
    expect((await send(c.ownerB!, "POST", "/v1/retailers", { shop_name: "Murugan (Beta)", phone: "9876543210" })).statusCode).toBe(201);
  });

  it("deactivating is audited, and the lookup the bot uses respects tenant and status", async () => {
    const res = await send(c.ownerA!, "PATCH", `/v1/retailers/${c.murugan}`, { active: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(false);
    const audit = await q(`SELECT details_json AS details FROM audit_events WHERE action = 'retailer.updated' AND entity_id = $1`, [c.murugan]);
    expect(audit[0].details.changes).toEqual({ active: { from: true, to: false } });
    const found = await db.withTenantTx(c.Alpha!, (tx) => orders.findRetailerByPhone(tx, "919876543210"));
    expect(found).toMatchObject({ id: c.murugan, active: false });
    const none = await db.withTenantTx(c.Alpha!, (tx) => orders.findRetailerByPhone(tx, "+919999999999"));
    expect(none).toBeNull();
  });

  it("an order placed by the retailer is counted on its record", async () => {
    await send(c.ownerA!, "PATCH", `/v1/retailers/${c.murugan}`, { active: true });
    await db.withTx((tx) =>
      orders.createConfirmedOrder(tx, {
        tenantId: c.Alpha!,
        retailerName: "Murugan Stores",
        retailerId: c.murugan,
        contactPhone: "+919876543210",
        channel: "whatsapp_test",
        summaryHash: "h",
        total: "103.20",
        lines: [{ sku: "GD-10", name: "Good Day", unit: "BOX", qty: 1, base_unit: "PCS", base_qty: 12, rate: "8.60", amount: "103.20" }],
        evidence: "yes",
      }),
    );
    const r = (await get(c.ownerA!, "/v1/retailers")).json().retailers[0];
    expect(r.orders).toBe(1);
    expect(r.last_order_at).toBeTruthy();
  });
});
