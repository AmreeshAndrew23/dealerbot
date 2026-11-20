// Platform admin: separate sign-in, add a dealer with an owner invite the owner accepts, rename,
// suspend (staff and shops lose access, nothing deleted) and reactivate.
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

describe.skipIf(!enabled)("Platform admin API (integration)", () => {
  let app: FastifyInstance;
  let db: typeof import("@fmcg/db");
  let boss: import("@fmcg/channel").Boss;
  const q = async (sql: string, p: unknown[] = []) => (await db.getPool().query(sql, p)).rows;
  const cookie = (res: LightMyRequestResponse, name: string) => {
    const c = res.cookies.find((x) => x.name === name);
    return c ? `${name}=${c.value}` : "";
  };
  const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, c: string, payload?: unknown) =>
    app.inject({ method, url, headers: c ? { cookie: c } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
  let admin = "";
  let staffOfOther = "";

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
    const { hashPassword } = await import("../src/auth/password");
    await q(`INSERT INTO platform_admins (email, display_name, password_hash) VALUES ('root@platform.test','Root',$1)`, [await hashPassword(PW)]);
    // An existing dealer with an owner, to prove staff cannot reach /v1/admin.
    const t = (await q(`INSERT INTO tenants (name) VALUES ('Other Dealer') RETURNING id`))[0].id;
    const u = (await q(`INSERT INTO users (auth_subject, email, display_name, password_hash) VALUES ('local:o@other.test','o@other.test','O',$1) RETURNING id`, [await hashPassword(PW)]))[0].id;
    await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'OWNER')`, [t, u]);
    staffOfOther = cookie(await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "o@other.test", password: PW } }), "fmcg_session");
  });

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false, wait: true });
    await db?.closePool();
  });

  it("admin sign-in is separate from staff sign-in", async () => {
    expect((await req("GET", "/v1/admin/dealers", "")).statusCode).toBe(401);
    expect((await req("GET", "/v1/admin/dealers", staffOfOther)).statusCode).toBe(401);
    // An admin email/password does not open the staff dashboard, and vice versa.
    expect((await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "root@platform.test", password: PW } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/admin/login", payload: { email: "o@other.test", password: PW } })).statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/v1/admin/login", payload: { email: "root@platform.test", password: "wrong-password" } });
    expect(bad.statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: "/v1/admin/login", payload: { email: "ROOT@platform.test", password: PW } });
    expect(res.statusCode).toBe(200);
    admin = cookie(res, "fmcg_admin");
    expect(admin).not.toBe("");
    expect((await req("GET", "/v1/admin/me", admin)).json()).toMatchObject({ admin: { email: "root@platform.test" } });
    // The admin cookie does not open staff routes.
    expect((await req("GET", "/v1/auth/me", admin)).statusCode).toBe(401);
  });

  it("adds a dealer; the owner accepts the invite link and runs it; a staff user cannot see it", async () => {
    const res = await req("POST", "/v1/admin/dealers", admin, { name: "  Sri Murugan Agencies ", owner_email: "owner@murugan.test" });
    expect(res.statusCode).toBe(201);
    const { dealer, invite } = res.json();
    expect(dealer.name).toBe("Sri Murugan Agencies");
    expect(invite).toMatchObject({ email: "owner@murugan.test", role: "OWNER" });
    expect((await req("POST", "/v1/admin/dealers", admin, { name: "sri murugan agencies", owner_email: "x@y.test" })).statusCode).toBe(409);

    const list = (await req("GET", "/v1/admin/dealers", admin)).json().dealers;
    expect(list.find((d: any) => d.id === dealer.id)).toMatchObject({ status: "active", owners: [], pending_owner: "owner@murugan.test" });

    const token = new URLSearchParams(invite.accept_path.split("?")[1]).get("token");
    const acc = await app.inject({ method: "POST", url: "/v1/auth/accept-invite", payload: { token, password: PW, display_name: "Murugan" } });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ role: "OWNER", tenant: { id: dealer.id, name: "Sri Murugan Agencies" } });
    // The link works once.
    expect((await app.inject({ method: "POST", url: "/v1/auth/accept-invite", payload: { token, password: PW, display_name: "X" } })).statusCode).toBe(404);

    const detail = (await req("GET", `/v1/admin/dealers/${dealer.id}`, admin)).json();
    expect(detail.staff).toEqual([expect.objectContaining({ email: "owner@murugan.test", role: "OWNER", active: true })]);
    expect(detail.invitations).toEqual([]);
    const audit = await q(`SELECT action, actor_type FROM audit_events WHERE tenant_id = $1 ORDER BY created_at`, [dealer.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["tenant.created", "invitation.created", "invitation.accepted"]));
    expect(audit.find((a) => a.action === "tenant.created").actor_type).toBe("platform_admin");

    // The other dealer's staff still only see their own dealer.
    const me = (await req("GET", "/v1/auth/me", staffOfOther)).json();
    expect(me.tenants.map((t: any) => t.name)).toEqual(["Other Dealer"]);
  });

  it("renames, suspends (staff and shops locked out, nothing deleted) and reactivates", async () => {
    const d = (await req("GET", "/v1/admin/dealers", admin)).json().dealers.find((x: any) => x.name === "Sri Murugan Agencies");
    const ren = await req("PATCH", `/v1/admin/dealers/${d.id}`, admin, { name: "Murugan Agencies" });
    expect(ren.statusCode).toBe(200);
    expect(ren.json().name).toBe("Murugan Agencies");
    expect((await req("PATCH", `/v1/admin/dealers/${d.id}`, admin, { name: "other dealer" })).statusCode).toBe(409);

    // The owner is signed in, and a shop of this dealer is signed in to the customer app.
    const staff = cookie(await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "owner@murugan.test", password: PW } }), "fmcg_session");
    expect((await req("GET", "/v1/auth/me", staff)).statusCode).toBe(200);
    const created = await req("POST", "/v1/retailers", staff, { shop_name: "Kumar Stores", phone: "9876543210" });
    expect(created.statusCode).toBe(201);
    const code = (await req("POST", `/v1/retailers/${created.json().id}/app-code`, staff)).json().code as string;
    const shopLogin = await app.inject({ method: "POST", url: "/v1/app/login", payload: { phone: "9876543210", code } });
    expect(shopLogin.statusCode).toBe(200);
    const shop = cookie(shopLogin, "fmcg_retailer");

    const sus = await req("PATCH", `/v1/admin/dealers/${d.id}`, admin, { status: "suspended", reason: "payment overdue" });
    expect(sus.json()).toMatchObject({ status: "suspended", suspended_reason: "payment overdue" });
    expect((await req("GET", "/v1/auth/me", staff)).statusCode).toBe(401);
    const relogin = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "owner@murugan.test", password: PW } });
    expect(relogin.statusCode).toBe(403);
    expect(relogin.json().error.code).toBe("DEALER_SUSPENDED");
    expect((await req("GET", "/v1/app/me", shop)).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/app/login", payload: { phone: "9876543210", code } })).statusCode).toBe(401);
    // Other dealers are unaffected.
    expect((await req("GET", "/v1/auth/me", staffOfOther)).statusCode).toBe(200);

    const back = await req("PATCH", `/v1/admin/dealers/${d.id}`, admin, { status: "active" });
    expect(back.json()).toMatchObject({ status: "active", suspended_reason: null, retailers: 1 });
    expect((await req("GET", "/v1/auth/me", staff)).statusCode).toBe(200);
    expect((await req("GET", "/v1/app/me", shop)).statusCode).toBe(200);
    const actions = (await q(`SELECT action FROM audit_events WHERE tenant_id = $1`, [d.id])).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["tenant.renamed", "tenant.suspended", "tenant.reactivated"]));
  });

  it("makes and cancels a new owner invite; an existing owner can't be invited again", async () => {
    const d = (await req("GET", "/v1/admin/dealers", admin)).json().dealers.find((x: any) => x.name === "Murugan Agencies");
    expect((await req("POST", `/v1/admin/dealers/${d.id}/invitations`, admin, { email: "owner@murugan.test" })).statusCode).toBe(409);
    const inv = await req("POST", `/v1/admin/dealers/${d.id}/invitations`, admin, { email: "partner@murugan.test" });
    expect(inv.statusCode).toBe(201);
    // A second link for the same email replaces the first.
    const inv2 = await req("POST", `/v1/admin/dealers/${d.id}/invitations`, admin, { email: "partner@murugan.test" });
    let detail = (await req("GET", `/v1/admin/dealers/${d.id}`, admin)).json();
    expect(detail.invitations.map((i: any) => i.id)).toEqual([inv2.json().id]);
    expect((await req("DELETE", `/v1/admin/dealers/${d.id}/invitations/${inv2.json().id}`, admin)).statusCode).toBe(200);
    detail = (await req("GET", `/v1/admin/dealers/${d.id}`, admin)).json();
    expect(detail.invitations).toEqual([]);
  });

  it("sign out ends the admin session", async () => {
    await req("POST", "/v1/admin/logout", admin);
    expect((await req("GET", "/v1/admin/dealers", admin)).statusCode).toBe(401);
  });
});
