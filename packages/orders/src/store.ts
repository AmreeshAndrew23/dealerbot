// Orders persistence (architecture 5.1, 6.2). A retailer confirmation creates, in ONE transaction:
// the order (READY_FOR_REVIEW), version 1 with its lines, the confirmation bound to that version's
// summary hash, and an audit event. Versions, lines and confirmations are append-only.
import type { Tx } from "@fmcg/db";
import { writeAudit } from "@fmcg/db";
import { releaseStock, reserveStock } from "@fmcg/catalogue";

export type OrderChannel = "whatsapp" | "whatsapp_test" | "terminal" | "app";

export interface ConfirmedLine {
  sku: string;
  name: string;
  unit: string;
  qty: number;
  base_unit: string;
  base_qty: number;
  rate: string;
  amount: string;
}

export interface NewConfirmedOrder {
  tenantId: string;
  retailerName: string;
  contactPhone?: string | null;
  /** The retailer record the number belongs to (null for terminal tests). */
  retailerId?: string | null;
  conversationId?: string | null;
  channel: OrderChannel;
  summaryHash: string;
  total: string;
  lines: ConfirmedLine[];
  /** The retailer's confirming message, kept as evidence. */
  evidence: string;
}

export const formatOrderNumber = (n: number | string) => `ORD-${String(n).padStart(6, "0")}`;

async function nextNumber(tx: Tx, tenantId: string, name: string): Promise<number> {
  const r = await tx.query<{ last_value: string }>(
    `INSERT INTO tenant_sequences (tenant_id, name, last_value) VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, name) DO UPDATE SET last_value = tenant_sequences.last_value + 1
     RETURNING last_value`,
    [tenantId, name],
  );
  return Number(r.rows[0]!.last_value);
}

export async function createConfirmedOrder(tx: Tx, o: NewConfirmedOrder): Promise<{ id: string; order_number: number; confirmed_at: Date }> {
  if (!o.lines.length) throw new Error("An order needs at least one line");
  const skuId = await skuIds(tx, o.tenantId, o.lines);

  const number = await nextNumber(tx, o.tenantId, "order_number");
  const order = (
    await tx.query<{ id: string; confirmed_at: Date }>(
      `INSERT INTO orders (tenant_id, order_number, status, retailer_name, contact_phone, conversation_id, channel, current_version, confirmed_at, retailer_id)
       VALUES ($1,$2,'READY_FOR_REVIEW',$3,$4,$5,$6,1, now(), $7) RETURNING id, confirmed_at`,
      [o.tenantId, number, o.retailerName, o.contactPhone ?? null, o.conversationId ?? null, o.channel, o.retailerId ?? null],
    )
  ).rows[0]!;
  const version = (
    await tx.query<{ id: string }>(`INSERT INTO order_versions (tenant_id, order_id, version, summary_hash, total) VALUES ($1,$2,1,$3,$4) RETURNING id`, [
      o.tenantId,
      order.id,
      o.summaryHash,
      o.total,
    ])
  ).rows[0]!;
  await insertLines(tx, o.tenantId, version.id, o.lines, skuId);
  // Stock is taken now, in this transaction: two retailers cannot both get the last case.
  // Throws StockShortError (nothing saved) when a tracked product no longer has enough.
  await reserveStock(
    tx,
    o.tenantId,
    order.id,
    o.lines.map((l) => ({ sku_id: skuId.get(l.sku)!, sku: l.sku, name: l.name, base_qty: l.base_qty })),
  );
  await tx.query(`INSERT INTO confirmations (tenant_id, order_version_id, summary_hash, channel, evidence) VALUES ($1,$2,$3,$4,$5)`, [
    o.tenantId,
    version.id,
    o.summaryHash,
    o.channel,
    o.evidence.slice(0, 500),
  ]);
  await writeAudit(tx, {
    tenant_id: o.tenantId,
    actor_type: "system",
    actor_id: o.contactPhone ?? null,
    action: "order.confirmed_by_retailer",
    entity_type: "order",
    entity_id: order.id,
    details: { order_number: formatOrderNumber(number), version: 1, summary_hash: o.summaryHash, total: o.total, to: "READY_FOR_REVIEW" },
  });
  return { id: order.id, order_number: number, confirmed_at: order.confirmed_at };
}

// ---- the retailer changes an order before it is accepted ----------------------------------------

/** The order was accepted, rejected or cancelled meanwhile: it can no longer be changed from chat. */
export class OrderClosedError extends Error {
  constructor(readonly closed: string) {
    super(`The order is ${closed.toLowerCase()} and can no longer be changed`);
  }
}

export interface OrderChange {
  tenantId: string;
  orderId: string;
  /** The order must belong to this retailer (by record, or by number for older orders). */
  retailerId?: string | null;
  contactPhone?: string | null;
  channel: OrderChannel;
  summaryHash: string;
  total: string;
  /** The whole order after the change (not only the new items). */
  lines: ConfirmedLine[];
  evidence: string;
}

