// Webhook intake: persist every event and enqueue processing in ONE transaction, before the
// HTTP 200 is returned. Duplicates (same provider event key) are ignored.
import { QUEUES, type InboundJob } from "@fmcg/contracts";
import { withTx } from "@fmcg/db";
import { splitWebhook } from "./webhook-parse";
import { sendInTx, type Boss } from "./queue";

export interface IntakeResult {
  received: number;
  stored: number;
  duplicates: number;
}

export async function persistWebhook(body: unknown, boss: Boss): Promise<IntakeResult> {
  const events = splitWebhook(body);
  if (events.length === 0) return { received: 0, stored: 0, duplicates: 0 };
  return withTx(async (tx) => {
    let stored = 0;
    for (const ev of events) {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO webhook_events (provider, event_key, kind, provider_phone_id, payload_json)
         VALUES ('whatsapp_cloud', $1, $2, $3, $4)
         ON CONFLICT (provider, event_key) DO NOTHING
         RETURNING id`,
        [ev.event_key, ev.kind, ev.provider_phone_id, ev.payload],
      );
      const id = r.rows[0]?.id;
      if (id) {
        await sendInTx(boss, tx, QUEUES.inbound, { webhook_event_id: id } satisfies InboundJob);
        stored++;
      }
    }
    return { received: events.length, stored, duplicates: events.length - stored };
  });
}
