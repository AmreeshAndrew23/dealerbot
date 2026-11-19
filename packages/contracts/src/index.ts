import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Normalised inbound event (PRD section 10). Provider payloads stop at the adapter; everything
// after it works with this shape only.
// ---------------------------------------------------------------------------------------------

export const InboundMessageType = z.enum([
  "text",
  "audio",
  "image",
  "document",
  "video",
  "sticker",
  "location",
  "interactive_reply",
  "reaction",
  "unsupported",
]);
export type InboundMessageType = z.infer<typeof InboundMessageType>;

export const InboundEvent = z.object({
  schema_version: z.literal(1),
  event_id: z.string().min(1),
  channel_account_id: z.string().uuid(),
  provider_message_id: z.string().min(1),
  sender: z.string().regex(/^\+\d{6,15}$/, "E.164"),
  sender_profile_name: z.string().nullable(),
  occurred_at: z.string().datetime(),
  type: InboundMessageType,
  text: z.string().nullable(),
  reply_to_provider_message_id: z.string().nullable(),
  media: z
    .object({
      provider_media_id: z.string(),
      mime_type: z.string(),
      voice: z.boolean(),
      filename: z.string().nullable(),
    })
    .nullable(),
  interactive: z.object({ reply_id: z.string(), title: z.string() }).nullable(),
});
export type InboundEvent = z.infer<typeof InboundEvent>;

// ---------------------------------------------------------------------------------------------
// Outbound payloads. Everything sent to WhatsApp is one of these and passes the policy gate.
// ---------------------------------------------------------------------------------------------

export const OutboundText = z.object({
  kind: z.literal("text"),
  text: z.string().min(1).max(4096),
});

export const OutboundButtons = z.object({
  kind: z.literal("buttons"),
  body: z.string().min(1).max(1024),
  // WhatsApp allows at most 3 reply buttons, title max 20 chars.
  buttons: z
    .array(z.object({ id: z.string().min(1).max(256), title: z.string().min(1).max(20) }))
    .min(1)
    .max(3),
});

export const OutboundTemplate = z.object({
  kind: z.literal("template"),
  name: z.string().min(1),
  language: z.string().min(2),
  body_params: z.array(z.string()).default([]),
});

export const OutboundPayload = z.discriminatedUnion("kind", [OutboundText, OutboundButtons, OutboundTemplate]);
export type OutboundPayload = z.infer<typeof OutboundPayload>;

export const OutboundOrigin = z.enum(["bot", "human", "system"]);
export type OutboundOrigin = z.infer<typeof OutboundOrigin>;

// ---------------------------------------------------------------------------------------------
// Job payloads (pg-boss queues)
// ---------------------------------------------------------------------------------------------

export const QUEUES = {
  inbound: "whatsapp-inbound",
  media: "whatsapp-media",
  send: "whatsapp-send",
} as const;

export const InboundJob = z.object({ webhook_event_id: z.string().uuid() });
export const MediaJob = z.object({ message_id: z.string().uuid(), tenant_id: z.string().uuid() });
export const SendJob = z.object({ outbound_id: z.string().uuid(), tenant_id: z.string().uuid() });
export type InboundJob = z.infer<typeof InboundJob>;
export type MediaJob = z.infer<typeof MediaJob>;
export type SendJob = z.infer<typeof SendJob>;
