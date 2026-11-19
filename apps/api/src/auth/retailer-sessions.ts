// Sessions for the customer app (apps/shop). Separate cookie and table from staff sessions: a
// retailer session can only ever reach the /v1/app routes, and only that retailer's own data.
//
// A shop may buy from several dealers. One cookie (token) has one retailer_sessions row per dealer
// it is linked to, and each link was proven with that dealer's own access code. Every dealer-scoped
// route goes through dealerOf(), which only returns a dealer this token is linked to.
import type { FastifyReply, FastifyRequest } from "fastify";
import { getPool } from "@fmcg/db";
import { notFound, unauthenticated } from "../lib/errors";
import { newToken, sha256 } from "./sessions";

export const RETAILER_COOKIE = "fmcg_retailer";
/** Shop owners stay signed in on their phone; a new access code signs every device out. */
export const RETAILER_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** The shop as one dealer knows it. */
export interface RetailerSession {
  retailerId: string;
  tenantId: string;
  tenantName: string;
  shopName: string;
  contactName: string | null;
  phone: string;
  tokenHash: string;
}

/** Everyone this phone is signed in with, oldest link first. */
export interface RetailerAccount {
  tokenHash: string;
  phone: string;
  dealers: RetailerSession[];
}

/** A new sign-in on this phone with one dealer. Returns the session's key (the token's hash). */
export async function createRetailerSession(tenantId: string, retailerId: string, req: FastifyRequest, reply: FastifyReply, secureCookie: boolean): Promise<string> {
  const token = newToken();
  const tokenHash = sha256(token);
  const expires = new Date(Date.now() + RETAILER_SESSION_TTL_MS);
  await getPool().query(`INSERT INTO retailer_sessions (token_hash, tenant_id, retailer_id, expires_at, user_agent) VALUES ($1,$2,$3,$4,$5)`, [
    tokenHash,
    tenantId,
    retailerId,
    expires,
    String(req.headers["user-agent"] ?? "").slice(0, 300),
  ]);
  reply.setCookie(RETAILER_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: secureCookie, path: "/", expires });
  return tokenHash;
}

/** Adds a dealer to this phone's sign-in (the caller has checked that dealer's code). */
export async function linkDealer(a: RetailerAccount, tenantId: string, retailerId: string, req: FastifyRequest): Promise<void> {
  await getPool().query(
    `INSERT INTO retailer_sessions (token_hash, tenant_id, retailer_id, expires_at, user_agent)
     SELECT $1, $2, $3, max(expires_at), $4 FROM retailer_sessions WHERE token_hash = $1
     ON CONFLICT (token_hash, tenant_id) DO UPDATE SET retailer_id = EXCLUDED.retailer_id`,
    [a.tokenHash, tenantId, retailerId, String(req.headers["user-agent"] ?? "").slice(0, 300)],
  );
}

export async function unlinkDealer(a: RetailerAccount, tenantId: string): Promise<void> {
  await getPool().query(`DELETE FROM retailer_sessions WHERE token_hash = $1 AND tenant_id = $2`, [a.tokenHash, tenantId]);
}

/**
 * The signed-in phone and its dealers. A dealer that disconnected the shop, or removed or renewed
 * its app access, drops out; with no dealer left the phone is signed out.
 */
export async function requireAccount(req: FastifyRequest): Promise<RetailerAccount> {
  const token = req.cookies?.[RETAILER_COOKIE];
  if (!token) throw unauthenticated();
  const a = await loadAccount(sha256(token));
  if (!a) throw unauthenticated();
  return a;
}

export async function loadAccount(tokenHash: string): Promise<RetailerAccount | null> {
  const r = await getPool().query<{ retailer_id: string; tenant_id: string; tenant_name: string; shop_name: string; contact_name: string | null; phone_e164: string }>(
    `SELECT s.retailer_id, s.tenant_id, t.name AS tenant_name, r.shop_name, r.contact_name, r.phone_e164
       FROM retailer_sessions s
       JOIN retailers r ON r.tenant_id = s.tenant_id AND r.id = s.retailer_id AND r.active AND r.app_code_hash IS NOT NULL
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
      ORDER BY s.created_at, t.name`,
    [tokenHash],
  );
  if (!r.rows.length) return null;
  void getPool()
    .query(`UPDATE retailer_sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '5 minutes'`, [tokenHash])
    .catch(() => undefined);
  const dealers = r.rows.map((row) => ({
    retailerId: row.retailer_id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    shopName: row.shop_name,
    contactName: row.contact_name,
    phone: row.phone_e164,
    tokenHash,
  }));
  return { tokenHash, phone: dealers[0]!.phone, dealers };
}

/** One dealer of this phone; any other id (another dealer's, made up) is "not found". */
export function dealerOf(a: RetailerAccount, tenantId: string): RetailerSession {
  const d = a.dealers.find((x) => x.tenantId === tenantId);
  if (!d) throw notFound("Dealer");
  return d;
}

export async function destroyRetailerSession(tokenHash: string): Promise<void> {
  await getPool().query(`DELETE FROM retailer_sessions WHERE token_hash = $1`, [tokenHash]);
}
