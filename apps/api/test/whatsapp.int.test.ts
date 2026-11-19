// End-to-end tests of the WhatsApp slice against a real PostgreSQL database.
// Runs only when TEST_DATABASE_URL points at a database whose name ends in "_test" (it is wiped).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const TEST_DB = process.env.TEST_DATABASE_URL ?? "";
const enabled = /_test(\?.*)?$/.test(TEST_DB);
const APP_SECRET = "test-app-secret";

process.env.DATABASE_URL = TEST_DB || "postgres://unused@localhost/unused";
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
process.env.WHATSAPP_ACCESS_TOKEN = "test-token";

describe.skipIf(!enabled)("WhatsApp channel (integration)", () => {
  let app: FastifyInstance;
  let ch: typeof import("@fmcg/channel");
  let db: typeof import("@fmcg/db");
  let boss: import("@fmcg/channel").Boss;
  let fx: typeof import("../../../packages/channel/test/fixtures");
  let tenantId = "";
  const sent: Array<{ to: string; body: any }> = [];

  const fakeGraph = () => {
    const c = ch;
    return new c.GraphClient({
      accessToken: "test-token",
      apiVersion: "v23.0",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        sent.push({ to: body.to, body });
        return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${sent.length}` }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
  };

  const post = (payload: unknown, secret = APP_SECRET) => {
    const raw = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": ch.signMetaPayload(raw, secret) },
      payload: raw,
    });
  };
  const q = async (sql: string, p: unknown[] = []) => (await db.getPool().query(sql, p)).rows;
  const pendingJobs = async (queue: string) =>
    (await q(`SELECT id, data FROM pgboss.job WHERE name = $1 AND state = 'created' ORDER BY created_on`, [queue])) as Array<{ id: string; data: any }>;
  const drain = async (queue: string, run: (data: any) => Promise<unknown>) => {
    for (const j of await pendingJobs(queue)) {
      await run(j.data);
      await q(`UPDATE pgboss.job SET state = 'completed' WHERE id = $1`, [j.id]);
    }
  };
  const processAll = async () => {
    const { QUEUES } = await import("@fmcg/contracts");
    await drain(QUEUES.inbound, (d) => ch.handleInboundJob(d.webhook_event_id, boss));
    await drain(QUEUES.send, (d) => ch.handleSendJob(d, { apiVersion: "v23.0", graphFactory: fakeGraph }));
  };

  beforeAll(async () => {
    db = await import("@fmcg/db");
    ch = await import("@fmcg/channel");
    fx = await import("../../../packages/channel/test/fixtures");
    const pool = db.getPool();
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;");
    await db.runMigrations(pool);
    boss = await ch.startBoss(TEST_DB, "api");
    const { getConfig } = await import("@fmcg/config");
    const { buildServer } = await import("../src/server");
    app = buildServer({ config: getConfig(), boss, storage: new ch.LocalStorage(process.cwd() + "/storage-test"), secureCookie: false }, { logger: false });
    await app.ready();
    const t = await q(`INSERT INTO tenants (name) VALUES ('Test Distributor') RETURNING id`);
    tenantId = t[0].id;
    await q(
      `INSERT INTO channel_accounts (tenant_id, provider_phone_id, secret_reference) VALUES ($1, $2, 'env:WHATSAPP_ACCESS_TOKEN')`,
      [tenantId, fx.PHONE_ID],
    );
  });

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false, wait: true });
    await db?.closePool();
  });

  it("answers Meta's verification handshake only with the right token", async () => {
    const ok = await app.inject({ url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("12345");
    const bad = await app.inject({ url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" });
    expect(bad.statusCode).toBe(403);
  });

  it("rejects an invalid signature with 401 and stores nothing", async () => {
    const res = await post(fx.textWebhook({ id: "wamid.BAD" }), "wrong-secret");
    expect(res.statusCode).toBe(401);
    expect(await q(`SELECT 1 FROM webhook_events WHERE event_key = 'msg:wamid.BAD'`)).toHaveLength(0);
  });

  it("release gate 1: duplicate deliveries produce one stored input and one job", async () => {
    const payload = fx.textWebhook({ id: "wamid.DUP1", ts: Math.floor(Date.now() / 1000) });
    const results = await Promise.all([post(payload), post(payload), post(payload)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await q(`SELECT 1 FROM webhook_events WHERE event_key = 'msg:wamid.DUP1'`)).toHaveLength(1);
    expect(await pendingJobs("whatsapp-inbound")).toHaveLength(1);

    await processAll();
    const msgs = await q(`SELECT body, direction FROM messages WHERE provider_message_id = 'wamid.DUP1'`);
    expect(msgs).toEqual([{ body: "2 case Product A 100g", direction: "inbound" }]);
    const contact = await q(`SELECT phone_e164, profile_name FROM contacts`);
    expect(contact).toEqual([{ phone_e164: "+919876543210", profile_name: "Murugan Stores" }]);
  });

  it("unknown sender gets exactly one neutral acknowledgement, sent through the policy gate", async () => {
    const out = await q(`SELECT status, origin, policy_result, provider_id FROM outbound_messages`);
    expect(out).toEqual([{ status: "sent", origin: "bot", policy_result: "ALLOW", provider_id: "wamid.OUT1" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.text.body).toContain("received your message");
    expect(sent[0]!.body.text.body).not.toMatch(/₹|price|balance/i);

    // A second message within 30 minutes does not trigger another acknowledgement.
    await post(fx.textWebhook({ id: "wamid.DUP2", ts: Math.floor(Date.now() / 1000) }));
    await processAll();
    expect(sent).toHaveLength(1);
  });

  it("delivery statuses update the outbound row, only move forward, and create no messages", async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM messages`))[0].n;
    await post(fx.statusWebhook("read", "wamid.OUT1"));
    await post(fx.statusWebhook("delivered", "wamid.OUT1")); // arrives late
    await processAll();
    const row = (await q(`SELECT status, read_at IS NOT NULL AS has_read FROM outbound_messages WHERE provider_id = 'wamid.OUT1'`))[0];
    expect(row).toEqual({ status: "read", has_read: true });
    expect((await q(`SELECT count(*)::int AS n FROM messages`))[0].n).toBe(before);
  });

  it("release gate 11: human takeover blocks bot replies", async () => {
    await q(`UPDATE conversations SET owner_mode = 'HUMAN'`);
    await post(fx.textWebhook({ id: "wamid.HUM1", ts: Math.floor(Date.now() / 1000) }));
    // Force a new acknowledgement bucket so dedupe does not hide the policy decision.
    const { QUEUES } = await import("@fmcg/contracts");
    for (const j of await pendingJobs(QUEUES.inbound)) {
      await ch.handleInboundJob(j.data.webhook_event_id, boss, new Date(Date.now() + 60 * 60 * 1000));
      await q(`UPDATE pgboss.job SET state = 'completed' WHERE id = $1`, [j.id]);
    }
    const blocked = await q(`SELECT status, policy_reason FROM outbound_messages WHERE policy_result = 'DENY'`);
    expect(blocked).toEqual([{ status: "blocked", policy_reason: "HUMAN_TAKEOVER" }]);
    expect(await pendingJobs(QUEUES.send)).toHaveLength(0);
    await q(`UPDATE conversations SET owner_mode = 'BOT'`);
  });

  it("STOP records an opt-out, confirms once, and blocks later bot messages", async () => {
    sent.length = 0;
    await post(fx.textWebhook({ id: "wamid.STOP1", text: "STOP", ts: Math.floor(Date.now() / 1000) }));
    await processAll();
    expect(await q(`SELECT action, purpose FROM consent_events`)).toEqual([{ action: "opt_out", purpose: "order_messaging" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.text.body).toContain("no longer receive");

    const { QUEUES } = await import("@fmcg/contracts");
    await post(fx.textWebhook({ id: "wamid.AFTERSTOP", ts: Math.floor(Date.now() / 1000) }));
    for (const j of await pendingJobs(QUEUES.inbound)) {
      await ch.handleInboundJob(j.data.webhook_event_id, boss, new Date(Date.now() + 3 * 60 * 60 * 1000));
      await q(`UPDATE pgboss.job SET state = 'completed' WHERE id = $1`, [j.id]);
    }
    const last = await q(`SELECT policy_reason FROM outbound_messages ORDER BY created_at DESC LIMIT 1`);
    expect(last).toEqual([{ policy_reason: "OPTED_OUT" }]);
  });

  it("messages for an unregistered phone number ID are stored but not routed to any tenant", async () => {
    await post(fx.textWebhook({ id: "wamid.OTHER", phoneId: "999999" }));
    await processAll();
    const ev = await q(`SELECT process_result FROM webhook_events WHERE event_key = 'msg:wamid.OTHER'`);
    expect(ev).toEqual([{ process_result: "UNKNOWN_PHONE_NUMBER_ID" }]);
    expect(await q(`SELECT 1 FROM messages WHERE provider_message_id = 'wamid.OTHER'`)).toHaveLength(0);
  });

  it("a missing access token fails the message clearly without marking it as an interrupted send", async () => {
    const conv = (await q(`SELECT id FROM conversations LIMIT 1`))[0].id;
    await q(`DELETE FROM consent_events`);
    const o = await db.withTx((tx) =>
      ch.queueOutbound(tx, boss, { tenantId, conversationId: conv, dedupeKey: "no-token", origin: "human", payload: { kind: "text", text: "hi" } }),
    );
    const saved = process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    try {
      await ch.handleSendJob({ outbound_id: o.outboundId!, tenant_id: tenantId }, { apiVersion: "v23.0", graphFactory: fakeGraph });
      await ch.handleSendJob({ outbound_id: o.outboundId!, tenant_id: tenantId }, { apiVersion: "v23.0", graphFactory: fakeGraph });
    } finally {
      process.env.WHATSAPP_ACCESS_TOKEN = saved;
    }
    const row = (await q(`SELECT status, error_json->>'code' AS code FROM outbound_messages WHERE id = $1`, [o.outboundId]))[0];
    expect(row).toEqual({ status: "failed", code: "CHANNEL_NOT_CONFIGURED" });
  });

  it("an interrupted send is not repeated automatically", async () => {
    const conv = (await q(`SELECT id FROM conversations LIMIT 1`))[0].id;
    await q(`DELETE FROM consent_events`);
    const o = await db.withTx((tx) =>
      ch.queueOutbound(tx, boss, { tenantId, conversationId: conv, dedupeKey: "crash-test", origin: "human", payload: { kind: "text", text: "hello" } }),
    );
    await q(`UPDATE outbound_messages SET status = 'sending' WHERE id = $1`, [o.outboundId]);
    const before = sent.length;
    await ch.handleSendJob({ outbound_id: o.outboundId!, tenant_id: tenantId }, { apiVersion: "v23.0", graphFactory: fakeGraph });
    expect(sent.length).toBe(before);
    const row = (await q(`SELECT status, error_json->>'code' AS code FROM outbound_messages WHERE id = $1`, [o.outboundId]))[0];
    expect(row).toEqual({ status: "failed", code: "UNCERTAIN_SEND" });
  });
});
