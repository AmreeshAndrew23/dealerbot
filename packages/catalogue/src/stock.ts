// Stock levels (catalogue module). Quantities are in base units (PCS). No row = not tracked.
// Every change is a stock_movements row (append-only) written in the same transaction.
import type { Tx } from "@fmcg/db";

export type Actor = { type: "user" | "system"; id: string | null };

export class StockShortError extends Error {
  constructor(readonly short: Array<{ sku: string; name: string; needed: number; available: number }>) {
    super("Not enough stock");
  }
}

async function skuRow(tx: Tx, tenantId: string, skuId: string) {
  return (await tx.query<{ id: string }>(`SELECT id FROM skus WHERE tenant_id = $1 AND id = $2`, [tenantId, skuId])).rows[0];
}

/**
 * Staff change: "set" the available count, "add" received stock, or "untrack" (unlimited).
 * Returns the new level (null = not tracked).
 */
export async function changeStock(
  tx: Tx,
  tenantId: string,
  skuId: string,
  change: { mode: "set" | "add" | "untrack"; quantity?: number; note?: string },
  actor: Actor,
): Promise<number | null> {
  if (!(await skuRow(tx, tenantId, skuId))) throw new Error("Unknown product");
  const cur = (await tx.query<{ available: string }>(`SELECT available FROM stock_levels WHERE tenant_id = $1 AND sku_id = $2 FOR UPDATE`, [tenantId, skuId])).rows[0];
  const log = (kind: string, quantity: number, balance: number | null) =>
    tx.query(
      `INSERT INTO stock_movements (tenant_id, sku_id, kind, quantity, balance_after, note, actor_type, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, skuId, kind, quantity, balance, change.note ?? null, actor.type, actor.id],
    );
  if (change.mode === "untrack") {
    if (!cur) return null;
    await tx.query(`DELETE FROM stock_levels WHERE tenant_id = $1 AND sku_id = $2`, [tenantId, skuId]);
    await log("UNTRACK", 0, null);
    return null;
  }
  const q = change.quantity ?? NaN;
  if (!Number.isFinite(q) || q < 0 || (change.mode === "add" && q === 0)) throw new Error("Quantity must be a positive number");
  const next = change.mode === "set" ? q : Number(cur?.available ?? 0) + q;
  await tx.query(
    `INSERT INTO stock_levels (tenant_id, sku_id, available) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, sku_id) DO UPDATE SET available = EXCLUDED.available, updated_at = now()`,
    [tenantId, skuId, next],
  );
  await log(change.mode === "set" ? "SET" : "RECEIVE", q, next);
  return next;
}

/**
 * Deducts an order's quantities, all or nothing. Rows are locked in a fixed order, so two retailers
 * confirming the last case at the same moment cannot both get it.
 */
export async function reserveStock(tx: Tx, tenantId: string, orderId: string, needs: Array<{ sku_id: string; sku: string; name: string; base_qty: number }>): Promise<void> {
  const bySku = new Map<string, { sku: string; name: string; qty: number }>();
  for (const n of needs) {
    const e = bySku.get(n.sku_id);
    bySku.set(n.sku_id, { sku: n.sku, name: n.name, qty: (e?.qty ?? 0) + n.base_qty });
  }
  const ids = [...bySku.keys()].sort();
  const levels = await tx.query<{ sku_id: string; available: string }>(
    `SELECT sku_id, available FROM stock_levels WHERE tenant_id = $1 AND sku_id = ANY($2) ORDER BY sku_id FOR UPDATE`,
    [tenantId, ids],
  );
  const short: StockShortError["short"] = [];
  for (const l of levels.rows) {
    const need = bySku.get(l.sku_id)!;
    if (Number(l.available) < need.qty) short.push({ sku: need.sku, name: need.name, needed: need.qty, available: Number(l.available) });
  }
  if (short.length) throw new StockShortError(short);
  for (const l of levels.rows) {
    const need = bySku.get(l.sku_id)!;
    const after = Number(l.available) - need.qty;
    await tx.query(`UPDATE stock_levels SET available = $3, updated_at = now() WHERE tenant_id = $1 AND sku_id = $2`, [tenantId, l.sku_id, after]);
    await tx.query(
      `INSERT INTO stock_movements (tenant_id, sku_id, kind, quantity, balance_after, order_id, actor_type) VALUES ($1,$2,'ORDER',$3,$4,$5,'system')`,
      [tenantId, l.sku_id, -need.qty, after, orderId],
    );
  }
}

/** Gives back exactly what this order took (rejected or cancelled before reaching Tally). */
export async function releaseStock(tx: Tx, tenantId: string, orderId: string, actor: Actor): Promise<void> {
  const taken = await tx.query<{ sku_id: string; qty: string }>(
    `SELECT sku_id, -sum(quantity) AS qty FROM stock_movements WHERE tenant_id = $1 AND order_id = $2 AND kind IN ('ORDER','RELEASE')
      GROUP BY sku_id HAVING sum(quantity) < 0 ORDER BY sku_id`,
    [tenantId, orderId],
  );
  for (const t of taken.rows) {
    const lvl = await tx.query<{ available: string }>(
      `UPDATE stock_levels SET available = available + $3, updated_at = now() WHERE tenant_id = $1 AND sku_id = $2 RETURNING available`,
      [tenantId, t.sku_id, t.qty],
    );
    // If staff stopped tracking the product meanwhile, there is nothing to give back to.
    await tx.query(
      `INSERT INTO stock_movements (tenant_id, sku_id, kind, quantity, balance_after, order_id, actor_type, actor_id) VALUES ($1,$2,'RELEASE',$3,$4,$5,$6,$7)`,
      [tenantId, t.sku_id, t.qty, lvl.rows[0]?.available ?? null, orderId, actor.type, actor.id],
    );
  }
}

export interface StockMovement {
  at: string;
  kind: string;
  quantity: string;
  balance_after: string | null;
  note: string | null;
  order_number: string | null;
  by: string | null;
}

export async function stockHistory(tx: Tx, skuId: string, limit = 30): Promise<StockMovement[]> {
  const r = await tx.query<StockMovement>(
    `SELECT m.created_at AS at, m.kind, m.quantity, m.balance_after, m.note, o.order_number::text AS order_number,
            coalesce(u.display_name, CASE WHEN m.actor_type = 'system' THEN 'Chat order' END) AS by
       FROM stock_movements m
       LEFT JOIN orders o ON o.tenant_id = m.tenant_id AND o.id = m.order_id
       LEFT JOIN users u ON m.actor_type = 'user' AND u.id::text = m.actor_id
      WHERE m.sku_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
    [skuId, limit],
  );
  return r.rows;
}
