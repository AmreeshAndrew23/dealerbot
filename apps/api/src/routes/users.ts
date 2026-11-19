import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withTenantTx, writeAudit } from "@fmcg/db";
import { requireStaff } from "../auth/plugin";
import { newToken, sha256 } from "../auth/sessions";
import { ApiError, notFound } from "../lib/errors";
import { parse } from "../lib/validate";

const RoleEnum = z.enum(["OWNER", "OPERATOR", "VIEWER"]);
const INVITE_TTL_DAYS = 7;

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/users", async (req) => {
    const s = requireStaff(req, "users.manage");
    return withTenantTx(s.tenantId, async (tx) => {
      const members = await tx.query(
        `SELECT u.id, u.email, u.display_name, m.role, m.active, m.created_at,
                (SELECT max(last_seen_at) FROM sessions se WHERE se.user_id = u.id AND se.tenant_id = m.tenant_id) AS last_seen_at
           FROM memberships m JOIN users u ON u.id = m.user_id
          ORDER BY m.active DESC, u.display_name`,
      );
      const invites = await tx.query(
        `SELECT id, email, role, expires_at, created_at FROM invitations
          WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      );
      return { users: members.rows, invitations: invites.rows };
    });
  });

  app.post("/v1/users/invitations", async (req, reply) => {
    const s = requireStaff(req, "users.manage");
    const body = parse(z.object({ email: z.string().trim().email().max(200), role: RoleEnum }), req.body);
    const token = newToken();
    const inv = await withTenantTx(s.tenantId, async (tx) => {
      const already = await tx.query(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE lower(u.email) = lower($1) AND m.active`,
        [body.email],
      );
      if (already.rowCount) throw new ApiError(409, "ALREADY_MEMBER", "This person already has access.");
      await tx.query(`DELETE FROM invitations WHERE lower(email) = lower($1) AND accepted_at IS NULL`, [body.email]);
      const r = await tx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO invitations (tenant_id, email, role, token_hash, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6)) RETURNING id, expires_at`,
        [s.tenantId, body.email, body.role, sha256(token), s.userId, INVITE_TTL_DAYS],
      );
      await writeAudit(tx, {
        tenant_id: s.tenantId,
        actor_type: "user",
        actor_id: s.userId,
        action: "invitation.created",
        entity_type: "invitation",
        entity_id: r.rows[0]!.id,
        details: { email: body.email, role: body.role },
      });
      return r.rows[0]!;
    });
    // The token is shown once; only its hash is stored. Email delivery can be added later.
    reply.status(201);
    return { id: inv.id, email: body.email, role: body.role, expires_at: inv.expires_at, accept_path: `/accept-invite?token=${token}` };
  });

  app.delete("/v1/users/invitations/:id", async (req) => {
    const s = requireStaff(req, "users.manage");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await withTenantTx(s.tenantId, async (tx) => {
      const r = await tx.query(`DELETE FROM invitations WHERE id = $1 AND accepted_at IS NULL`, [id]);
      if (!r.rowCount) throw notFound("Invitation");
      await writeAudit(tx, { tenant_id: s.tenantId, actor_type: "user", actor_id: s.userId, action: "invitation.revoked", entity_type: "invitation", entity_id: id });
    });
    return { ok: true };
  });

  app.patch("/v1/users/:id", async (req) => {
    const s = requireStaff(req, "users.manage");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ role: RoleEnum.optional(), active: z.boolean().optional() }).refine((b) => b.role || b.active !== undefined), req.body);
    return withTenantTx(s.tenantId, async (tx) => {
      const cur = (await tx.query<{ role: string; active: boolean }>(`SELECT role, active FROM memberships WHERE user_id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound("User");
      const nextRole = body.role ?? cur.role;
      const nextActive = body.active ?? cur.active;
      if (cur.role === "OWNER" && cur.active && (nextRole !== "OWNER" || !nextActive)) {
        const owners = await tx.query(`SELECT count(*)::int AS n FROM memberships WHERE role = 'OWNER' AND active`);
        if (owners.rows[0].n <= 1) throw new ApiError(409, "LAST_OWNER", "There must be at least one active owner.");
      }
      await tx.query(`UPDATE memberships SET role = $2, active = $3, updated_at = now() WHERE user_id = $1`, [id, nextRole, nextActive]);
      if (!nextActive) await tx.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      await writeAudit(tx, {
        tenant_id: s.tenantId,
        actor_type: "user",
        actor_id: s.userId,
        action: "membership.updated",
        entity_type: "user",
        entity_id: id,
        details: { from: cur, to: { role: nextRole, active: nextActive } },
      });
      return { id, role: nextRole, active: nextActive };
    });
  });
};
