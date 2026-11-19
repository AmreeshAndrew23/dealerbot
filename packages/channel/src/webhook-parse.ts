// Turns a Meta WhatsApp webhook body into individual storable events, and a stored message
// event into the normalised InboundEvent. This is the only code that knows Meta's payload shape.
import type { InboundEvent, InboundMessageType } from "@fmcg/contracts";

export type RawWebhookEvent =
  | {
      kind: "message";
      event_key: string;
      provider_phone_id: string;
      payload: { message: MetaMessage; profile_name: string | null };
    }
  | { kind: "status"; event_key: string; provider_phone_id: string; payload: { status: MetaStatus } };

export interface MetaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  context?: { id?: string };
  text?: { body?: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  image?: { id: string; mime_type?: string; caption?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; caption?: string; filename?: string };
  sticker?: { id: string; mime_type?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { payload?: string; text?: string };
  reaction?: { message_id?: string; emoji?: string };
}

export interface MetaStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  timestamp: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

/** Splits one webhook body into per-message and per-status events with stable dedupe keys. */
export function splitWebhook(body: unknown): RawWebhookEvent[] {
  const out: RawWebhookEvent[] = [];
  const b = body as { object?: string; entry?: Array<{ changes?: Array<{ field?: string; value?: any }> }> };
  if (b?.object !== "whatsapp_business_account" || !Array.isArray(b.entry)) return out;
  for (const entry of b.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const v = change.value;
      const phoneId: string | undefined = v.metadata?.phone_number_id;
      if (!phoneId) continue;
      const profiles = new Map<string, string>();
      for (const c of v.contacts ?? []) if (c?.wa_id) profiles.set(String(c.wa_id), c.profile?.name ?? null);
      for (const m of (v.messages ?? []) as MetaMessage[]) {
        if (!m?.id) continue;
        out.push({
          kind: "message",
          event_key: `msg:${m.id}`,
          provider_phone_id: phoneId,
          payload: { message: m, profile_name: profiles.get(String(m.from)) ?? null },
        });
      }
      for (const s of (v.statuses ?? []) as MetaStatus[]) {
        if (!s?.id || !s.status) continue;
        out.push({
          kind: "status",
          event_key: `status:${s.id}:${s.status}`,
          provider_phone_id: phoneId,
          payload: { status: s },
        });
      }
    }
  }
  return out;
}

export function toE164(waId: string): string {
  const digits = waId.replace(/\D/g, "");
  return `+${digits}`;
}

const MEDIA_TYPES = ["audio", "image", "video", "document", "sticker"] as const;

/** Builds the normalised event for a stored message payload. */
export function normaliseMessage(
  eventId: string,
  channelAccountId: string,
  payload: { message: MetaMessage; profile_name: string | null },
): InboundEvent {
  const m = payload.message;
  let type: InboundMessageType = "unsupported";
  let text: string | null = null;
  let media: InboundEvent["media"] = null;
  let interactive: InboundEvent["interactive"] = null;

  switch (m.type) {
    case "text":
      type = "text";
      text = m.text?.body ?? null;
      break;
    case "interactive": {
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
      if (r) {
        type = "interactive_reply";
        interactive = { reply_id: r.id, title: r.title };
        text = r.title;
      }
      break;
    }
    case "button": // quick-reply button on a template message
      type = "interactive_reply";
      interactive = { reply_id: m.button?.payload ?? "", title: m.button?.text ?? "" };
      text = m.button?.text ?? null;
      break;
    case "location":
      type = "location";
      text = m.location ? [m.location.name, m.location.address].filter(Boolean).join(", ") || null : null;
      break;
    case "reaction":
      type = "reaction";
      text = m.reaction?.emoji ?? null;
      break;
    default:
      if ((MEDIA_TYPES as readonly string[]).includes(m.type)) {
        const part = (m as any)[m.type] as { id: string; mime_type?: string; voice?: boolean; caption?: string; filename?: string };
        if (part?.id) {
          type = m.type as InboundMessageType;
          text = part.caption ?? null;
          media = {
            provider_media_id: part.id,
            mime_type: part.mime_type ?? "application/octet-stream",
            voice: Boolean(part.voice),
            filename: part.filename ?? null,
          };
        }
      }
  }

  return {
    schema_version: 1,
    event_id: eventId,
    channel_account_id: channelAccountId,
    provider_message_id: m.id,
    sender: toE164(m.from),
    sender_profile_name: payload.profile_name,
    occurred_at: new Date(Number(m.timestamp) * 1000).toISOString(),
    type,
    text,
    reply_to_provider_message_id: m.context?.id ?? null,
    media,
    interactive,
  };
}
