import type { Tx } from "@fmcg/db";

/** The named distributor, or the only one when there is exactly one. */
export async function resolveTenant(tx: Tx, name?: string): Promise<{ id: string; name: string }> {
  const rows = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM tenants ${name ? "WHERE name = $1" : ""} ORDER BY created_at`, name ? [name] : [])).rows;
  if (name && !rows[0]) throw new Error(`No distributor named "${name}".`);
  if (!rows[0]) throw new Error("No distributor yet. Create one with pnpm user:create.");
  if (rows.length > 1) throw new Error(`Several distributors exist; pass --tenant with one of: ${rows.map((r) => r.name).join(", ")}`);
  return rows[0];
}
