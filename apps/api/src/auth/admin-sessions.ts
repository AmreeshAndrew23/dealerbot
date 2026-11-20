// Sessions for the platform admin app (apps/admin, served at /admin/). Separate cookie and table
// from dealer staff and shops: an admin session only ever reaches the /v1/admin routes, and a
// staff or shop cookie never does.
import type { FastifyReply, FastifyRequest } from "fastify";
import { getPool } from "@fmcg/db";
import { unauthenticated } from "../lib/errors";
import { newToken, sha256 } from "./sessions";

export const ADMIN_COOKIE = "fmcg_admin";
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface AdminSession {
  adminId: string;
  email: string;
  displayName: string;
  tokenHash: string;
}

export async function createAdminSession(adminId: string, req: FastifyRequest, reply: FastifyReply, secureCookie: boolean): Promise<void> {
  const token = newToken();
  const expires = new Date(Date.now() + ADMIN_SESSION_TTL_MS);
  await getPool().query(`INSERT INTO platform_admin_sessions (token_hash, admin_id, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5)`, [
    sha256(token),
    adminId,
    expires,
    String(req.headers["user-agent"] ?? "").slice(0, 300),
    req.ip,
  ]);
  reply.setCookie(ADMIN_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: secureCookie, path: "/", expires });
}

export async function requireAdmin(req: FastifyRequest): Promise<AdminSession> {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) throw unauthenticated();
  const tokenHash = sha256(token);
  const row = (
    await getPool().query<{ id: string; email: string; display_name: string }>(
      `SELECT a.id, a.email, a.display_name FROM platform_admin_sessions s JOIN platform_admins a ON a.id = s.admin_id AND a.active
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    )
  ).rows[0];
  if (!row) throw unauthenticated();
  void getPool()
    .query(`UPDATE platform_admin_sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '1 minute'`, [tokenHash])
    .catch(() => undefined);
  return { adminId: row.id, email: row.email, displayName: row.display_name, tokenHash };
}

export async function destroyAdminSession(tokenHash: string): Promise<void> {
  await getPool().query(`DELETE FROM platform_admin_sessions WHERE token_hash = $1`, [tokenHash]);
}
