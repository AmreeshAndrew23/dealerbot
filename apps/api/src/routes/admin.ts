// Platform admin API (/v1/admin): the people who run this service add dealers (tenants), invite
// each dealer's first owner, rename dealers and suspend or reactivate them. Admin sessions only
// (cookie fmcg_admin); queries run in system mode because an admin sees every dealer.
// The admin never sets a dealer password: the owner opens a one-time invite link in the staff
// dashboard (/accept-invite) and chooses their own.
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPool, withTx, writeAudit, type Tx } from "@fmcg/db";
import { verifyPassword } from "../auth/password";
import { ADMIN_COOKIE, createAdminSession, destroyAdminSession, requireAdmin } from "../auth/admin-sessions";
import { newToken, sha256 } from "../auth/sessions";
import { ApiError, notFound } from "../lib/errors";
import { parse } from "../lib/validate";

const INVITE_TTL_DAYS = 7;
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";

// 8 failures per email+IP per 15 minutes, as for staff sign-in.
const failures = new Map<string, { n: number; until: number }>();
const WINDOW = 15 * 60 * 1000;

const Id = z.object({ id: z.string().uuid() });
const Name = z.string().trim().min(2, "Dealer name is too short.").max(100);
const Email = z.string().trim().email("Enter a valid email address.").max(200);

const audit = (tx: Tx, adminId: string, tenantId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown> = {}) =>
  writeAudit(tx, { tenant_id: tenantId, actor_type: "platform_admin", actor_id: adminId, action, entity_type: entityType, entity_id: entityId, details });

