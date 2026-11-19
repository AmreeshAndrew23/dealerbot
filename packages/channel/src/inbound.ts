// Inbound job: turns a stored webhook event into contact / conversation / message rows, applies
// opt-out keywords, updates delivery status, and queues the neutral acknowledgement (PRD flow E).
import { QUEUES, type InboundEvent, type MediaJob } from "@fmcg/contracts";
import { withTx, writeAudit, type Tx } from "@fmcg/db";
import { normaliseMessage, type MetaMessage, type MetaStatus } from "./webhook-parse";
import { queueOutbound } from "./outbound";
import { sendInTx, type Boss } from "./queue";
import { keywordIntent, NEUTRAL_ACK, OPT_IN_CONFIRMATION, OPT_OUT_CONFIRMATION } from "./replies";

const MEDIA_TYPES = new Set(["audio", "image", "document", "video"]);
const ACK_BUCKET_MS = 30 * 60 * 1000; // at most one automatic acknowledgement per conversation per 30 min

export type InboundResult =
  | "DUPLICATE_EVENT"
  | "UNKNOWN_PHONE_NUMBER_ID"
  | "CHANNEL_DISABLED"
  | "DUPLICATE_MESSAGE"
  | "MESSAGE_STORED"
  | "STATUS_APPLIED"
  | "STATUS_UNMATCHED";

export interface InboundOutcome {
  result: InboundResult;
  event?: InboundEvent;
  tenantId?: string;
  conversationId?: string;
  messageId?: string;
}

export async function handleInboundJob(webhookEventId: string, boss: Boss, now = new Date()): Promise<InboundOutcome> {
  return withTx(async (tx) => {
    const ev = await tx.query<{
      id: string;
      kind: "message" | "status";
      provider_phone_id: string;
      payload_json: any;
      processed_at: Date | null;
    }>(`SELECT id, kind, provider_phone_id, payload_json, processed_at FROM webhook_events WHERE id = $1 FOR UPDATE`, [
      webhookEventId,
    ]);
    const e = ev.rows[0];
    if (!e || e.processed_at) return { result: "DUPLICATE_EVENT" as const };

    const outcome =
      e.kind === "status"
        ? await applyStatus(tx, e.payload_json.status as MetaStatus)
        : await storeMessage(tx, boss, e.id, e.provider_phone_id, e.payload_json, now);

    await tx.query(`UPDATE webhook_events SET processed_at = now(), process_result = $2 WHERE id = $1`, [e.id, outcome.result]);
    return outcome;
  });
}

