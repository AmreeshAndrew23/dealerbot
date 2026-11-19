// Chats that do not come through the WhatsApp Cloud API webhook (the customer app, and the
// testing-only WhatsApp Web bridge) are recorded in the same tables the webhook path fills:
// contacts, conversations, messages, outbound_messages. So they show on the dashboard Conversations
// page, staff can take a chat over, and confirmed orders are linked to their conversation.
import type { Tx } from "@fmcg/db";
import type { DraftState } from "./draft";

/** channel_accounts.provider of a chat that is not on the Cloud API. */
export type DirectProvider = "app" | "whatsapp_test";

/** One channel account per distributor and provider; display_phone is the linked phone, if there is one. */
export async function ensureDirectChannel(tx: Tx, tenantId: string, provider: DirectProvider, displayPhone: string | null): Promise<string> {
  const key = provider === "whatsapp_test" ? `wa-test:${tenantId}` : `${provider}:${tenantId}`;
  const r = await tx.query<{ id: string }>(
    `INSERT INTO channel_accounts (tenant_id, provider, provider_phone_id, display_phone, secret_reference)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider_phone_id)
       DO UPDATE SET display_phone = COALESCE(EXCLUDED.display_phone, channel_accounts.display_phone), status = 'active', updated_at = now()
     RETURNING id`,
    [tenantId, provider, key, displayPhone, `none:${provider}`],
  );
  return r.rows[0]!.id;
}

export interface InboundRecord {
  tenantId: string;
  accountId: string;
  /** "+<digits>" */
  phone: string;
  profileName: string | null;
  /** Unique per channel account; a repeat is ignored (retries never store a message twice). */
  providerMessageId: string;
  /** null = not a text message (photo, voice note ...). */
  text: string | null;
  at: Date;
}

export async function recordInbound(tx: Tx, m: InboundRecord): Promise<{ conversationId: string; ownerMode: "BOT" | "HUMAN"; duplicate: boolean }> {
  const contact = await tx.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, phone_e164, profile_name) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, phone_e164)
       DO UPDATE SET profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name), updated_at = now()
     RETURNING id`,
    [m.tenantId, m.phone, m.profileName],
  );
  const conv = await tx.query<{ id: string; owner_mode: "BOT" | "HUMAN" }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, last_inbound_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, channel_account_id, contact_id)
       DO UPDATE SET last_inbound_at = GREATEST(conversations.last_inbound_at, EXCLUDED.last_inbound_at), updated_at = now()
     RETURNING id, owner_mode`,
    [m.tenantId, m.accountId, contact.rows[0]!.id, m.at],
  );
  const ins = await tx.query(
    `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, provider_message_id, direction, type, body, provider_timestamp)
     VALUES ($1,$2,$3,$4,'inbound',$5,$6,$7)
     ON CONFLICT (channel_account_id, provider_message_id) DO NOTHING`,
    [m.tenantId, conv.rows[0]!.id, m.accountId, m.providerMessageId, m.text === null ? "unsupported" : "text", m.text, m.at],
  );
  return { conversationId: conv.rows[0]!.id, ownerMode: conv.rows[0]!.owner_mode, duplicate: ins.rowCount === 0 };
}

/** A reply that has already reached the retailer (sent on WhatsApp, or visible in the app). */
export async function recordSentReply(
  tx: Tx,
  o: { tenantId: string; conversationId: string; key: string; text: string; origin?: "bot" | "human" | "system"; sentBy?: string | null },
): Promise<string | null> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO outbound_messages (tenant_id, conversation_id, dedupe_key, origin, sent_by, payload_json, policy_result, policy_reason, status, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,'ALLOW','IN_SERVICE_WINDOW','sent', now())
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [o.tenantId, o.conversationId, o.key, o.origin ?? "bot", o.sentBy ?? null, { kind: "text", text: o.text }],
  );
  return r.rows[0]?.id ?? null;
}

