// Catalogue API: add, edit, hide, CSV preview/import/export, roles and tenant isolation (gate 12).
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
const HEAD = "sku_code,name,category,base_unit,pack_units,mrp_per_pcs,dealer_price_per_pcs,aliases\n";
const GOOD_DAY = { sku: "gd-10", name: "Good Day Rs10", category: "Biscuits", pack_units: { BOX: 12, CASE: 144 }, mrp: "10", dealer_price: "8.60", aliases: ["gudday", "குட் டே"] };

describe.skipIf(!enabled)("Catalogue API (integration)", () => {
  let app: FastifyInstance;
  let db: typeof import("@fmcg/db");
  let boss: import("@fmcg/channel").Boss;
  const c: Record<string, string> = {};

  const q = async (sql: string, p: unknown[] = []) => (await db.getPool().query(sql, p)).rows;
  const cookieOf = (res: LightMyRequestResponse) => {
    const k = res.cookies.find((x) => x.name === "fmcg_session");
    return k ? `fmcg_session=${k.value}` : "";
  };
  const as = (cookie: string) => ({
    get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
    post: (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object, headers: { cookie } }),
    patch: (url: string, payload: unknown) => app.inject({ method: "PATCH", url, payload: payload as object, headers: { cookie } }),
  });

  async function user(email: string, tenant: string, role: string) {
    const { hashPassword } = await import("../src/auth/password");
    const u = (await q(`INSERT INTO users (auth_subject, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [`local:${email}`, email, email, await hashPassword(PW)]))[0].id;
    await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tenant, u, role]);
    const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PW } });
    return cookieOf(res);
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
    app = buildServer({ config: getConfig(), boss, storage: new ch.LocalStorage(process.cwd() + "/storage-test"), secureCookie: false }, { logger: false });
    await app.ready();
    const tA = (await q(`INSERT INTO tenants (name) VALUES ('Alpha') RETURNING id`))[0].id;
    const tB = (await q(`INSERT INTO tenants (name) VALUES ('Beta') RETURNING id`))[0].id;
    c.ownerA = await user("owner@alpha.test", tA, "OWNER");
    c.viewerA = await user("viewer@alpha.test", tA, "VIEWER");
    c.ownerB = await user("owner@beta.test", tB, "OWNER");
  });

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false, wait: true });
    await db?.closePool();
  });

  it("adds a product into skus, sku_units, sku_aliases and prices", async () => {
    const res = await as(c.ownerA!).post("/v1/catalogue/products", GOOD_DAY);
    expect(res.statusCode).toBe(201);
    const p = res.json();
    c.gd = p.id;
    expect(p).toMatchObject({ sku: "GD-10", pack_units: { PCS: 1, BOX: 12, CASE: 144 }, mrp: "10.00", dealer_price: "8.60", aliases: ["gudday", "குட் டே"], source: "manual", active: true });
    expect(await q(`SELECT unit, base_multiplier FROM sku_units WHERE sku_id = $1 ORDER BY base_multiplier`, [p.id])).toEqual([
      { unit: "PCS", base_multiplier: "1.0000" },
      { unit: "BOX", base_multiplier: "12.0000" },
      { unit: "CASE", base_multiplier: "144.0000" },
    ]);
    expect((await as(c.ownerA!).post("/v1/catalogue/products", GOOD_DAY)).json().error.code).toBe("SKU_EXISTS");
  });

  it("rejects invalid input with field errors", async () => {
    const res = await as(c.ownerA!).post("/v1/catalogue/products", { ...GOOD_DAY, sku: "X", dealer_price: "abc", pack_units: { BOX: 0 } });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.fields.map((f: { path: string }) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["dealer_price", "pack_units.BOX"]));
  });

  it("edits a price, hides and restores, and audits each change", async () => {
    const res = await as(c.ownerA!).patch(`/v1/catalogue/products/${c.gd}`, { dealer_price: "8.75" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dealer_price: "8.75", aliases: ["gudday", "குட் டே"] });
    expect((await as(c.ownerA!).patch(`/v1/catalogue/products/${c.gd}`, { active: false })).json().active).toBe(false);
    expect((await as(c.ownerA!).patch(`/v1/catalogue/products/${c.gd}`, { active: true })).json().active).toBe(true);
    const audit = await q(`SELECT details_json FROM audit_events WHERE action = 'product.updated' AND entity_id = $1 ORDER BY created_at, id`, [c.gd]);
    expect(audit[0].details_json.changes.dealer_price).toEqual({ from: "8.60", to: "8.75" });
  });

  it("CSV: preview saves nothing, errors block everything, then import applies", async () => {
    const csv = HEAD + "GD-10,Good Day Rs10,Biscuits,PCS,BOX=12;CASE=144,10,9.00,gudday\nMG-250,Marie Gold 250g,Biscuits,PCS,BOX=12;CASE=48,40,34.40,marie\n";
    const preview = (await as(c.ownerA!).post("/v1/catalogue/import", { csv, dry_run: true })).json();
    expect(preview).toMatchObject({ applied: false, counts: { create: 1, update: 1 } });
    expect(preview.items.find((i: { sku: string }) => i.sku === "GD-10").changes.dealer_price).toEqual({ from: "8.75", to: "9.00" });
    expect((await as(c.ownerA!).get("/v1/catalogue/products")).json().products).toHaveLength(1);

    const bad = (await as(c.ownerA!).post("/v1/catalogue/import", { csv: csv + "BAD,,,PCS,BOX=1,x,y,\n", dry_run: false })).json();
    expect(bad.applied).toBe(false);
    expect(bad.errors[0].line).toBe(4);
    expect((await as(c.ownerA!).get("/v1/catalogue/products")).json().products).toHaveLength(1);

    const done = (await as(c.ownerA!).post("/v1/catalogue/import", { csv, dry_run: false })).json();
    expect(done.applied).toBe(true);
    const list = (await as(c.ownerA!).get("/v1/catalogue/products")).json().products;
    expect(list.map((p: { sku: string; dealer_price: string }) => [p.sku, p.dealer_price])).toEqual([
      ["GD-10", "9.00"],
      ["MG-250", "34.40"],
    ]);
    // gudday stays; the Tamil alias is gone because the file is the new truth for that row.
    expect(list[0].aliases).toEqual(["gudday"]);
  });

  it("CSV: hide_missing hides products that are not in the file", async () => {
    const csv = HEAD + "MG-250,Marie Gold 250g,Biscuits,PCS,BOX=12;CASE=48,40,34.40,marie\n";
    const r = (await as(c.ownerA!).post("/v1/catalogue/import", { csv, dry_run: false, hide_missing: true })).json();
    expect(r.hide).toEqual([{ sku: "GD-10", name: "Good Day Rs10" }]);
    const gd = (await as(c.ownerA!).get("/v1/catalogue/products")).json().products.find((p: { sku: string }) => p.sku === "GD-10");
    expect(gd.active).toBe(false);
  });

  it("exports a CSV that imports back unchanged", async () => {
    const res = await as(c.ownerA!).get("/v1/catalogue/export.csv");
    expect(res.headers["content-type"]).toContain("text/csv");
    const back = (await as(c.ownerA!).post("/v1/catalogue/import", { csv: res.body, dry_run: true })).json();
    expect(back.errors).toEqual([]);
    expect(back.counts).toMatchObject({ create: 0, update: 0, unchanged: 2 });
  });

  it("viewers can read and download but not change anything", async () => {
    expect((await as(c.viewerA!).get("/v1/catalogue/products")).statusCode).toBe(200);
    expect((await as(c.viewerA!).get("/v1/catalogue/export.csv")).statusCode).toBe(200);
    expect((await as(c.viewerA!).post("/v1/catalogue/products", { ...GOOD_DAY, sku: "NEW" })).statusCode).toBe(403);
    expect((await as(c.viewerA!).patch(`/v1/catalogue/products/${c.gd}`, { dealer_price: "1" })).statusCode).toBe(403);
    expect((await as(c.viewerA!).post("/v1/catalogue/import", { csv: HEAD })).statusCode).toBe(403);
  });

  it("learning: chat suggestions only match after staff approve them", async () => {
    const cat = await import("@fmcg/catalogue");
    const tA = (await q(`SELECT tenant_id FROM skus WHERE id = $1`, [c.gd]))[0].tenant_id;
    await db.withTx((tx) =>
      cat.recordLearning(tx, tA, [
        { kind: "picked", phrase: "MB", sku: "MG-250" },
        { kind: "picked", phrase: "mb", sku: "MG-250" },
        { kind: "unmatched", phrase: "kurkure" },
      ]),
    );
    const learning = (await as(c.ownerA!).get("/v1/catalogue/learning")).json();
    expect(learning.suggestions).toMatchObject([{ alias: "MB", sku: "MG-250", times_seen: 2 }]);
    expect(learning.unmatched).toMatchObject([{ example: "kurkure", times_seen: 1 }]);
    const mg = () => as(c.ownerA!).get("/v1/catalogue/products").then((r) => r.json().products.find((p: { sku: string }) => p.sku === "MG-250"));
    expect((await mg()).aliases).toEqual(["marie"]); // a suggestion is not an alias yet

    expect((await as(c.viewerA!).post(`/v1/catalogue/aliases/${learning.suggestions[0].id}/approve`, {})).statusCode).toBe(403);
    expect((await as(c.ownerA!).post(`/v1/catalogue/aliases/${learning.suggestions[0].id}/approve`, {})).statusCode).toBe(200);
    expect((await mg()).aliases).toEqual(["marie", "MB"]);
    // Editing the product keeps working with learned aliases.
    expect((await as(c.ownerA!).patch(`/v1/catalogue/products/${(await mg()).id}`, { dealer_price: "35.00" })).json().aliases).toEqual(["marie", "MB"]);

    const gd = (await as(c.ownerA!).get("/v1/catalogue/products")).json().products.find((p: { sku: string }) => p.sku === "GD-10");
    expect((await as(c.ownerA!).post(`/v1/catalogue/unmatched/${learning.unmatched[0].id}/link`, { sku_id: gd.id })).statusCode).toBe(200);
    const after = (await as(c.ownerA!).get("/v1/catalogue/learning")).json();
    expect(after).toEqual({ suggestions: [], unmatched: [] });
    expect((await as(c.ownerA!).get("/v1/catalogue/products")).json().products.find((p: { sku: string }) => p.sku === "GD-10").aliases).toContain("kurkure");
    // Another tenant sees none of it.
    expect((await as(c.ownerB!).get("/v1/catalogue/learning")).json()).toEqual({ suggestions: [], unmatched: [] });
  });

  it("gate 12: another tenant cannot see or change these products", async () => {
    expect((await as(c.ownerB!).get("/v1/catalogue/products")).json().products).toEqual([]);
    expect((await as(c.ownerB!).patch(`/v1/catalogue/products/${c.gd}`, { dealer_price: "1" })).statusCode).toBe(404);
    // The same SKU code is free in another tenant.
    expect((await as(c.ownerB!).post("/v1/catalogue/products", GOOD_DAY)).statusCode).toBe(201);
  });
});