async function storeMessage(
  tx: Tx,
  boss: Boss,
  webhookEventId: string,
  providerPhoneId: string,
  payload: { message: MetaMessage; profile_name: string | null },
  now: Date,
): Promise<InboundOutcome> {
  const acc = await tx.query<{ id: string; tenant_id: string; status: string }>(
    `SELECT id, tenant_id, status FROM channel_accounts WHERE provider_phone_id = $1`,
    [providerPhoneId],
  );
  const account = acc.rows[0];
  if (!account) return { result: "UNKNOWN_PHONE_NUMBER_ID" };
  if (account.status !== "active") return { result: "CHANNEL_DISABLED" };
  const tenantId = account.tenant_id;

  const event = normaliseMessage(webhookEventId, account.id, payload);

  const contact = await tx.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, phone_e164, profile_name) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, phone_e164)
       DO UPDATE SET profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name), updated_at = now()
     RETURNING id`,
    [tenantId, event.sender, event.sender_profile_name],
  );
  const contactId = contact.rows[0]!.id;

  const conv = await tx.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, last_inbound_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, channel_account_id, contact_id)
       DO UPDATE SET last_inbound_at = GREATEST(conversations.last_inbound_at, EXCLUDED.last_inbound_at), updated_at = now()
     RETURNING id`,
    [tenantId, account.id, contactId, event.occurred_at],
  );
  const conversationId = conv.rows[0]!.id;

  const msg = await tx.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, provider_message_id, direction, type, body,
                           provider_media_id, media_mime_type, interactive_reply_id, reply_to_provider_message_id,
                           provider_timestamp, review_reason)
     VALUES ($1,$2,$3,$4,'inbound',$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (channel_account_id, provider_message_id) DO NOTHING
     RETURNING id`,
    [
      tenantId,
      conversationId,
      account.id,
      event.provider_message_id,
      event.type,
      event.text,
      event.media?.provider_media_id ?? null,
      event.media?.mime_type ?? null,
      event.interactive?.reply_id ?? null,
      event.reply_to_provider_message_id,
      event.occurred_at,
      event.type === "unsupported" ? "UNSUPPORTED_MESSAGE_TYPE" : null,
    ],
  );
  const messageId = msg.rows[0]?.id;
  if (!messageId) return { result: "DUPLICATE_MESSAGE", event, tenantId, conversationId };

  if (event.media && MEDIA_TYPES.has(event.type)) {
    await sendInTx(boss, tx, QUEUES.media, { message_id: messageId, tenant_id: tenantId } satisfies MediaJob);
  }

  const intent = event.type === "text" ? keywordIntent(event.text) : null;
  if (intent) {
    await tx.query(
      `INSERT INTO consent_events (tenant_id, contact_id, purpose, action, evidence_ref, occurred_at)
       VALUES ($1,$2,'order_messaging',$3,$4,$5)`,
      [tenantId, contactId, intent, `message:${messageId}`, event.occurred_at],
    );
    await writeAudit(tx, {
      tenant_id: tenantId,
      actor_type: "provider",
      actor_id: event.sender,
      action: `consent.${intent}`,
      entity_type: "contact",
      entity_id: contactId,
      details: { message_id: messageId },
    });
    await queueOutbound(tx, boss, {
      tenantId,
      conversationId,
      dedupeKey: `consent:${messageId}`,
      origin: "system",
      payload: { kind: "text", text: intent === "opt_out" ? OPT_OUT_CONFIRMATION : OPT_IN_CONFIRMATION },
      isOptOutConfirmation: intent === "opt_out",
      now,
    });
  } else if (event.type !== "reaction") {
    // Identity resolution and order drafting come later (E09/E10). Until a contact is linked to a
    // retailer, PRD flow E allows only a neutral acknowledgement: no prices, balances or history.
    const bucket = Math.floor(now.getTime() / ACK_BUCKET_MS);
    await queueOutbound(tx, boss, {
      tenantId,
      conversationId,
      dedupeKey: `ack:${conversationId}:${bucket}`,
      origin: "bot",
      payload: { kind: "text", text: NEUTRAL_ACK },
      now,
    });
  }

  return { result: "MESSAGE_STORED", event, tenantId, conversationId, messageId };
}

const STATUS_RANK: Record<string, number> = { queued: 0, sending: 0, sent: 1, delivered: 2, read: 3 };

/** Delivery statuses only move forward (sent < delivered < read); they never create orders. */
async function applyStatus(tx: Tx, s: MetaStatus): Promise<InboundOutcome> {
  const r = await tx.query<{ id: string; tenant_id: string; status: string }>(
    `SELECT id, tenant_id, status FROM outbound_messages WHERE provider_id = $1 FOR UPDATE`,
    [s.id],
  );
  const row = r.rows[0];
  if (!row) return { result: "STATUS_UNMATCHED" };
  const at = new Date(Number(s.timestamp) * 1000);

  if (s.status === "failed") {
    if (row.status !== "read") {
      await tx.query(`UPDATE outbound_messages SET status = 'failed', error_json = $2, updated_at = now() WHERE id = $1`, [
        row.id,
        { provider_errors: s.errors ?? [] },
      ]);
    }
  } else if (s.status in STATUS_RANK && (STATUS_RANK[s.status] ?? 0) > (STATUS_RANK[row.status] ?? -1)) {
    const col = s.status === "delivered" ? "delivered_at" : s.status === "read" ? "read_at" : "sent_at";
    await tx.query(
      `UPDATE outbound_messages SET status = $2, ${col} = COALESCE(${col}, $3), updated_at = now() WHERE id = $1`,
      [row.id, s.status, at],
    );
  }
  return { result: "STATUS_APPLIED", tenantId: row.tenant_id };
}