/** A retailer's order that staff have not decided on yet, with its current lines (for adding to it). */
export async function openOrderFor(
  tx: Tx,
  retailerId: string | null,
  phone: string | null,
): Promise<{ id: string; order_number: number; lines: ConfirmedLine[] } | null> {
  const o = (
    await tx.query<{ id: string; order_number: number; version_id: string }>(
      `SELECT o.id, o.order_number, v.id AS version_id
         FROM orders o
         JOIN order_versions v ON v.tenant_id = o.tenant_id AND v.order_id = o.id AND v.version = o.current_version
        WHERE o.status = 'READY_FOR_REVIEW'
          AND (($1::uuid IS NOT NULL AND o.retailer_id = $1) OR ($2::text IS NOT NULL AND o.contact_phone = $2))
        ORDER BY o.created_at DESC, o.id DESC LIMIT 1`,
      [retailerId, phone],
    )
  ).rows[0];
  if (!o) return null;
  const lines = await tx.query<{ sku: string; name: string; unit: string; qty: string; base_unit: string; base_qty: string; rate: string; amount: string }>(
    `SELECT sku_code AS sku, name, unit, quantity AS qty, base_unit, base_quantity AS base_qty, unit_price AS rate, amount
       FROM order_lines WHERE order_version_id = $1 ORDER BY line_no`,
    [o.version_id],
  );
  return {
    id: o.id,
    order_number: Number(o.order_number),
    lines: lines.rows.map((l) => ({ ...l, qty: Number(l.qty), base_qty: Number(l.base_qty) })),
  };
}

/**
 * Saves the retailer's change as the next version of the same order, in ONE transaction: new
 * version + lines, the confirmation bound to it, stock re-reserved (the old reservation is given
 * back first), lock_version bumped (a reviewer looking at the old version gets a conflict) and an
 * audit event. Only while the order is READY_FOR_REVIEW; otherwise OrderClosedError.
 */
