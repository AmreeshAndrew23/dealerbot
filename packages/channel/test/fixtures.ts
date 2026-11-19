// Payload shapes as documented for WhatsApp Cloud API webhooks.
export const PHONE_ID = "106540352242922";

export function textWebhook(opts: { id?: string; from?: string; text?: string; ts?: number; phoneId?: string } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550783881", phone_number_id: opts.phoneId ?? PHONE_ID },
              contacts: [{ profile: { name: "Murugan Stores" }, wa_id: opts.from ?? "919876543210" }],
              messages: [
                {
                  from: opts.from ?? "919876543210",
                  id: opts.id ?? "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                  timestamp: String(opts.ts ?? 1762941600),
                  type: "text",
                  text: { body: opts.text ?? "2 case Product A 100g" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function voiceWebhook() {
  const b = textWebhook();
  const v = b.entry[0]!.changes[0]!.value as any;
  v.messages = [
    {
      from: "919876543210",
      id: "wamid.VOICE1",
      timestamp: "1762941601",
      type: "audio",
      audio: { mime_type: "audio/ogg; codecs=opus", sha256: "abc", id: "1027433742343409", voice: true },
    },
  ];
  return b;
}

export function buttonReplyWebhook() {
  const b = textWebhook();
  const v = b.entry[0]!.changes[0]!.value as any;
  v.messages = [
    {
      context: { from: "15550783881", id: "wamid.SUMMARY1" },
      from: "919876543210",
      id: "wamid.BTN1",
      timestamp: "1762941602",
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "confirm:tok123", title: "Confirm" } },
    },
  ];
  return b;
}

export function statusWebhook(status: string, wamid = "wamid.OUT1", ts = 1762941700) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550783881", phone_number_id: PHONE_ID },
              statuses: [{ id: wamid, status, timestamp: String(ts), recipient_id: "919876543210" }],
            },
          },
        ],
      },
    ],
  };
}
