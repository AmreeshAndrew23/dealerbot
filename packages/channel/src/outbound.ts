// Queueing outbound messages through the policy gate, and the send job that calls WhatsApp.
import { OutboundPayload, QUEUES, type OutboundOrigin, type SendJob } from "@fmcg/contracts";
import { resolveSecret } from "@fmcg/config";
import { withTx, writeAudit, type Tx } from "@fmcg/db";
import { evaluatePolicy, type PolicyDecision } from "./policy";
import { sendInTx, type Boss } from "./queue";
import { GraphApiError, GraphClient } from "./graph-client";

export interface QueueOutboundInput {
  tenantId: string;
  conversationId: string;
  dedupeKey: string;
  origin: OutboundOrigin;
  payload: OutboundPayload;
  sentBy?: string | null;
  isOptOutConfirmation?: boolean;
  now?: Date;
}

export interface QueueOutboundResult {
  outboundId: string | null; // null when the dedupe key already existed
  decision: PolicyDecision;
}

/** Must be called inside a transaction. Records the policy decision; enqueues the send if allowed. */
export async function queueOutbound(tx: Tx, boss: Boss, i: QueueOutboundInput): Promise<QueueOutboundResult> {
  const payload = OutboundPayload.parse(i.payload);
  const conv = await tx.query<{ owner_mode: "BOT" | "HUMAN"; last_inbound_at: Date | null; contact_id: string }>(
    `SELECT owner_mode, last_inbound_at, contact_id FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [i.tenantId, i.conversationId],
  );
  const c = conv.rows[0];
  if (!c) throw new Error(`Conversation ${i.conversationId} not found for tenant`);

  const optedOut = await isOptedOut(tx, i.tenantId, c.contact_id);
  const decision = evaluatePolicy({
    origin: i.origin,
    payload,
    ownerMode: c.owner_mode,
    lastInboundAt: c.last_inbound_at,
    optedOut,
    isOptOutConfirmation: i.isOptOutConfirmation,
    now: i.now ?? new Date(),
  });

  const ins = await tx.query<{ id: string }>(
    `INSERT INTO outbound_messages
       (tenant_id, conversation_id, dedupe_key, origin, sent_by, payload_json, policy_result, policy_reason, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [
      i.tenantId,
      i.conversationId,
      i.dedupeKey,
      i.origin,
      i.sentBy ?? null,
      payload,
      decision.result,
      decision.reason,
      decision.result === "ALLOW" ? "queued" : "blocked",
    ],
  );
  const outboundId = ins.rows[0]?.id ?? null;
  if (outboundId && decision.result === "ALLOW") {
    await sendInTx(boss, tx, QUEUES.send, { outbound_id: outboundId, tenant_id: i.tenantId } satisfies SendJob);
  }
  if (outboundId) {
    await writeAudit(tx, {
      tenant_id: i.tenantId,
      actor_type: i.origin === "human" ? "user" : "system",
      actor_id: i.sentBy ?? null,
      action: decision.result === "ALLOW" ? "outbound.queued" : "outbound.blocked",
      entity_type: "outbound_message",
      entity_id: outboundId,
      details: { reason: decision.reason, kind: payload.kind, dedupe_key: i.dedupeKey },
    });
  }
  return { outboundId, decision };
}

export async function isOptedOut(tx: Tx, tenantId: string, contactId: string): Promise<boolean> {
  const r = await tx.query<{ action: string }>(
    `SELECT action FROM consent_events
      WHERE tenant_id = $1 AND contact_id = $2 AND purpose = 'order_messaging'
      ORDER BY occurred_at DESC LIMIT 1`,
    [tenantId, contactId],
  );
  return r.rows[0]?.action === "opt_out";
}

export interface SendDeps {
  apiVersion: string;
  /** True on the final pg-boss attempt: a retryable error then fails the row instead of re-queueing. */
  lastAttempt?: boolean;
  graphFactory?: (token: string) => GraphClient;
}

/**
 * Send job. Marks the row 'sending' in its own committed transaction before calling WhatsApp.
 * If a previous attempt crashed after that point we cannot know whether WhatsApp accepted it,
 * so the row is failed as UNCERTAIN_SEND for an operator instead of being sent twice.
 */
export async function handleSendJob(job: SendJob, deps: SendDeps): Promise<void> {
  const claimed = await withTx(async (tx) => {
    const r = await tx.query<{
      status: string;
      payload_json: unknown;
      provider: string;
      provider_phone_id: string;
      secret_reference: string;
      phone_e164: string;
    }>(
      `SELECT o.status, o.payload_json, ca.provider, ca.provider_phone_id, ca.secret_reference, ct.phone_e164
         FROM outbound_messages o
         JOIN conversations cv ON cv.tenant_id = o.tenant_id AND cv.id = o.conversation_id
         JOIN channel_accounts ca ON ca.tenant_id = cv.tenant_id AND ca.id = cv.channel_account_id
         JOIN contacts ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contact_id
        WHERE o.tenant_id = $1 AND o.id = $2
        FOR UPDATE OF o`,
      [job.tenant_id, job.outbound_id],
    );
    const row = r.rows[0];
    if (!row) return null;
    // Chats on the testing-only WhatsApp Web bridge are sent by that bridge (apps/wa-test), not the Cloud API.
    if (row.provider === "whatsapp_test") return null;
    if (row.status === "sending") {
      await tx.query(
        `UPDATE outbound_messages SET status = 'failed', error_json = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [job.tenant_id, job.outbound_id, { code: "UNCERTAIN_SEND", message: "Previous send attempt was interrupted; not resent automatically." }],
      );
      return null;
    }
    if (row.status !== "queued") return null; // already sent, blocked or failed: idempotent no-op

    // Everything that can fail without contacting WhatsApp is checked BEFORE the row is marked
    // 'sending', so such failures are reported plainly instead of looking like an interrupted send.
    let token: string;
    try {
      token = resolveSecret(row.secret_reference);
    } catch {
      await tx.query(
        `UPDATE outbound_messages SET status = 'failed', error_json = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [job.tenant_id, job.outbound_id, { code: "CHANNEL_NOT_CONFIGURED", message: "WhatsApp is not connected yet (access token missing)." }],
      );
      return null;
    }
    await tx.query(`UPDATE outbound_messages SET status = 'sending', updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
      job.tenant_id,
      job.outbound_id,
    ]);
    return { ...row, token };
  });
  if (!claimed) return;

  const payload = OutboundPayload.parse(claimed.payload_json);
  const graph = (deps.graphFactory ?? ((t) => new GraphClient({ accessToken: t, apiVersion: deps.apiVersion })))(claimed.token);
  try {
    const providerId = await graph.sendMessage(claimed.provider_phone_id, claimed.phone_e164, payload);
    await withTx((tx) =>
      tx.query(
        `UPDATE outbound_messages SET status = 'sent', provider_id = $3, sent_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [job.tenant_id, job.outbound_id, providerId],
      ),
    );
  } catch (err) {
    const retryable = (err instanceof GraphApiError ? err.retryable : false) && !deps.lastAttempt;
    const error = err instanceof GraphApiError ? { message: err.message, http: err.httpStatus, ...((err.details as object) ?? {}) } : { message: String(err) };
    await withTx((tx) =>
      tx.query(
        `UPDATE outbound_messages SET status = $3, error_json = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [job.tenant_id, job.outbound_id, retryable ? "queued" : "failed", error],
      ),
    );
    if (retryable) throw err; // pg-boss retries with backoff
  }
}