/** A one-time OWNER invite for the dealer; any older unused invite for that email is replaced. */
async function inviteOwner(tx: Tx, adminId: string, tenantId: string, email: string) {
  const owner = await tx.query(
    `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND lower(u.email) = lower($2) AND m.active AND m.role = 'OWNER'`,
    [tenantId, email],
  );
  if (owner.rowCount) throw new ApiError(409, "ALREADY_MEMBER", "This person is already an owner of this dealer.");
  await tx.query(`DELETE FROM invitations WHERE tenant_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL`, [tenantId, email]);
  const token = newToken();
  const inv = (
    await tx.query<{ id: string; expires_at: Date }>(
      `INSERT INTO invitations (tenant_id, email, role, token_hash, created_by_admin, expires_at)
       VALUES ($1,$2,'OWNER',$3,$4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
      [tenantId, email, sha256(token), adminId, INVITE_TTL_DAYS],
    )
  ).rows[0]!;
  await audit(tx, adminId, tenantId, "invitation.created", "invitation", inv.id, { email, role: "OWNER", by_platform_admin: true });
  // The token is shown once (to the admin, who sends the link); only its hash is stored.
  return { id: inv.id, email, role: "OWNER" as const, expires_at: inv.expires_at, accept_path: `/accept-invite?token=${token}` };
}

async function dealerDetail(id: string) {
  const pool = getPool();
  const t = (
    await pool.query(
      `SELECT id, name, status, suspended_at, suspended_reason, created_at, updated_at,
              (SELECT count(*)::int FROM retailers r WHERE r.tenant_id = t.id AND r.active) AS retailers,
              (SELECT count(*)::int FROM skus s WHERE s.tenant_id = t.id AND s.active) AS products,
              (SELECT count(*)::int FROM orders o WHERE o.tenant_id = t.id) AS orders
         FROM tenants t WHERE id = $1`,
      [id],
    )
  ).rows[0];
  if (!t) throw notFound("Dealer");
  const staff = await pool.query(
    `SELECT u.id, u.email, u.display_name, m.role, m.active,
            (SELECT max(last_seen_at) FROM sessions se WHERE se.user_id = u.id AND se.tenant_id = m.tenant_id) AS last_seen_at
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1
      ORDER BY m.active DESC, (m.role = 'OWNER') DESC, u.display_name`,
    [id],
  );
  const invites = await pool.query(
    `SELECT id, email, role, expires_at, created_at FROM invitations
      WHERE tenant_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [id],
  );
  return { ...t, staff: staff.rows, invitations: invites.rows };
}

export const adminRoutes: FastifyPluginAsync<{ secureCookie: boolean }> = async (app, { secureCookie }) => {
  const throttleKey = (req: FastifyRequest, email: string) => `${email.toLowerCase()}|${req.ip}`;

  app.post("/v1/admin/login", async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().email(), password: z.string().min(1) }), req.body);
    const key = throttleKey(req, body.email);
    const f = failures.get(key);
    if (f && f.until > Date.now() && f.n >= 8) throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Try again in 15 minutes.");
    const a = (
      await getPool().query<{ id: string; email: string; display_name: string; password_hash: string }>(
        `SELECT id, email, display_name, password_hash FROM platform_admins WHERE lower(email) = lower($1) AND active`,
        [body.email],
      )
    ).rows[0];
    // Always compare a hash so timing does not reveal whether the email exists.
    const ok = await verifyPassword(body.password, a?.password_hash ?? DUMMY_HASH);
    if (!a || !ok) {
      if (!f || f.until < Date.now()) failures.set(key, { n: 1, until: Date.now() + WINDOW });
      else f.n++;
      throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    failures.delete(key);
    await createAdminSession(a.id, req, reply, secureCookie);
    await withTx((tx) => writeAudit(tx, { tenant_id: null, actor_type: "platform_admin", actor_id: a.id, action: "admin.login", entity_type: "platform_admin", entity_id: a.id }));
    return { admin: { id: a.id, email: a.email, display_name: a.display_name } };
  });

  app.post("/v1/admin/logout", async (req, reply) => {
    const token = req.cookies?.[ADMIN_COOKIE];
    if (token) await destroyAdminSession(sha256(token));
    reply.clearCookie(ADMIN_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/admin/me", async (req) => {
    const s = await requireAdmin(req);
    return { admin: { id: s.adminId, email: s.email, display_name: s.displayName } };
  });

  app.get("/v1/admin/dealers", async (req) => {
    await requireAdmin(req);
    const r = await getPool().query(
      `SELECT t.id, t.name, t.status, t.suspended_at, t.created_at,
              (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.active) AS staff,
              (SELECT count(*)::int FROM retailers r WHERE r.tenant_id = t.id AND r.active) AS retailers,
              (SELECT coalesce(json_agg(u.email ORDER BY u.email), '[]'::json)
                 FROM memberships m JOIN users u ON u.id = m.user_id
                WHERE m.tenant_id = t.id AND m.active AND m.role = 'OWNER') AS owners,
              (SELECT i.email FROM invitations i
                WHERE i.tenant_id = t.id AND i.role = 'OWNER' AND i.accepted_at IS NULL AND i.expires_at > now()
                ORDER BY i.created_at DESC LIMIT 1) AS pending_owner
         FROM tenants t ORDER BY lower(t.name)`,
    );
    return { dealers: r.rows };
  });

  app.get("/v1/admin/dealers/:id", async (req) => {
    await requireAdmin(req);
    return dealerDetail(parse(Id, req.params).id);
  });

  /** A new dealer and a one-time invite link for its first owner. */
  app.post("/v1/admin/dealers", async (req, reply) => {
    const s = await requireAdmin(req);
    const body = parse(z.object({ name: Name, owner_email: Email }), req.body);
    const out = await withTx(async (tx) => {
      // One lock for all dealer creation, so two admins cannot add the same name at once.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('platform.create_dealer'))`);
      const dup = await tx.query(`SELECT 1 FROM tenants WHERE lower(name) = lower($1)`, [body.name]);
      if (dup.rowCount) throw new ApiError(409, "DEALER_EXISTS", "A dealer with this name already exists.");
      const t = (await tx.query<{ id: string; name: string }>(`INSERT INTO tenants (name) VALUES ($1) RETURNING id, name`, [body.name])).rows[0]!;
      await audit(tx, s.adminId, t.id, "tenant.created", "tenant", t.id, { name: t.name });
      const invite = await inviteOwner(tx, s.adminId, t.id, body.owner_email);
      return { dealer: t, invite };
    });
    reply.status(201);
    return out;
  });

  /** Rename, suspend (with an optional reason) or reactivate a dealer. */
  app.patch("/v1/admin/dealers/:id", async (req) => {
    const s = await requireAdmin(req);
    const { id } = parse(Id, req.params);
    const body = parse(
      z
        .object({ name: Name.optional(), status: z.enum(["active", "suspended"]).optional(), reason: z.string().trim().max(300).optional() })
        .refine((b) => b.name !== undefined || b.status !== undefined, "Nothing to change."),
      req.body,
    );
    await withTx(async (tx) => {
      const cur = (await tx.query<{ name: string; status: string }>(`SELECT name, status FROM tenants WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound("Dealer");
      if (body.name !== undefined && body.name !== cur.name) {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('platform.create_dealer'))`);
        const dup = await tx.query(`SELECT 1 FROM tenants WHERE lower(name) = lower($1) AND id <> $2`, [body.name, id]);
        if (dup.rowCount) throw new ApiError(409, "DEALER_EXISTS", "A dealer with this name already exists.");
        await tx.query(`UPDATE tenants SET name = $2, updated_at = now() WHERE id = $1`, [id, body.name]);
        await audit(tx, s.adminId, id, "tenant.renamed", "tenant", id, { from: cur.name, to: body.name });
      }
      if (body.status === "suspended" && cur.status !== "suspended") {
        await tx.query(`UPDATE tenants SET status = 'suspended', suspended_at = now(), suspended_reason = $2, updated_at = now() WHERE id = $1`, [id, body.reason || null]);
        await audit(tx, s.adminId, id, "tenant.suspended", "tenant", id, { reason: body.reason || null });
      } else if (body.status === "active" && cur.status !== "active") {
        await tx.query(`UPDATE tenants SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = now() WHERE id = $1`, [id]);
        await audit(tx, s.adminId, id, "tenant.reactivated", "tenant", id);
      }
    });
    return dealerDetail(id);
  });

  /** A new owner invite link (the first one expired or was lost, or a second owner). */
  app.post("/v1/admin/dealers/:id/invitations", async (req, reply) => {
    const s = await requireAdmin(req);
    const { id } = parse(Id, req.params);
    const { email } = parse(z.object({ email: Email }), req.body);
    const invite = await withTx(async (tx) => {
      const t = (await tx.query(`SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, [id])).rowCount;
      if (!t) throw notFound("Dealer");
      return inviteOwner(tx, s.adminId, id, email);
    });
    reply.status(201);
    return invite;
  });

  app.delete("/v1/admin/dealers/:id/invitations/:inv", async (req) => {
    const s = await requireAdmin(req);
    const { id, inv } = parse(z.object({ id: z.string().uuid(), inv: z.string().uuid() }), req.params);
    await withTx(async (tx) => {
      const r = await tx.query(`DELETE FROM invitations WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL`, [inv, id]);
      if (!r.rowCount) throw notFound("Invitation");
      await audit(tx, s.adminId, id, "invitation.revoked", "invitation", inv, { by_platform_admin: true });
    });
    return { ok: true };
  });
};