/** The assistant handed the chat to staff (or staff handed it back): keep the dashboard in step. */
export async function setOwnerMode(tx: Tx, tenantId: string, conversationId: string, mode: "BOT" | "HUMAN"): Promise<void> {
  await tx.query(
    `UPDATE conversations SET owner_mode = $3, assigned_user_id = CASE WHEN $3 = 'BOT' THEN NULL ELSE assigned_user_id END, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND owner_mode <> $3`,
    [tenantId, conversationId, mode],
  );
}

/** The assistant's draft for a conversation (customer app; the bridge keeps its drafts in memory). */
export async function loadDraft(tx: Tx, tenantId: string, conversationId: string): Promise<DraftState | null> {
  const r = await tx.query<{ draft_json: DraftState | null }>(`SELECT draft_json FROM conversations WHERE tenant_id = $1 AND id = $2`, [tenantId, conversationId]);
  return r.rows[0]?.draft_json ?? null;
}

export async function saveDraft(tx: Tx, tenantId: string, conversationId: string, state: DraftState): Promise<void> {
  await tx.query(`UPDATE conversations SET draft_json = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, conversationId, JSON.stringify(state)]);
}

export interface StaffReply {
  id: string;
  phone: string;
  payload: { kind?: string; text?: string };
}

/** Replies typed by staff on the dashboard, waiting to go out through the test bridge. Marks them 'sending'. */
export async function claimStaffReplies(tx: Tx, tenantId: string, accountId: string): Promise<StaffReply[]> {
  const r = await tx.query<{ id: string; phone_e164: string; payload_json: StaffReply["payload"] }>(
    `UPDATE outbound_messages o SET status = 'sending', updated_at = now()
       FROM conversations cv JOIN contacts ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contact_id
      WHERE o.tenant_id = $1 AND o.status = 'queued'
        AND cv.tenant_id = o.tenant_id AND cv.id = o.conversation_id AND cv.channel_account_id = $2
      RETURNING o.id, ct.phone_e164, o.payload_json`,
    [tenantId, accountId],
  );
  return r.rows.map((x) => ({ id: x.id, phone: x.phone_e164, payload: x.payload_json }));
}

export async function finishStaffReply(tx: Tx, tenantId: string, id: string, error: string | null): Promise<void> {
  await tx.query(
    `UPDATE outbound_messages
        SET status = $3, error_json = $4, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, error ? "failed" : "sent", error ? { code: "TEST_BRIDGE_SEND_FAILED", message: error } : null],
  );
}

export type AttentionReason = "question" | "cancel_request" | "handoff" | "missed_message";

/** Flags a conversation for staff (newest reason wins). Cleared when staff reply or hand it back. */
export async function flagAttention(tx: Tx, tenantId: string, conversationId: string, reason: AttentionReason): Promise<void> {
  await tx.query(`UPDATE conversations SET needs_attention = $3, attention_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    conversationId,
    reason,
  ]);
}

export async function clearAttention(tx: Tx, tenantId: string, conversationId: string): Promise<void> {
  await tx.query(`UPDATE conversations SET needs_attention = NULL, attention_at = NULL WHERE tenant_id = $1 AND id = $2 AND needs_attention IS NOT NULL`, [
    tenantId,
    conversationId,
  ]);
}

/** A number that messaged but is not a connected retailer: kept so staff can add it on the Retailers page. */
export async function recordUnknownSender(
  tx: Tx,
  u: { tenantId: string; phone: string; profileName: string | null; text: string | null; reason: "not_a_retailer" | "retailer_inactive" },
): Promise<void> {
  await tx.query(
    `INSERT INTO unknown_senders (tenant_id, phone_e164, profile_name, last_text, reason)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, phone_e164) DO UPDATE
       SET profile_name = COALESCE(EXCLUDED.profile_name, unknown_senders.profile_name),
           last_text = COALESCE(EXCLUDED.last_text, unknown_senders.last_text),
           reason = EXCLUDED.reason, attempts = unknown_senders.attempts + 1, last_at = now()`,
    [u.tenantId, u.phone, u.profileName, u.text ? u.text.slice(0, 300) : null, u.reason],
  );
}
