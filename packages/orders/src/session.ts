// One retailer turn, end to end: read the live Catalogue, run the draft rules, save the order on
// confirmation, record what the matcher learned. Shared by `pnpm chat` (terminal) and the
// testing-only WhatsApp Web bridge (apps/wa-test), so both behave exactly alike.
import { withTenantTx, withTx, type Tx } from "@fmcg/db";
import { listProducts, recordLearning } from "@fmcg/catalogue";
import { handleMessage, type DraftState, type OrderStatusInfo, type TurnResult } from "./draft";
import { flagAttention } from "./chatlog";
import { openAiExtractor, type Extractor } from "./extract";
import { amendConfirmedOrder, createConfirmedOrder, formatOrderNumber, openOrderFor, type OrderChannel } from "./store";

export interface RetailerTurnInput {
  tenant: { id: string; name: string };
  state: DraftState;
  text: string;
  /** Shop name printed on the order (retailer identity is E09). */
  shopName: string;
  retailerName?: string;
  channel: OrderChannel;
  contactPhone?: string | null;
  retailerId?: string | null;
  /** The dashboard conversation this chat is recorded in, so the order links back to it. */
  conversationId?: string | null;
  extract?: Extractor;
  signal?: AbortSignal;
}

export async function runRetailerTurn(i: RetailerTurnInput): Promise<TurnResult> {
  // Re-read for every message, so dashboard edits (prices, stock, aliases) apply to the next reply.
  // withTenantTx: row-level security limits the Catalogue to this distributor only.
  const products = await withTenantTx(i.tenant.id, (tx) => listProducts(tx, { activeOnly: true }));
  const turn = await handleMessage(i.state, i.text, {
    products,
    extract: i.extract ?? openAiExtractor,
    retailerName: i.retailerName,
    shopName: i.shopName,
    distributorName: i.tenant.name,
    signal: i.signal ?? AbortSignal.timeout(60_000),
    onConfirm: async (c) => {
      if (c.amend) {
        // The retailer changed a placed order: the next version of the same order (or OrderClosedError).
        const amended = await withTx((tx) =>
          amendConfirmedOrder(tx, {
            tenantId: i.tenant.id,
            orderId: c.amend!.id,
            retailerId: i.retailerId ?? null,
            contactPhone: i.contactPhone ?? null,
            channel: i.channel,
            summaryHash: c.summary_hash,
            total: c.total,
            lines: c.lines,
            evidence: c.text,
          }),
        );
        return { order_number: formatOrderNumber(amended.order_number), confirmed_at: amended.confirmed_at };
      }
      const saved = await withTx((tx) =>
        createConfirmedOrder(tx, {
          tenantId: i.tenant.id,
          retailerName: i.shopName,
          contactPhone: i.contactPhone ?? null,
          retailerId: i.retailerId ?? null,
          conversationId: i.conversationId ?? null,
          channel: i.channel,
          summaryHash: c.summary_hash,
          total: c.total,
          lines: c.lines,
          evidence: c.text,
        }),
      );
      return { order_number: formatOrderNumber(saved.order_number), confirmed_at: saved.confirmed_at };
    },
    orderStatus: i.retailerId || i.contactPhone ? () => withTenantTx(i.tenant.id, (tx) => recentOrders(tx, i.retailerId ?? null, i.contactPhone ?? null)) : undefined,
    openOrder:
      i.retailerId || i.contactPhone
        ? async () => {
            const o = await withTenantTx(i.tenant.id, (tx) => openOrderFor(tx, i.retailerId ?? null, i.contactPhone ?? null));
            return o ? { id: o.id, order_number: formatOrderNumber(o.order_number), lines: o.lines } : null;
          }
        : undefined,
  });
  if (turn.learn.length) await withTx((tx) => recordLearning(tx, i.tenant.id, turn.learn));
  // The assistant promised a person would follow up: flag the chat on the dashboard.
  const conv = i.conversationId;
  if (turn.attention && conv) await withTx((tx) => flagAttention(tx, i.tenant.id, conv, turn.attention!));
  return turn;
}

/** This retailer's latest orders, newest first (by retailer record, or by phone for older orders). */
async function recentOrders(tx: Tx, retailerId: string | null, phone: string | null): Promise<OrderStatusInfo[]> {
  const r = await tx.query<{ order_number: string; status: string; status_reason: string | null; total: string; at: Date }>(
    `SELECT o.order_number, o.status, o.status_reason, v.total, COALESCE(o.confirmed_at, o.created_at) AS at
       FROM orders o
       JOIN order_versions v ON v.tenant_id = o.tenant_id AND v.order_id = o.id AND v.version = o.current_version
      WHERE ($1::uuid IS NOT NULL AND o.retailer_id = $1) OR ($2::text IS NOT NULL AND o.contact_phone = $2)
      ORDER BY o.created_at DESC, o.id DESC LIMIT 3`,
    [retailerId, phone],
  );
  return r.rows.map((o) => ({
    order_number: formatOrderNumber(o.order_number),
    status: o.status,
    total: o.total,
    at: o.at,
    reason: o.status === "REJECTED" || o.status === "CANCELLED" ? o.status_reason : null,
  }));
}