export async function amendConfirmedOrder(tx: Tx, c: OrderChange): Promise<{ id: string; order_number: number; version: number; confirmed_at: Date }> {
  if (!c.lines.length) throw new Error("An order needs at least one line");
  const o = (
    await tx.query<{ id: string; order_number: number; status: string; current_version: number; total: string }>(
      `SELECT o.id, o.order_number, o.status, o.current_version, v.total
         FROM orders o
         JOIN order_versions v ON v.tenant_id = o.tenant_id AND v.order_id = o.id AND v.version = o.current_version
        WHERE o.tenant_id = $1 AND o.id = $2
          AND (($3::uuid IS NOT NULL AND o.retailer_id = $3) OR ($4::text IS NOT NULL AND o.contact_phone = $4))
        FOR UPDATE OF o`,
      [c.tenantId, c.orderId, c.retailerId ?? null, c.contactPhone ?? null],
    )
  ).rows[0];
  if (!o) throw new Error("Order not found for this retailer");
  if (o.status !== "READY_FOR_REVIEW") throw new OrderClosedError(o.status);

  const skuId = await skuIds(tx, c.tenantId, c.lines);
  const version = o.current_version + 1;
  const v = (
    await tx.query<{ id: string }>(`INSERT INTO order_versions (tenant_id, order_id, version, summary_hash, total) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
      c.tenantId,
      o.id,
      version,
      c.summaryHash,
      c.total,
    ])
  ).rows[0]!;
  await insertLines(tx, c.tenantId, v.id, c.lines, skuId);
  // Give back what the previous version took, then take what this one needs (all or nothing).
  await releaseStock(tx, c.tenantId, o.id, { type: "system", id: c.contactPhone ?? null });
  await reserveStock(
    tx,
    c.tenantId,
    o.id,
    c.lines.map((l) => ({ sku_id: skuId.get(l.sku)!, sku: l.sku, name: l.name, base_qty: l.base_qty })),
  );
  await tx.query(`INSERT INTO confirmations (tenant_id, order_version_id, summary_hash, channel, evidence) VALUES ($1,$2,$3,$4,$5)`, [
    c.tenantId,
    v.id,
    c.summaryHash,
    c.channel,
    c.evidence.slice(0, 500),
  ]);
  const upd = (
    await tx.query<{ confirmed_at: Date }>(
      `UPDATE orders SET current_version = $2, lock_version = lock_version + 1, confirmed_at = now(), updated_at = now() WHERE id = $1 RETURNING confirmed_at`,
      [o.id, version],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    tenant_id: c.tenantId,
    actor_type: "system",
    actor_id: c.contactPhone ?? null,
    action: "order.changed_by_retailer",
    entity_type: "order",
    entity_id: o.id,
    details: { order_number: formatOrderNumber(o.order_number), from_version: o.current_version, version, summary_hash: c.summaryHash, total_before: o.total, total: c.total },
  });
  return { id: o.id, order_number: Number(o.order_number), version, confirmed_at: upd.confirmed_at };
}

async function skuIds(tx: Tx, tenantId: string, lines: ConfirmedLine[]): Promise<Map<string, string>> {
  const skus = await tx.query<{ id: string; sku_code: string }>(`SELECT id, sku_code FROM skus WHERE tenant_id = $1 AND sku_code = ANY($2)`, [
    tenantId,
    lines.map((l) => l.sku),
  ]);
  const skuId = new Map(skus.rows.map((r) => [r.sku_code, r.id]));
  const missing = lines.filter((l) => !skuId.has(l.sku)).map((l) => l.sku);
  if (missing.length) throw new Error(`Unknown SKU(s): ${missing.join(", ")}`);
  return skuId;
}

async function insertLines(tx: Tx, tenantId: string, versionId: string, lines: ConfirmedLine[], skuId: Map<string, string>): Promise<void> {
  await tx.query(
    `INSERT INTO order_lines (tenant_id, order_version_id, line_no, sku_id, sku_code, name, unit, quantity, base_unit, base_quantity, unit_price, amount)
     SELECT $1, $2, n, sku_id, sku, name, unit, qty, base_unit, base_qty, rate, amount
       FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[], $9::numeric[], $10::numeric[], $11::numeric[])
            WITH ORDINALITY AS t(sku_id, sku, name, unit, qty, base_unit, base_qty, rate, amount, n)`,
    [
      tenantId,
      versionId,
      lines.map((l) => skuId.get(l.sku)),
      lines.map((l) => l.sku),
      lines.map((l) => l.name),
      lines.map((l) => l.unit),
      lines.map((l) => l.qty),
      lines.map((l) => l.base_unit),
      lines.map((l) => l.base_qty),
      lines.map((l) => l.rate),
      lines.map((l) => l.amount),
    ],
  );
}

// ---- staff reads ------------------------------------------------------------------------------

export interface OrderSummary {
  id: string;
  order_number: string;
  status: string;
  retailer_name: string;
  contact_phone: string | null;
  channel: string;
  current_version: number;
  total: string;
  line_count: number;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

const SUMMARY = `
  SELECT o.id, o.order_number, o.status, o.retailer_name, o.contact_phone, o.channel, o.current_version,
         v.total, (SELECT count(*)::int FROM order_lines l WHERE l.order_version_id = v.id) AS line_count,
         o.confirmed_at, o.created_at, o.updated_at
    FROM orders o
    JOIN order_versions v ON v.tenant_id = o.tenant_id AND v.order_id = o.id AND v.version = o.current_version`;

const fmt = <T extends { order_number: string | number }>(r: T) => ({ ...r, order_number: formatOrderNumber(r.order_number) });

/** Newest first, keyset paginated on (created_at, id). */
export async function listOrders(tx: Tx, opts: { limit: number; statuses?: string[]; before?: { t: string; id: string } | null }): Promise<OrderSummary[]> {
  const params: unknown[] = [opts.limit];
  const where: string[] = [];
  if (opts.statuses?.length) {
    params.push(opts.statuses);
    where.push(`o.status = ANY($${params.length})`);
  }
  if (opts.before) {
    params.push(opts.before.t, opts.before.id);
    where.push(`(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  const r = await tx.query(`${SUMMARY} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY o.created_at DESC, o.id DESC LIMIT $1`, params);
  return r.rows.map(fmt) as OrderSummary[];
}

/** A retailer's orders for the chat view: placed in this conversation, or from the same number. Newest first. */
export async function listOrdersForConversation(tx: Tx, conversationId: string, limit = 50): Promise<OrderSummary[]> {
  const r = await tx.query(
    `${SUMMARY}
      JOIN conversations c ON c.tenant_id = o.tenant_id AND c.id = $1
      JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
     WHERE o.conversation_id = c.id OR o.contact_phone = ct.phone_e164
     ORDER BY o.created_at DESC, o.id DESC LIMIT $2`,
    [conversationId, limit],
  );
  return r.rows.map(fmt) as OrderSummary[];
}

export interface OrderDetail extends OrderSummary {
  summary_hash: string;
  lines: Array<{ line_no: number; sku_code: string; name: string; unit: string; quantity: string; base_unit: string; base_quantity: string; unit_price: string; amount: string }>;
  confirmation: { channel: string; evidence: string | null; confirmed_at: string } | null;
}

export async function getOrder(tx: Tx, id: string): Promise<OrderDetail | null> {
  const o = (await tx.query(`${SUMMARY.replace("SELECT o.id,", "SELECT v.id AS version_id, v.summary_hash, o.id,")} WHERE o.id = $1`, [id])).rows[0];
  if (!o) return null;
  const lines = await tx.query(
    `SELECT line_no, sku_code, name, unit, quantity, base_unit, base_quantity, unit_price, amount FROM order_lines WHERE order_version_id = $1 ORDER BY line_no`,
    [o.version_id],
  );
  const conf = await tx.query(`SELECT channel, evidence, confirmed_at FROM confirmations WHERE order_version_id = $1 ORDER BY confirmed_at DESC LIMIT 1`, [o.version_id]);
  const { version_id: _v, ...rest } = o;
  return { ...fmt(rest), lines: lines.rows, confirmation: conf.rows[0] ?? null } as OrderDetail;
}
