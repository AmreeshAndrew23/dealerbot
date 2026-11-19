// Orders: a retailer confirmation creates order + version + lines + confirmation in one transaction;
// staff list and read them; versions are append-only; tenants are isolated (gate 12).
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

describe.skipIf(!enabled)("Orders (integration)", () => {
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

  async function login(email: string, tenant: string, role: string) {
    const { hashPassword } = await import("../src/auth/password");
    const u = (await q(`INSERT INTO users (auth_subject, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [`local:${email}`, email, email, await hashPassword(PW)]))[0].id;
    await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tenant, u, role]);
    return cookieOf(await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PW } }));
  }

  const line = (sku: string, qty: number, unit: string, base_qty: number, rate: string, amount: string) => ({ sku, name: sku + " name", unit, qty, base_unit: "PCS", base_qty, rate, amount });

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
      await db.withTx(async (tx) => {
        await cat.insertProduct(tx, t, cat.ProductInput.parse({ sku: "GD-10", name: "Good Day", pack_units: { BOX: 12, CASE: 144 }, mrp: 10, dealer_price: "8.60" }));
        await cat.insertProduct(tx, t, cat.ProductInput.parse({ sku: "BR-10", name: "Bourbon", pack_units: { BOX: 12 }, mrp: 10, dealer_price: "8.60" }));
      });
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

  const confirm = (tenantId: string, shop: string) =>
    db.withTx((tx) =>
      orders.createConfirmedOrder(tx, {
        tenantId,
        retailerName: shop,
        channel: "terminal",
        summaryHash: "h-" + shop,
        total: "2786.40",
        lines: [line("GD-10", 2, "CASE", 288, "8.60", "2476.80"), line("BR-10", 3, "BOX", 36, "8.60", "309.60")],
        evidence: "yes",
      }),
    );

  it("a confirmation creates the order, version 1, its lines and the confirmation, numbered per tenant", async () => {
    const a1 = await confirm(c.Alpha!, "Murugan Stores");
    const a2 = await confirm(c.Alpha!, "Lakshmi Traders");
    const b1 = await confirm(c.Beta!, "Beta Shop");
    expect([a1.order_number, a2.order_number, b1.order_number]).toEqual([1, 2, 1]);
    c.a1 = a1.id;
    const [o] = await q(`SELECT status, current_version FROM orders WHERE id = $1`, [a1.id]);
    expect(o).toEqual({ status: "READY_FOR_REVIEW", current_version: 1 });
    expect(await q(`SELECT count(*)::int AS n FROM confirmations c JOIN order_versions v ON v.id = c.order_version_id WHERE v.order_id = $1`, [a1.id])).toEqual([{ n: 1 }]);
    expect((await q(`SELECT action FROM audit_events WHERE entity_id = $1`, [a1.id])).map((r) => r.action)).toEqual(["order.confirmed_by_retailer"]);
  });

  it("an unknown SKU saves nothing", async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM orders`))[0].n;
    await expect(
      db.withTx((tx) =>
        orders.createConfirmedOrder(tx, { tenantId: c.Alpha!, retailerName: "X", channel: "terminal", summaryHash: "h", total: "1.00", lines: [line("NOPE", 1, "PCS", 1, "1.00", "1.00")], evidence: "yes" }),
      ),
    ).rejects.toThrow(/Unknown SKU/);
    expect((await q(`SELECT count(*)::int AS n FROM orders`))[0].n).toBe(before);
  });

  it("versions, lines and confirmations are append-only", async () => {
    await expect(q(`UPDATE order_lines SET quantity = 99`)).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM order_versions`)).rejects.toThrow(/append-only/);
  });

  it("staff see the queue newest first and the order as a bill", async () => {
    const list = (await get(c.viewerA!, "/v1/orders")).json();
    expect(list.orders.map((o: { order_number: string; retailer_name: string }) => [o.order_number, o.retailer_name])).toEqual([
      ["ORD-000002", "Lakshmi Traders"],
      ["ORD-000001", "Murugan Stores"],
    ]);
    expect(list.orders[0]).toMatchObject({ status: "READY_FOR_REVIEW", total: "2786.40", line_count: 2 });
    const one = (await get(c.viewerA!, `/v1/orders/${c.a1}`)).json();
    expect(one.lines.map((l: { sku_code: string; quantity: string; unit: string; amount: string }) => [l.sku_code, l.quantity, l.unit, l.amount])).toEqual([
      ["GD-10", "2.000", "CASE", "2476.80"],
      ["BR-10", "3.000", "BOX", "309.60"],
    ]);
    expect(one.confirmation).toMatchObject({ channel: "terminal", evidence: "yes" });
    const page = (await get(c.ownerA!, "/v1/orders?limit=1")).json();
    expect(page.orders).toHaveLength(1);
    const next = (await get(c.ownerA!, `/v1/orders?limit=1&cursor=${page.next_cursor}`)).json();
    expect(next.orders[0].order_number).toBe("ORD-000001");
    expect(list.counts).toEqual({ READY_FOR_REVIEW: 2 });
  });

  // ---- review and approval (E12) ----------------------------------------------------------------

  const post = (cookie: string, url: string, payload: unknown, headers: Record<string, string>) =>
    app.inject({ method: "POST", url, payload: payload as object, headers: { cookie, ...headers } });
  const detail = async (id: string) => (await get(c.ownerA!, `/v1/orders/${id}`)).json();
  const approveBody = (d: { current_version: number; summary_hash: string }, acknowledged_warnings: string[] = []) => ({
    version: d.current_version,
    summary_hash: d.summary_hash,
    acknowledged_warnings,
  });

  it("the review shows the checks and what staff may do", async () => {
    const d = await detail(c.a1!);
    expect(d.allowed).toEqual(["approve", "reject", "cancel"]);
    expect(d.checks.map((x: { code: string; severity: string }) => [x.code, x.severity])).toEqual([
      ["RETAILER_NOT_VERIFIED", "warning"],
      ["TALLY_NOT_CONNECTED", "info"],
    ]);
    expect(d.history.map((h: { action: string }) => h.action)).toEqual(["order.confirmed_by_retailer"]);
  });

  it("approve needs If-Match, Idempotency-Key, every warning acknowledged, and the approve permission", async () => {
    const d = await detail(c.a1!);
    const url = `/v1/orders/${c.a1}/approve`;
    expect((await post(c.ownerA!, url, approveBody(d), { "idempotency-key": "k0" })).statusCode).toBe(428);
    expect((await post(c.ownerA!, url, approveBody(d), { "if-match": String(d.lock_version) })).statusCode).toBe(400);
    const noAck = await post(c.ownerA!, url, approveBody(d), { "if-match": String(d.lock_version), "idempotency-key": "k1" });
    expect(noAck.statusCode).toBe(422);
    expect(noAck.json().error.code).toBe("WARNINGS_NOT_ACKNOWLEDGED");
    expect((await post(c.viewerA!, url, approveBody(d, ["RETAILER_NOT_VERIFIED"]), { "if-match": String(d.lock_version), "idempotency-key": "k2" })).statusCode).toBe(403);
    const stale = await post(c.ownerA!, url, approveBody(d, ["RETAILER_NOT_VERIFIED"]), { "if-match": String(d.lock_version + 5), "idempotency-key": "k3" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("ORDER_VERSION_CONFLICT");
  });

  it("gate 2: two people approving at once give one 202 and one 409; a replayed key returns the same answer", async () => {
    const d = await detail(c.a1!);
    const headers = (k: string) => ({ "if-match": String(d.lock_version), "idempotency-key": k });
    const body = approveBody(d, ["RETAILER_NOT_VERIFIED"]);
    const [x, y] = await Promise.all([post(c.ownerA!, `/v1/orders/${c.a1}/approve`, body, headers("p1")), post(c.ownerA!, `/v1/orders/${c.a1}/approve`, body, headers("p2"))]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([202, 409]);
    const ok = x.statusCode === 202 ? x : y;
    expect(ok.json()).toMatchObject({ status: "APPROVED", export_reference: "COP-000001-V1" });
    const again = await post(c.ownerA!, `/v1/orders/${c.a1}/approve`, body, headers(x.statusCode === 202 ? "p1" : "p2"));
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(ok.json());
    expect(await q(`SELECT state, external_reference FROM export_jobs WHERE order_id = $1`, [c.a1])).toEqual([{ state: "QUEUED", external_reference: "COP-000001-V1" }]);
    expect(await q(`SELECT count(*)::int AS n FROM approvals`)).toEqual([{ n: 1 }]);
    const after = await detail(c.a1!);
    expect(after).toMatchObject({ status: "APPROVED", allowed: ["cancel"], export_job: { state: "QUEUED" }, review: { reviewed_by_name: "owner@alpha.test" } });
    expect(after.history.map((h: { action: string }) => h.action)).toEqual(["order.confirmed_by_retailer", "order.approved"]);
  });

  it("gate 6: a price changed after confirmation blocks approval until the retailer confirms again", async () => {
    const orderId = (await q(`SELECT id FROM orders WHERE tenant_id = $1 AND order_number = 2`, [c.Alpha]))[0].id;
    c.a2 = orderId;
    await q(`UPDATE prices SET rate = 8.75 WHERE tenant_id = $1 AND sku_id = (SELECT id FROM skus WHERE tenant_id = $1 AND sku_code = 'BR-10')`, [c.Alpha]);
    const d = await detail(orderId);
    expect(d.checks.find((x: { code: string }) => x.code === "PRICE_CHANGED")).toMatchObject({ severity: "blocker", line_no: 2 });
    const r = await post(c.ownerA!, `/v1/orders/${orderId}/approve`, approveBody(d, ["RETAILER_NOT_VERIFIED"]), { "if-match": String(d.lock_version), "idempotency-key": "g6" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("VALIDATION_FAILED");
    await q(`UPDATE prices SET rate = 8.60 WHERE tenant_id = $1`, [c.Alpha]);
  });

  it("reject needs a reason; an approved order can be cancelled while its export is still queued", async () => {
    let d = await detail(c.a2!);
    expect((await post(c.ownerA!, `/v1/orders/${c.a2}/reject`, { reason: "" }, { "if-match": String(d.lock_version), "idempotency-key": "r0" })).statusCode).toBe(400);
    const rej = await post(c.ownerA!, `/v1/orders/${c.a2}/reject`, { reason: "Out of stock" }, { "if-match": String(d.lock_version), "idempotency-key": "r1" });
    expect(rej.json()).toMatchObject({ status: "REJECTED" });
    d = await detail(c.a2!);
    expect(d).toMatchObject({ allowed: [], review: { status_reason: "Out of stock" } });

    d = await detail(c.a1!);
    const can = await post(c.ownerA!, `/v1/orders/${c.a1}/cancel`, { reason: "Retailer asked to cancel" }, { "if-match": String(d.lock_version), "idempotency-key": "c1" });
    expect(can.json()).toMatchObject({ status: "CANCELLED" });
    expect(await q(`SELECT state FROM export_jobs WHERE order_id = $1`, [c.a1])).toEqual([{ state: "CANCELLED" }]);
    expect((await get(c.ownerA!, "/v1/orders")).json().counts).toEqual({ REJECTED: 1, CANCELLED: 1 });
  });

  it("gate 12: another tenant cannot list or read these orders", async () => {
    const b = (await get(c.ownerB!, "/v1/orders")).json();
    expect(b.orders.map((o: { retailer_name: string }) => o.retailer_name)).toEqual(["Beta Shop"]);
    expect((await get(c.ownerB!, `/v1/orders/${c.a1}`)).statusCode).toBe(404);
  });

  // ---- stock -------------------------------------------------------------------------------------

  const productId = async (sku: string) =>
    (await get(c.ownerA!, "/v1/catalogue/products")).json().products.find((p: { sku: string }) => p.sku === sku);
  const stockOf = async (sku: string) => (await productId(sku)).stock;
  const order2Case = (shop: string) =>
    db.withTx((tx) =>
      orders.createConfirmedOrder(tx, {
        tenantId: c.Alpha!,
        retailerName: shop,
        channel: "terminal",
        summaryHash: "s-" + shop,
        total: "2476.80",
        lines: [line("GD-10", 2, "CASE", 288, "8.60", "2476.80")],
        evidence: "yes",
      }),
    );

  it("staff set and add stock in packs; viewers cannot", async () => {
    const gd = await productId("GD-10");
    expect(gd.stock).toBeNull(); // not tracked yet
    const url = `/v1/catalogue/products/${gd.id}/stock`;
    expect((await post(c.viewerA!, url, { mode: "set", quantity: 1, unit: "CASE" }, {})).statusCode).toBe(403);
    expect((await post(c.ownerA!, url, { mode: "set", quantity: 2, unit: "CASE" }, {})).json().stock).toBe("288.000");
    const added = (await post(c.ownerA!, url, { mode: "add", quantity: 1, unit: "BOX", note: "Invoice 12" }, {})).json();
    expect(added.stock).toBe("300.000");
    expect(added.history.map((h: { kind: string; quantity: string }) => [h.kind, Number(h.quantity)])).toEqual([
      ["RECEIVE", 12],
      ["SET", 288],
    ]);
    expect((await post(c.ownerA!, url, { mode: "set", quantity: 1, unit: "TRAY" }, {})).statusCode).toBe(400);
  });

  it("a confirmed order takes its stock; when there is not enough, nothing is saved", async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM orders`))[0].n;
    const ok = await order2Case("Stock Shop 1");
    c.stockOrder = ok.id;
    expect(await stockOf("GD-10")).toBe("12.000");
    await expect(order2Case("Stock Shop 2")).rejects.toMatchObject({ short: [{ sku: "GD-10", needed: 288, available: 12 }] });
    expect((await q(`SELECT count(*)::int AS n FROM orders`))[0].n).toBe(before + 1);
    expect(await stockOf("GD-10")).toBe("12.000");
  });

  it("two retailers confirming the last stock at the same moment: only one gets it", async () => {
    const gd = await productId("GD-10");
    await post(c.ownerA!, `/v1/catalogue/products/${gd.id}/stock`, { mode: "set", quantity: 2, unit: "CASE" }, {});
    const results = await Promise.allSettled([order2Case("Race A"), order2Case("Race B")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await stockOf("GD-10")).toBe("0.000");
  });

  it("rejecting an order gives its stock back", async () => {
    const d = await detail(c.stockOrder!);
    const r = await post(c.ownerA!, `/v1/orders/${c.stockOrder}/reject`, { reason: "Out of stock" }, { "if-match": String(d.lock_version), "idempotency-key": "st1" });
    expect(r.statusCode).toBe(200);
    expect(await stockOf("GD-10")).toBe("288.000");
    const kinds = (await get(c.ownerA!, `/v1/catalogue/products/${(await productId("GD-10")).id}/stock`)).json().history.map((h: { kind: string }) => h.kind);
    expect(kinds[0]).toBe("RELEASE");
  });

  it("CSV with the older headings still works: stock_pcs sets stock; empty leaves it", async () => {
    const head = "sku_code,name,category,base_unit,pack_units,mrp_per_pcs,dealer_price_per_pcs,aliases,active,stock_pcs\n";
    const csv = head + "GD-10,Good Day,,PCS,BOX=12;CASE=144,10,8.60,,yes,500\nBR-10,Bourbon,,PCS,BOX=12,10,8.60,,yes,\n";
    const preview = (await post(c.ownerA!, "/v1/catalogue/import", { csv, dry_run: true }, {})).json();
    expect(preview.errors ?? preview).toEqual([]);
    expect(preview.items.find((i: { sku: string }) => i.sku === "GD-10").changes.stock).toEqual({ from: 288, to: 500 });
    expect((await post(c.ownerA!, "/v1/catalogue/import", { csv, dry_run: false }, {})).json().applied).toBe(true);
    expect(await stockOf("GD-10")).toBe("500.000");
    expect(await stockOf("BR-10")).toBeNull();
    const exported = (await get(c.ownerA!, "/v1/catalogue/export.csv")).body;
    expect(exported).toContain("Item Code,Item Name,Category,Base Unit,Pack Sizes,MRP,Purchase Rate,Selling Rate,Stock Qty,Stock Unit,Retailer Names,Active");
    expect(exported).toContain("GD-10,Good Day,,PCS,BOX=12;CASE=144,10.00,,8.60,500,PCS,,yes\r\n");
  });

  it("bulk template: download, fill, upload with purchase rate and stock in cases", async () => {
    const t = await get(c.viewerA!, "/v1/catalogue/template.csv");
    expect(t.statusCode).toBe(200);
    expect(t.headers["content-disposition"]).toContain("catalogue-upload-template.csv");
    const filled = t.body + "NEW-1,New Biscuit,Biscuits,PCS,BOX=12;CASE=144,10,7.50,8.50,3,CASE,new;புது,yes\n";
    const preview = (await post(c.ownerA!, "/v1/catalogue/import", { csv: filled, dry_run: true }, {})).json();
    expect(preview.errors).toEqual([]);
    expect(preview.counts).toMatchObject({ create: 1, skipped: 2 });
    expect((await post(c.ownerA!, "/v1/catalogue/import", { csv: filled, dry_run: false }, {})).json().applied).toBe(true);
    expect(await productId("NEW-1")).toMatchObject({ purchase_rate: "7.50", dealer_price: "8.50", stock: "432.000", aliases: ["new", "புது"] });
    expect(await productId("EXAMPLE-1")).toBeUndefined();
    // Changing only the purchase rate is shown as a change, and saved.
    const cheaper = filled.replace("10,7.50,8.50", "10,7.25,8.50");
    const p2 = (await post(c.ownerA!, "/v1/catalogue/import", { csv: cheaper, dry_run: true }, {})).json();
    expect(p2.items.find((i: { sku: string }) => i.sku === "NEW-1").changes).toEqual({ purchase_rate: { from: "7.50", to: "7.25" } });
  });

  it("single item: add with purchase rate and opening stock in one step; edit keeps the stock", async () => {
    const res = await post(c.ownerA!, "/v1/catalogue/products", { sku: "one-1", name: "One", pack_units: { BOX: 10 }, mrp: 5, purchase_rate: "3.80", dealer_price: "4.20", stock_qty: 2, stock_unit: "BOX" }, {});
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sku: "ONE-1", purchase_rate: "3.80", stock: "20.000" });
    const bad = await post(c.ownerA!, "/v1/catalogue/products", { sku: "one-2", name: "Two", pack_units: { BOX: 10 }, mrp: 5, dealer_price: "4.20", stock_qty: 1, stock_unit: "CASE" }, {});
    expect(bad.statusCode).toBe(400);
    expect(await productId("ONE-2")).toBeUndefined(); // nothing half-saved
    const edited = await app.inject({ method: "PATCH", url: `/v1/catalogue/products/${res.json().id}`, payload: { purchase_rate: null }, headers: { cookie: c.ownerA! } });
    expect(edited.json()).toMatchObject({ purchase_rate: null, stock: "20.000" });
  });
});
