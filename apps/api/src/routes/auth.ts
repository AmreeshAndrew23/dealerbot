import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPool, withTx, writeAudit } from "@fmcg/db";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/password";
import { permissionsFor, type Role } from "../auth/permissions";
import { createSession, destroySession, sha256, SESSION_COOKIE } from "../auth/sessions";
import { requireStaff } from "../auth/plugin";
import { ApiError, badRequest, forbidden, notFound } from "../lib/errors";
import { parse } from "../lib/validate";

// Simple in-process brute-force guard: 8 failures per email+IP per 15 minutes.
const failures = new Map<string, { n: number; until: number }>();
const WINDOW = 15 * 60 * 1000;
function checkThrottle(key: string) {
  const f = failures.get(key);
  if (f && f.until > Date.now() && f.n >= 8) throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Try again in 15 minutes.");
}
function recordFailure(key: string) {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) failures.set(key, { n: 1, until: Date.now() + WINDOW });
  else f.n++;
}

export async function describeMe(userId: string, tenantId: string, role: Role) {
  const r = await getPool().query<{ id: string; name: string; timezone: string; role: Role; email: string; display_name: string }>(
    `SELECT t.id, t.name, t.timezone, m.role, u.email, u.display_name
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.active ORDER BY t.name`,
    [userId],
  );
  const current = r.rows.find((x) => x.id === tenantId);
  const u = r.rows[0];
  return {
    user: { id: userId, email: u?.email, display_name: u?.display_name },
    tenant: current ? { id: current.id, name: current.name, timezone: current.timezone } : null,
    role,
    permissions: permissionsFor(role),
    tenants: r.rows.map((x) => ({ id: x.id, name: x.name, role: x.role })),
  };
}

export const authRoutes: FastifyPluginAsync<{ secureCookie: boolean }> = async (app, { secureCookie }) => {
  const throttleKey = (req: FastifyRequest, email: string) => `${email.toLowerCase()}|${req.ip}`;

  app.post("/v1/auth/login", async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1), tenant_id: z.string().uuid().optional() }), req.body);
    const key = throttleKey(req, body.email);
    checkThrottle(key);
    const u = (
      await getPool().query<{ id: string; password_hash: string | null }>(
        `SELECT id, password_hash FROM users WHERE lower(email) = lower($1) AND active`,
        [body.email],
      )
    ).rows[0];
    // Always run a hash comparison so timing does not reveal whether the email exists.
    const ok = await verifyPassword(body.password, u?.password_hash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
    if (!u || !ok) {
      recordFailure(key);
      throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    const m = (
      await getPool().query<{ tenant_id: string; role: Role }>(
        `SELECT tenant_id, role FROM memberships WHERE user_id = $1 AND active ORDER BY (tenant_id = $2) DESC, created_at`,
        [u.id, body.tenant_id ?? null],
      )
    ).rows[0];
    if (!m) throw forbidden("Your account is not active for any distributor.");
    failures.delete(key);
    await createSession(u.id, m.tenant_id, req, reply, secureCookie);
    await withTx((tx) =>
      writeAudit(tx, { tenant_id: m.tenant_id, actor_type: "user", actor_id: u.id, action: "auth.login", entity_type: "user", entity_id: u.id }),
    );
    return describeMe(u.id, m.tenant_id, m.role);
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    if (req.staff) await destroySession(req.staff.tokenHash);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/auth/me", async (req) => {
    const s = requireStaff(req);
    return describeMe(s.userId, s.tenantId, s.role);
  });

  app.post("/v1/auth/switch-tenant", async (req, reply) => {
    const s = requireStaff(req);
    const body = parse(z.object({ tenant_id: z.string().uuid() }), req.body);
    const m = (
      await getPool().query<{ role: Role }>(`SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = $2 AND active`, [s.userId, body.tenant_id])
    ).rows[0];
    if (!m) throw notFound("Distributor");
    await destroySession(s.tokenHash);
    await createSession(s.userId, body.tenant_id, req, reply, secureCookie);
    return describeMe(s.userId, body.tenant_id, m.role);
  });

  // Public: shows who an invitation is for, so the accept page can greet the person.
  app.get("/v1/auth/invitations/:token", async (req) => {
    const { token } = req.params as { token: string };
    const r = await getPool().query<{ email: string; role: Role; tenant_name: string }>(
      `SELECT i.email, i.role, t.name AS tenant_name FROM invitations i JOIN tenants t ON t.id = i.tenant_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`,
      [sha256(token)],
    );
    const i = r.rows[0];
    if (!i) throw notFound("Invitation");
    const exists = (await getPool().query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [i.email])).rowCount;
    return { email: i.email, role: i.role, tenant_name: i.tenant_name, existing_user: Boolean(exists) };
  });

  app.post("/v1/auth/accept-invite", async (req, reply) => {
    const body = parse(
      z.object({ token: z.string().min(10), password: z.string(), display_name: z.string().trim().min(1).max(100).optional() }),
      req.body,
    );
    const result = await withTx(async (tx) => {
      const inv = (
        await tx.query<{ id: string; tenant_id: string; email: string; role: Role }>(
          `SELECT id, tenant_id, email, role FROM invitations
            WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`,
          [sha256(body.token)],
        )
      ).rows[0];
      if (!inv) throw notFound("Invitation");
      let user = (
        await tx.query<{ id: string; password_hash: string | null }>(`SELECT id, password_hash FROM users WHERE lower(email) = lower($1)`, [inv.email])
      ).rows[0];
      if (user) {
        if (!(await verifyPassword(body.password, user.password_hash))) {
          throw new ApiError(401, "INVALID_CREDENTIALS", "You already have an account: enter your existing password.");
        }
      } else {
        const problem = passwordProblem(body.password);
        if (problem) throw badRequest(problem);
        if (!body.display_name) throw badRequest("Your name is required.");
        user = (
          await tx.query<{ id: string; password_hash: string | null }>(
            `INSERT INTO users (auth_subject, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, password_hash`,
            [`local:${inv.email.toLowerCase()}`, inv.email, body.display_name, await hashPassword(body.password)],
          )
        ).rows[0]!;
      }
      await tx.query(
        `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true, updated_at = now()`,
        [inv.tenant_id, user.id, inv.role],
      );
      await tx.query(`UPDATE invitations SET accepted_at = now() WHERE id = $1`, [inv.id]);
      await writeAudit(tx, {
        tenant_id: inv.tenant_id,
        actor_type: "user",
        actor_id: user.id,
        action: "invitation.accepted",
        entity_type: "invitation",
        entity_id: inv.id,
        details: { role: inv.role },
      });
      return { userId: user.id, tenantId: inv.tenant_id, role: inv.role };
    });
    await createSession(result.userId, result.tenantId, req, reply, secureCookie);
    return describeMe(result.userId, result.tenantId, result.role);
  });
};
