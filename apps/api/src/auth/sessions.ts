import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getPool } from "@fmcg/db";
import type { Role } from "./permissions";

export const SESSION_COOKIE = "fmcg_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionUser {
  userId: string;
  tenantId: string;
  role: Role;
  displayName: string;
  email: string;
  tokenHash: string;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export async function createSession(
  userId: string,
  tenantId: string,
  req: FastifyRequest,
  reply: FastifyReply,
  secureCookie: boolean,
): Promise<void> {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await getPool().query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sha256(token), userId, tenantId, expires, String(req.headers["user-agent"] ?? "").slice(0, 300), req.ip],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie,
    path: "/",
    expires,
  });
}

/** Loads the session (system mode: the tenant is not known until the session is read). */
export async function loadSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = sha256(token);
  const r = await getPool().query<{
    user_id: string;
    tenant_id: string;
    role: Role;
    display_name: string;
    email: string;
  }>(
    `SELECT s.user_id, s.tenant_id, m.role, u.display_name, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.active
       JOIN memberships m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id AND m.active
       JOIN tenants t ON t.id = s.tenant_id AND t.status = 'active'  -- a suspended dealer signs its staff out
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Touch at most once a minute to avoid a write per request.
  void getPool()
    .query(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '1 minute'`, [tokenHash])
    .catch(() => undefined);
  return { userId: row.user_id, tenantId: row.tenant_id, role: row.role, displayName: row.display_name, email: row.email, tokenHash };
}

export async function destroySession(tokenHash: string): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
}
