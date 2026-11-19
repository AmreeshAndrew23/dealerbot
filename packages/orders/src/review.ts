// Staff review (architecture 7.4, 8.4; E12): validation, approve, reject, cancel.
// Validation is re-run inside the approval transaction; the dashboard shows the same result.
import { createHash } from "node:crypto";
import type { Tx } from "@fmcg/db";
import { writeAudit } from "@fmcg/db";
import { releaseStock } from "@fmcg/catalogue";
import { formatOrderNumber } from "./store";
import { notifyRetailerOfDecision } from "./notify";
import { allowedEvents, transition, type OrderEvent, type OrderStatus } from "./workflow";

export type Severity = "blocker" | "warning" | "info";

export interface Check {
  code: string;
  severity: Severity;
  message: string;
  line_no?: number;
}

export class ReviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface LockedOrder {
  id: string;
  tenant_id: string;
  order_number: string;
  status: OrderStatus;
  retailer_name: string;
  current_version: number;
  lock_version: number;
  version_id: string;
  summary_hash: string;
  total: string;
  created_at: Date;
}

async function loadOrder(tx: Tx, id: string, lock: boolean): Promise<LockedOrder | null> {
  if (lock) await tx.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [id]);
  const r = await tx.query<LockedOrder>(
    `SELECT o.id, o.tenant_id, o.order_number, o.status, o.retailer_name, o.current_version, o.lock_version, o.created_at,
            v.id AS version_id, v.summary_hash, v.total
       FROM orders o JOIN order_versions v ON v.tenant_id = o.tenant_id AND v.order_id = o.id AND v.version = o.current_version
      WHERE o.id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

const rupees = (s: string) => `₹${Number(s).toFixed(2)}`;

/** Architecture 8.4: hard blockers and warnings for the order's current version, against today's catalogue. */
export async function validateOrder(tx: Tx, o: LockedOrder): Promise<Check[]> {
  const checks: Check[] = [];
  const lines = await tx.query<{
    line_no: number;
    name: string;
    sku_code: string;
    unit: string;
    quantity: string;
    unit_price: string;
    active: boolean | null;
    multiplier: string | null;
    current_price: string | null;
    version_multiplier: string;
  }>(
    `SELECT l.line_no, l.name, l.sku_code, l.unit, l.quantity, l.unit_price,
            s.active, u.base_multiplier AS multiplier, p.rate AS current_price,
            (l.base_quantity / l.quantity)::numeric(14,4) AS version_multiplier
       FROM order_lines l
       LEFT JOIN skus s ON s.tenant_id = l.tenant_id AND s.id = l.sku_id
       LEFT JOIN sku_units u ON u.tenant_id = l.tenant_id AND u.sku_id = l.sku_id AND u.unit = l.unit
       LEFT JOIN prices p ON p.tenant_id = l.tenant_id AND p.sku_id = l.sku_id AND p.price_list = 'STANDARD'
      WHERE l.order_version_id = $1 ORDER BY l.line_no`,
    [o.version_id],
  );
  for (const l of lines.rows) {
    if (!l.active) {
      checks.push({ code: "SKU_INACTIVE", severity: "blocker", line_no: l.line_no, message: `${l.name} is hidden or no longer in the catalogue.` });
      continue;
    }
    if (l.multiplier === null || Number(l.multiplier) !== Number(l.version_multiplier)) {
      checks.push({ code: "PACK_CHANGED", severity: "blocker", line_no: l.line_no, message: `The ${l.unit} pack size of ${l.name} changed since the retailer confirmed.` });
    }
    if (l.current_price === null) {
      checks.push({ code: "PRICE_MISSING", severity: "blocker", line_no: l.line_no, message: `${l.name} has no price.` });
    } else if (Number(l.current_price) !== Number(l.unit_price)) {
      // Gate 6: a changed price invalidates the confirmation; the retailer must agree to the new price.
      checks.push({
        code: "PRICE_CHANGED",
        severity: "blocker",
        line_no: l.line_no,
        message: `Price of ${l.name} changed from ${rupees(l.unit_price)} to ${rupees(l.current_price)} after the retailer confirmed. The retailer has to confirm the new price.`,
      });
    }
  }

  // Retailer identity (E09) is not built: the shop name is as given on chat.
  checks.push({ code: "RETAILER_NOT_VERIFIED", severity: "warning", message: `"${o.retailer_name}" is not yet linked to a Tally ledger. Check it is the right shop.` });

  const dup = await tx.query<{ order_number: string }>(
    `SELECT o.order_number FROM orders o JOIN order_versions v ON v.tenant_id = o.tenant_id AND v.order_id = o.id AND v.version = o.current_version
      WHERE o.id <> $1 AND o.retailer_name = $2 AND v.summary_hash = $3 AND o.status NOT IN ('REJECTED','CANCELLED','EXPIRED')
        AND o.created_at > $4::timestamptz - interval '24 hours' LIMIT 1`,
    [o.id, o.retailer_name, o.summary_hash, o.created_at],
  );
  if (dup.rows[0]) {
    checks.push({ code: "DUPLICATE_SUSPECTED", severity: "warning", message: `Same items as ${formatOrderNumber(dup.rows[0].order_number)} from this shop in the last 24 hours. Make sure it is not a repeat.` });
  }

  // Architecture 7.4 also requires a verified connector and live export; until the connector (E06)
  // exists, approved orders simply wait in the export queue (flow G: "Waiting for Tally").
  const connector = await tx.query(`SELECT 1 FROM tenants WHERE id = $1 AND live_export_enabled`, [o.tenant_id]);
  if (!connector.rowCount) checks.push({ code: "TALLY_NOT_CONNECTED", severity: "info", message: "Tally is not connected yet. Approved orders wait in the queue until it is." });
  return checks;
}

export interface ReviewView {
  lock_version: number;
  allowed: OrderEvent[];
  checks: Check[];
  export_job: { state: string; external_reference: string; created_at: string } | null;
  review: { status_reason: string | null; reviewed_by_name: string | null; reviewed_at: string | null };
  history: Array<{ at: string; action: string; by: string | null; details: Record<string, unknown> }>;
}

export async function reviewView(tx: Tx, id: string): Promise<ReviewView | null> {
  const o = await loadOrder(tx, id, false);
  if (!o) return null;
  const pre = (["READY_FOR_REVIEW"] as OrderStatus[]).includes(o.status);
  const checks = pre ? await validateOrder(tx, o) : [];
  const job = await tx.query(`SELECT state, external_reference, created_at FROM export_jobs WHERE order_version_id = $1`, [o.version_id]);
  const meta = await tx.query<{ status_reason: string | null; reviewed_by_name: string | null; reviewed_at: string | null }>(
    `SELECT o.status_reason, u.display_name AS reviewed_by_name, o.reviewed_at FROM orders o LEFT JOIN users u ON u.id = o.reviewed_by WHERE o.id = $1`,
    [id],
  );
  const history = await tx.query<{ at: string; action: string; by: string | null; details: Record<string, unknown> }>(
    `SELECT a.created_at AS at, a.action, coalesce(u.display_name, CASE WHEN a.actor_type = 'system' THEN 'Retailer (chat)' END) AS by, a.details_json AS details
       FROM audit_events a LEFT JOIN users u ON a.actor_type = 'user' AND u.id::text = a.actor_id
      WHERE a.entity_type = 'order' AND a.entity_id = $1 ORDER BY a.created_at, a.id`,
    [id],
  );
  return { lock_version: o.lock_version, allowed: allowedEvents(o.status), checks, export_job: job.rows[0] ?? null, review: meta.rows[0]!, history: history.rows };
}

interface ActionInput {
  orderId: string;
  userId: string;
  /** If-Match: the lock_version the user was looking at. */
  lockVersion: number;
}

async function lockFor(tx: Tx, a: ActionInput, event: OrderEvent): Promise<LockedOrder & { to: OrderStatus }> {
  const o = await loadOrder(tx, a.orderId, true);
  if (!o) throw new ReviewError(404, "NOT_FOUND", "Order not found.");
  if (o.lock_version !== a.lockVersion) {
    throw new ReviewError(409, "ORDER_VERSION_CONFLICT", "This order changed. Reload before continuing.", { current_lock_version: o.lock_version, status: o.status });
  }
  const t = transition(o.status, event);
  if (!t.ok) throw new ReviewError(409, "INVALID_STATE", t.error, { status: o.status });
  return { ...o, to: t.to };
}

/** Architecture 7.4: approval, export job, status, audit — one transaction, no network calls. */
export async function approveOrder(
  tx: Tx,
  a: ActionInput & { version: number; summaryHash: string; acknowledged: string[] },
): Promise<{ status: OrderStatus; export_reference: string; lock_version: number }> {
  const o = await lockFor(tx, a, "approve");
  if (o.current_version !== a.version || o.summary_hash !== a.summaryHash) {
    throw new ReviewError(409, "ORDER_VERSION_CONFLICT", "The order has a newer version. Reload before approving.", { current_version: o.current_version });
  }
  const conf = await tx.query(`SELECT 1 FROM confirmations WHERE order_version_id = $1 AND summary_hash = $2`, [o.version_id, o.summary_hash]);
  if (!conf.rowCount) throw new ReviewError(422, "CONFIRMATION_MISSING", "The retailer has not confirmed this version.");

  const checks = await validateOrder(tx, o);
  const blockers = checks.filter((c) => c.severity === "blocker");
  if (blockers.length) throw new ReviewError(422, "VALIDATION_FAILED", "This order cannot be approved yet.", { blockers });
  const warnings = checks.filter((c) => c.severity === "warning");
  const missing = warnings.filter((w) => !a.acknowledged.includes(w.code));
  if (missing.length) throw new ReviewError(422, "WARNINGS_NOT_ACKNOWLEDGED", "Please acknowledge every warning before approving.", { warnings: missing });

  const live = await tx.query(`SELECT 1 FROM export_jobs WHERE order_id = $1 AND state IN ('LEASED','SUBMITTING','UNCERTAIN','SUCCEEDED')`, [o.id]);
  if (live.rowCount) throw new ReviewError(409, "EXPORT_IN_PROGRESS", "This order already has an export in progress.");

  const lines = await tx.query(`SELECT sku_code, unit, quantity, unit_price, amount FROM order_lines WHERE order_version_id = $1 ORDER BY line_no`, [o.version_id]);
  const reference = `COP-${String(o.order_number).padStart(6, "0")}-V${o.current_version}`;
  const payloadHash = createHash("sha256").update(JSON.stringify({ reference, retailer: o.retailer_name, total: o.total, lines: lines.rows })).digest("hex");

  await tx.query(`INSERT INTO approvals (tenant_id, order_version_id, summary_hash, approved_by, acknowledged_warnings) VALUES ($1,$2,$3,$4,$5)`, [
    o.tenant_id,
    o.version_id,
    o.summary_hash,
    a.userId,
    JSON.stringify(warnings.map((w) => ({ code: w.code, message: w.message }))),
  ]);
  await tx.query(
    `INSERT INTO export_jobs (tenant_id, order_id, order_version_id, state, external_reference, payload_hash) VALUES ($1,$2,$3,'QUEUED',$4,$5)`,
    [o.tenant_id, o.id, o.version_id, reference, payloadHash],
  );
  const upd = await tx.query<{ lock_version: number }>(
    `UPDATE orders SET status = 'APPROVED', lock_version = lock_version + 1, reviewed_by = $2, reviewed_at = now(), status_reason = NULL, updated_at = now()
      WHERE id = $1 RETURNING lock_version`,
    [o.id, a.userId],
  );
  await writeAudit(tx, {
    tenant_id: o.tenant_id,
    actor_type: "user",
    actor_id: a.userId,
    action: "order.approved",
    entity_type: "order",
    entity_id: o.id,
    details: { from: o.status, to: "APPROVED", version: o.current_version, summary_hash: o.summary_hash, export_reference: reference, acknowledged: warnings.map((w) => w.code) },
  });
  // The retailer was told "we will message you once it is accepted": same transaction as the decision.
  await notifyRetailerOfDecision(tx, o.id, "APPROVED", null);
  return { status: "APPROVED", export_reference: reference, lock_version: upd.rows[0]!.lock_version };
}

export async function rejectOrCancel(
  tx: Tx,
  event: "reject" | "cancel",
  a: ActionInput & { reason: string },
): Promise<{ status: OrderStatus; lock_version: number }> {
  const o = await lockFor(tx, a, event);
  if (o.status === "APPROVED") {
    // Only while the export has not started (architecture 5.1: "job still QUEUED").
    const job = await tx.query<{ id: string; state: string }>(`SELECT id, state FROM export_jobs WHERE order_version_id = $1 FOR UPDATE`, [o.version_id]);
    const j = job.rows[0];
    if (j && j.state !== "QUEUED") throw new ReviewError(409, "EXPORT_STARTED", "Tally export has already started; this order can no longer be cancelled here.");
    if (j) await tx.query(`UPDATE export_jobs SET state = 'CANCELLED', updated_at = now() WHERE id = $1`, [j.id]);
  }
  // The order will not be supplied: give its stock back for other retailers.
  await releaseStock(tx, o.tenant_id, o.id, { type: "user", id: a.userId });
  const upd = await tx.query<{ lock_version: number }>(
    `UPDATE orders SET status = $2, status_reason = $3, lock_version = lock_version + 1, reviewed_by = $4, reviewed_at = now(), updated_at = now()
      WHERE id = $1 RETURNING lock_version`,
    [o.id, o.to, a.reason, a.userId],
  );
  await writeAudit(tx, {
    tenant_id: o.tenant_id,
    actor_type: "user",
    actor_id: a.userId,
    action: event === "reject" ? "order.rejected" : "order.cancelled",
    entity_type: "order",
    entity_id: o.id,
    details: { from: o.status, to: o.to, reason: a.reason, version: o.current_version },
  });
  await notifyRetailerOfDecision(tx, o.id, o.to === "REJECTED" ? "REJECTED" : "CANCELLED", a.reason);
  return { status: o.to, lock_version: upd.rows[0]!.lock_version };
}

/** Counts per status for the queue tabs. */
export async function orderCounts(tx: Tx): Promise<Record<string, number>> {
  const r = await tx.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM orders GROUP BY status`);
  return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
}
