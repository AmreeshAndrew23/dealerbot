// Retailer records (E09, first cut). A WhatsApp number must be recorded here, and active, before the
// assistant shares prices or takes an order from it. Every query runs inside withTenantTx (RLS).
import { z } from "zod";
import type { Tx } from "@fmcg/db";

/**
 * "98765 43210", "+91 98765-43210", "919876543210", "09876543210" -> "+919876543210".
 * Ten digits are taken as an Indian mobile number; anything else needs its country code.
 */
export function normalisePhone(raw: string): string | null {
  const s = raw.trim();
  let d = s.replace(/\D/g, "");
  if (!d) return null;
  if (!s.startsWith("+")) {
    if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    if (d.length === 10) d = "91" + d;
  }
  return /^[1-9]\d{7,14}$/.test(d) ? `+${d}` : null;
}

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v == null || !v.trim() ? null : v.trim()))
    .pipe(z.union([z.string().max(max), z.null()]));

export const RetailerInput = z.object({
  shop_name: z.string().trim().min(1, "Enter the shop name.").max(120),
  contact_name: optionalText(80),
  phone: z
    .string()
    .transform((v, ctx) => {
      const p = normalisePhone(v);
      if (!p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid WhatsApp number (10 digits, or with country code)." });
      return p ?? "";
    }),
  area: optionalText(80),
  notes: optionalText(500),
  active: z.boolean().default(true),
});
export type RetailerInput = z.infer<typeof RetailerInput>;

export interface Retailer {
  id: string;
  shop_name: string;
  contact_name: string | null;
  phone: string;
  area: string | null;
  notes: string | null;
  active: boolean;
  /** The retailer can sign in to the customer app (an access code has been created). */
  app_access: boolean;
  app_code_set_at: string | null;
  orders: number;
  last_order_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `
  SELECT r.id, r.shop_name, r.contact_name, r.phone_e164 AS phone, r.area, r.notes, r.active, r.created_at, r.updated_at,
         (r.app_code_hash IS NOT NULL) AS app_access, r.app_code_set_at,
         (SELECT count(*)::int FROM orders o WHERE o.tenant_id = r.tenant_id AND o.retailer_id = r.id) AS orders,
         (SELECT max(o.confirmed_at) FROM orders o WHERE o.tenant_id = r.tenant_id AND o.retailer_id = r.id) AS last_order_at
    FROM retailers r`;

export async function listRetailers(tx: Tx): Promise<Retailer[]> {
  return (await tx.query<Retailer>(`${SELECT} ORDER BY r.active DESC, lower(r.shop_name), r.created_at`)).rows;
}

export async function getRetailer(tx: Tx, id: string): Promise<Retailer | null> {
  return (await tx.query<Retailer>(`${SELECT} WHERE r.id = $1`, [id])).rows[0] ?? null;
}

/** The retailer who owns this number, if any (active or not: the caller decides). */
export async function findRetailerByPhone(tx: Tx, phone: string): Promise<Retailer | null> {
  const p = normalisePhone(phone);
  if (!p) return null;
  return (await tx.query<Retailer>(`${SELECT} WHERE r.phone_e164 = $1`, [p])).rows[0] ?? null;
}

export async function insertRetailer(tx: Tx, tenantId: string, r: RetailerInput, userId: string | null): Promise<Retailer> {
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO retailers (tenant_id, shop_name, contact_name, phone_e164, area, notes, active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [tenantId, r.shop_name, r.contact_name, r.phone, r.area, r.notes, r.active, userId],
  );
  return (await getRetailer(tx, ins.rows[0]!.id))!;
}

export async function updateRetailer(tx: Tx, id: string, r: RetailerInput): Promise<Retailer | null> {
  const u = await tx.query(
    `UPDATE retailers SET shop_name = $2, contact_name = $3, phone_e164 = $4, area = $5, notes = $6, active = $7, updated_at = now()
      WHERE id = $1`,
    [id, r.shop_name, r.contact_name, r.phone, r.area, r.notes, r.active],
  );
  return u.rowCount ? getRetailer(tx, id) : null;
}

/**
 * Customer app access. hash = the hashed access code, or null to remove access. Either way every
 * device signed in with the old code is signed out.
 */
export async function setAppCode(tx: Tx, id: string, hash: string | null): Promise<Retailer | null> {
  const u = await tx.query(
    `UPDATE retailers SET app_code_hash = $2, app_code_set_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
            app_failed_attempts = 0, app_locked_until = NULL, updated_at = now()
      WHERE id = $1`,
    [id, hash],
  );
  if (!u.rowCount) return null;
  await tx.query(`DELETE FROM retailer_sessions WHERE retailer_id = $1`, [id]);
  return getRetailer(tx, id);
}

/** Field-by-field changes for the audit log. */
export function diffRetailer(a: Retailer, b: RetailerInput): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const pairs: Array<[string, unknown, unknown]> = [
    ["shop_name", a.shop_name, b.shop_name],
    ["contact_name", a.contact_name, b.contact_name],
    ["phone", a.phone, b.phone],
    ["area", a.area, b.area],
    ["notes", a.notes, b.notes],
    ["active", a.active, b.active],
  ];
  for (const [k, from, to] of pairs) if (from !== to) out[k] = { from, to };
  return out;
}
