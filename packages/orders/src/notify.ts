// Tells the retailer what staff decided about their order (accepted, not accepted, cancelled).
// The confirmation message promises this, so it is written in the SAME transaction as the decision:
// either both happen or neither does. It goes into the order's conversation, in the language the
// retailer chose, and reaches them the way that conversation's replies do:
//   customer app            - visible in the app at once (status 'sent')
//   WhatsApp test bridge    - queued; the bridge sends it within a few seconds
//   WhatsApp Cloud API      - not yet: Cloud API chats do not create orders until E10/E11 (skipped)
import type { Tx } from "@fmcg/db";
import { MESSAGES, type ReplyLang } from "./messages";
import { formatOrderNumber } from "./store";

export type Decision = "APPROVED" | "REJECTED" | "CANCELLED";
export type NotifyResult = "shown_in_app" | "queued_for_whatsapp_test" | "no_conversation" | "channel_not_supported";

export async function notifyRetailerOfDecision(tx: Tx, orderId: string, decision: Decision, reason: string | null): Promise<NotifyResult> {
  const r = await tx.query<{
    tenant_id: string;
    order_number: string;
    conversation_id: string | null;
    total: string;
    distributor: string | null;
    provider: string | null;
    lang: string | null;
  }>(
    `SELECT o.tenant_id, o.order_number, o.conversation_id, v.total, t.name AS distributor, ca.provider, c.draft_json->>'lang' AS lang
       FROM orders o
       JOIN order_versions v ON v.tenant_id = o.tenant_id AND v.order_id = o.id AND v.version = o.current_version
       LEFT JOIN tenants t ON t.id = o.tenant_id
       LEFT JOIN conversations c ON c.tenant_id = o.tenant_id AND c.id = o.conversation_id
       LEFT JOIN channel_accounts ca ON ca.tenant_id = c.tenant_id AND ca.id = c.channel_account_id
      WHERE o.id = $1`,
    [orderId],
  );
  const o = r.rows[0];
  if (!o?.conversation_id) return "no_conversation";
  if (o.provider !== "app" && o.provider !== "whatsapp_test") return "channel_not_supported";

  const m = MESSAGES[(o.lang === "ta" ? "ta" : "en") as ReplyLang];
  const number = formatOrderNumber(o.order_number);
  const text =
    decision === "APPROVED" ? m.orderAccepted(number, o.total, o.distributor ?? "") : decision === "REJECTED" ? m.orderRejected(number, reason) : m.orderCancelled(number, reason);
  const inApp = o.provider === "app";
  await tx.query(
    `INSERT INTO outbound_messages (tenant_id, conversation_id, dedupe_key, origin, payload_json, policy_result, policy_reason, status, sent_at)
     VALUES ($1,$2,$3,'system',$4,'ALLOW','ORDER_DECISION',$5, CASE WHEN $5 = 'sent' THEN now() END)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
    [o.tenant_id, o.conversation_id, `order:${orderId}:${decision}`, { kind: "text", text }, inApp ? "sent" : "queued"],
  );
  return inApp ? "shown_in_app" : "queued_for_whatsapp_test";
}
