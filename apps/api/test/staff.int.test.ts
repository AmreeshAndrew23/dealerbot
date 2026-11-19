// Staff API: login, roles, tenant isolation (release gate 12), takeover and human replies.
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

describe.skipIf(!enabled)("Staff API (integration)", () => {
  let app: FastifyInstance;
  let db: typeof import("@fmcg/db");
  let ch: typeof import("@fmcg/channel");
  let boss: import("@fmcg/channel").Boss;
  const ids: Record<string, string> = {};

  const q = async (sql: string, p: unknown[] = []) => (await db.getPool().query(sql, p)).rows;
  const cookieOf = (res: LightMyRequestResponse) => {
    const c = res.cookies.find((x) => x.name === "fmcg_session");
    return c ? `fmcg_session=${c.value}` : "";
  };
  const login = async (email: string, password = PW) => {
    const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
    return { res, cookie: cookieOf(res) };
  };
  const as = (cookie: string) => ({
    get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
    post: (url: string, payload: unknown = {}, headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url, payload: payload as object, headers: { cookie, ...headers } }),
    patch: (url: string, payload: unknown) => app.inject({ method: "PATCH", url, payload: payload as object, headers: { cookie } }),
  });

  async function seedTenant(name: string, phoneId: string, contactPhone: string) {
    const t = (await q(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [name]))[0].id;
    const ca = (await q(`INSERT INTO channel_accounts (tenant_id, provider_phone_id, secret_reference) VALUES ($1,$2,'env:WHATSAPP_ACCESS_TOKEN') RETURNING id`, [t, phoneId]))[0].id;
    const ct = (await q(`INSERT INTO contacts (tenant_id, phone_e164, profile_name) VALUES ($1,$2,$3) RETURNING id`, [t, contactPhone, `${name} shop`]))[0].id;
    const cv = (await q(`INSERT INTO conversations (tenant_id, channel_account_id, contact_id, last_inbound_at) VALUES ($1,$2,$3, now()) RETURNING id`, [t, ca, ct]))[0].id;
    await q(
      `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, provider_message_id, direction, type, body) VALUES ($1,$2,$3,$4,'inbound','text',$5)`,
      [t, cv, ca, `wamid.${name}`, `hello from ${name}`],
    );
    const media = (await q(`INSERT INTO media_assets (tenant_id, storage_key, mime_type, size_bytes, sha256) VALUES ($1,'x','audio/ogg',1,'x') RETURNING id`, [t]))[0].id;
    return { t, cv, media };
  }

  async function user(email: string, tenant: string, role: string) {
    const { hashPassword } = await import("../src/auth/password");
    const u = (await q(`INSERT INTO users (auth_subject, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [`local:${email}`, email, email.split("@")[0], await hashPassword(PW)]))[0].id;
    await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tenant, u, role]);
    return u;
  }

  beforeAll(async () => {
    db = await import("@fmcg/db");
    ch = await import("@fmcg/channel");
    const pool = db.getPool();
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;");
    await db.runMigrations(pool);
    boss = await ch.startBoss(TEST_DB, "api");
    const { getConfig } = await import("@fmcg/config");
    const { buildServer } = await import("../src/server");
    app = buildServer({ config: getConfig(), boss, storage: new ch.LocalStorage(process.cwd() + "/storage-test"), secureCookie: false }, { logger: false });
    await app.ready();
    const a = await seedTenant("Alpha", "111", "+919000000001");
    const b = await seedTenant("Beta", "222", "+919000000002");
    Object.assign(ids, { tA: a.t, cvA: a.cv, tB: b.t, cvB: b.cv, mediaB: b.media });
    ids.ownerA = await user("owner@alpha.test", a.t, "OWNER");
    ids.viewerA = await user("viewer@alpha.test", a.t, "VIEWER");
    ids.ownerB = await user("owner@beta.test", b.t, "OWNER");
  });

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false, wait: true });
    await db?.closePool();
  });

  it("rejects bad credentials and unauthenticated requests", async () => {
    expect((await login("owner@alpha.test", "wrong-password")).res.statusCode).toBe(401);
    expect((await login("nobody@alpha.test")).res.statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/conversations" })).statusCode).toBe(401);
    const bad = await app.inject({ url: "/v1/conversations", headers: { cookie: "fmcg_session=forged" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("logs in with an HTTP-only session cookie and returns tenant, role and permissions", async () => {
    const { res } = await login("owner@alpha.test");
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === "fmcg_session")!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Lax");
    expect(res.json()).toMatchObject({ tenant: { name: "Alpha" }, role: "OWNER" });
    expect(res.json().permissions).toContain("users.manage");
    const stored = await q(`SELECT token_hash FROM sessions`);
    expect(stored.every((s: any) => !c.value.includes(s.token_hash))).toBe(true);
  });

  it("release gate 12 (API): a tenant cannot read another tenant's conversations, messages or media", async () => {
    const A = as((await login("owner@alpha.test")).cookie);
    const list = (await A.get("/v1/conversations")).json();
    expect(list.items.map((c: any) => c.profile_name)).toEqual(["Alpha shop"]);
    expect(list.items[0].preview).toBe("hello from Alpha");
    expect((await A.get(`/v1/conversations/${ids.cvB}`)).statusCode).toBe(404);
    expect((await A.get(`/v1/conversations/${ids.cvB}/messages`)).statusCode).toBe(404);
    expect((await A.post(`/v1/conversations/${ids.cvB}/takeover`)).statusCode).toBe(404);
    expect((await A.get(`/v1/media/${ids.mediaB}`)).statusCode).toBe(404);
  });

  it("release gate 12 (database): row-level security hides other tenants even without a WHERE clause", async () => {
    const rows = await db.withTenantTx(ids.tA!, async (tx) => (await tx.query(`SELECT tenant_id FROM conversations`)).rows);
    expect(rows).toEqual([{ tenant_id: ids.tA }]);
    const none = await db.withTenantTx(ids.tA!, async (tx) => (await tx.query(`SELECT 1 FROM messages WHERE tenant_id = $1`, [ids.tB])).rows);
    expect(none).toHaveLength(0);
    await expect(
      db.withTenantTx(ids.tA!, (tx) => tx.query(`INSERT INTO contacts (tenant_id, phone_e164) VALUES ($1, '+919999999999')`, [ids.tB])),
    ).rejects.toThrow(/row-level security/);
    await expect(db.withTenantTx(ids.tA!, (tx) => tx.query(`SELECT * FROM webhook_events`))).rejects.toThrow(/permission denied/);
  });

  it("viewers can read but not take over or reply", async () => {
    const V = as((await login("viewer@alpha.test")).cookie);
    expect((await V.get("/v1/conversations")).statusCode).toBe(200);
    expect((await V.post(`/v1/conversations/${ids.cvA}/takeover`)).statusCode).toBe(403);
    expect((await V.post(`/v1/conversations/${ids.cvA}/messages`, { text: "hi" }, { "idempotency-key": "v1" })).statusCode).toBe(403);
    expect((await V.get("/v1/users")).statusCode).toBe(403);
  });

  it("human reply: requires takeover and Idempotency-Key, goes through the policy gate, and is idempotent", async () => {
    const A = as((await login("owner@alpha.test")).cookie);
    const url = `/v1/conversations/${ids.cvA}/messages`;
    const early = await A.post(url, { text: "Hello" }, { "idempotency-key": "k0" });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("NOT_TAKEN_OVER");

    const t = await A.post(`/v1/conversations/${ids.cvA}/takeover`);
    expect(t.json()).toMatchObject({ owner_mode: "HUMAN", assigned_user_name: "owner", messaging_mode: "FREE_FORM" });

    expect((await A.post(url, { text: "Hello" })).statusCode).toBe(400);
    const r1 = await A.post(url, { text: "Hello, checking your order" }, { "idempotency-key": "k1" });
    expect(r1.statusCode).toBe(202);
    const r2 = await A.post(url, { text: "Hello, checking your order" }, { "idempotency-key": "k1" });
    expect(r2.statusCode).toBe(202);
    expect(r2.json()).toEqual(r1.json());
    expect((await A.post(url, { text: "Different" }, { "idempotency-key": "k1" })).statusCode).toBe(409);
    const rows = await q(`SELECT origin, sent_by, status FROM outbound_messages WHERE tenant_id = $1`, [ids.tA]);
    expect(rows).toEqual([{ origin: "human", sent_by: ids.ownerA, status: "queued" }]);

    const thread = (await A.get(`/v1/conversations/${ids.cvA}/messages`)).json();
    expect(thread.items.map((m: any) => [m.direction, m.text])).toEqual([
      ["inbound", "hello from Alpha"],
      ["outbound", "Hello, checking your order"],
    ]);
    expect(thread.items[1]).toMatchObject({ origin: "human", sent_by_name: "owner", status: "queued" });
  });

  it("outside the 24-hour window a free-form reply is refused with 422 and recorded as blocked", async () => {
    await q(`UPDATE conversations SET last_inbound_at = now() - interval '2 days' WHERE id = $1`, [ids.cvA]);
    const A = as((await login("owner@alpha.test")).cookie);
    expect((await A.get(`/v1/conversations/${ids.cvA}`)).json().messaging_mode).toBe("TEMPLATE_ONLY");
    const r = await A.post(`/v1/conversations/${ids.cvA}/messages`, { text: "Late reply" }, { "idempotency-key": "late" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.details.reason).toBe("OUTSIDE_SERVICE_WINDOW");
    expect(await q(`SELECT status FROM outbound_messages WHERE payload_json->>'text' = 'Late reply'`)).toEqual([{ status: "blocked" }]);
    const resumed = await A.post(`/v1/conversations/${ids.cvA}/resume`);
    expect(resumed.json()).toMatchObject({ owner_mode: "BOT", assigned_user_id: null });
  });

  it("owner invites an operator, who accepts and gets the right role; the last owner cannot be removed", async () => {
    const A = as((await login("owner@alpha.test")).cookie);
    const inv = await A.post("/v1/users/invitations", { email: "op@alpha.test", role: "OPERATOR" });
    expect(inv.statusCode).toBe(201);
    const token = new URL("http://x" + inv.json().accept_path).searchParams.get("token")!;
    const info = await app.inject({ url: `/v1/auth/invitations/${token}` });
    expect(info.json()).toMatchObject({ email: "op@alpha.test", tenant_name: "Alpha", role: "OPERATOR", existing_user: false });
    expect((await app.inject({ method: "POST", url: "/v1/auth/accept-invite", payload: { token, password: "short", display_name: "Op" } })).statusCode).toBe(400);
    const acc = await app.inject({ method: "POST", url: "/v1/auth/accept-invite", payload: { token, password: PW, display_name: "Op" } });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ role: "OPERATOR", tenant: { name: "Alpha" } });
    expect((await app.inject({ method: "POST", url: "/v1/auth/accept-invite", payload: { token, password: PW } })).statusCode).toBe(404);

    const users = (await A.get("/v1/users")).json().users;
    expect(users.map((u: any) => u.email).sort()).toEqual(["op@alpha.test", "owner@alpha.test", "viewer@alpha.test"]);
    const demote = await A.patch(`/v1/users/${ids.ownerA}`, { role: "OPERATOR" });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("LAST_OWNER");
    // Tenant B's users are invisible and unmodifiable from tenant A.
    expect((await A.patch(`/v1/users/${ids.ownerB}`, { active: false })).statusCode).toBe(404);
  });

  it("deactivating a member ends their sessions; logout ends the current one", async () => {
    const { cookie } = await login("viewer@alpha.test");
    const A = as((await login("owner@alpha.test")).cookie);
    expect((await A.patch(`/v1/users/${ids.viewerA}`, { active: false })).statusCode).toBe(200);
    expect((await as(cookie).get("/v1/auth/me")).statusCode).toBe(401);
    expect((await login("viewer@alpha.test")).res.statusCode).toBe(403);

    const o = await login("owner@alpha.test");
    expect((await as(o.cookie).post("/v1/auth/logout")).statusCode).toBe(200);
    expect((await as(o.cookie).get("/v1/auth/me")).statusCode).toBe(401);
  });

  it("audits sign-ins, takeovers, replies and membership changes", async () => {
    const actions = (await q(`SELECT DISTINCT action FROM audit_events WHERE tenant_id = $1`, [ids.tA])).map((r: any) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.login", "conversation.takeover", "conversation.resume", "outbound.queued", "outbound.blocked", "invitation.created", "invitation.accepted", "membership.updated"]));
  });
});
