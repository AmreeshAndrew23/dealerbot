import { describe, expect, it } from "vitest";
import { InboundEvent } from "@fmcg/contracts";
import {
  evaluatePolicy,
  GraphApiError,
  GraphClient,
  keywordIntent,
  normaliseMessage,
  signMetaPayload,
  splitWebhook,
  verifyMetaSignature,
  baseMime,
} from "../src";
import { buttonReplyWebhook, PHONE_ID, statusWebhook, textWebhook, voiceWebhook } from "./fixtures";

const ACC = "66666666-6666-4666-8666-666666666666";

describe("signature", () => {
  const body = Buffer.from(JSON.stringify(textWebhook()));
  it("accepts a correct signature over the raw body", () => {
    expect(verifyMetaSignature(body, signMetaPayload(body, "s3cret"), "s3cret")).toBe(true);
  });
  it("rejects wrong secret, tampered body, missing or malformed header", () => {
    const sig = signMetaPayload(body, "s3cret");
    expect(verifyMetaSignature(body, sig, "other")).toBe(false);
    expect(verifyMetaSignature(Buffer.concat([body, Buffer.from(" ")]), sig, "s3cret")).toBe(false);
    expect(verifyMetaSignature(body, undefined, "s3cret")).toBe(false);
    expect(verifyMetaSignature(body, "sha1=abc", "s3cret")).toBe(false);
    expect(verifyMetaSignature(body, "sha256=zz", "s3cret")).toBe(false);
  });
  it("rejects everything when no app secret is configured", () => {
    expect(verifyMetaSignature(body, signMetaPayload(body, ""), "")).toBe(false);
  });
});

describe("splitWebhook", () => {
  it("creates one message event with a stable key", () => {
    const ev = splitWebhook(textWebhook({ id: "wamid.A" }));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "message", event_key: "msg:wamid.A", provider_phone_id: PHONE_ID });
  });
  it("gives each status transition its own key", () => {
    expect(splitWebhook(statusWebhook("sent"))[0]!.event_key).toBe("status:wamid.OUT1:sent");
    expect(splitWebhook(statusWebhook("read"))[0]!.event_key).toBe("status:wamid.OUT1:read");
  });
  it("ignores other objects and fields", () => {
    expect(splitWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(splitWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "account_update", value: {} }] }] })).toEqual([]);
    expect(splitWebhook(null)).toEqual([]);
  });
});

describe("normaliseMessage", () => {
  const norm = (b: unknown) => {
    const e = splitWebhook(b)[0]!;
    if (e.kind !== "message") throw new Error("expected message");
    return normaliseMessage("ev-1", ACC, e.payload);
  };
  it("normalises text into the PRD event shape", () => {
    const n = norm(textWebhook({ text: "ProductA100g 2 case" }));
    expect(InboundEvent.parse(n)).toBeTruthy();
    expect(n).toMatchObject({ sender: "+919876543210", type: "text", text: "ProductA100g 2 case", sender_profile_name: "Murugan Stores" });
    expect(n.occurred_at).toBe("2025-11-12T10:00:00.000Z");
  });
  it("keeps Tamil text intact", () => {
    expect(norm(textWebhook({ text: "2 பெட்டி பிஸ்கட்" })).text).toBe("2 பெட்டி பிஸ்கட்");
  });
  it("normalises voice notes with media details", () => {
    const n = norm(voiceWebhook());
    expect(n.type).toBe("audio");
    expect(n.media).toEqual({ provider_media_id: "1027433742343409", mime_type: "audio/ogg; codecs=opus", voice: true, filename: null });
  });
  it("normalises button replies and the replied-to message", () => {
    const n = norm(buttonReplyWebhook());
    expect(n.type).toBe("interactive_reply");
    expect(n.interactive).toEqual({ reply_id: "confirm:tok123", title: "Confirm" });
    expect(n.reply_to_provider_message_id).toBe("wamid.SUMMARY1");
  });
});

describe("policy gate", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  const recent = new Date("2026-11-12T09:00:00Z");
  const old = new Date("2026-11-10T09:00:00Z");
  const text = { kind: "text", text: "hi" } as const;
  const tpl = { kind: "template" as const, name: "order_ready", language: "en", body_params: [] as string[] };

  it("allows free-form inside the 24h window", () => {
    expect(evaluatePolicy({ origin: "bot", payload: text, ownerMode: "BOT", lastInboundAt: recent, optedOut: false, now }).result).toBe("ALLOW");
  });
  it("requires a template outside the window", () => {
    expect(evaluatePolicy({ origin: "bot", payload: text, ownerMode: "BOT", lastInboundAt: old, optedOut: false, now })).toEqual({ result: "DENY", reason: "OUTSIDE_SERVICE_WINDOW" });
    expect(evaluatePolicy({ origin: "bot", payload: tpl, ownerMode: "BOT", lastInboundAt: old, optedOut: false, now })).toEqual({ result: "ALLOW", reason: "APPROVED_TEMPLATE" });
    expect(evaluatePolicy({ origin: "bot", payload: text, ownerMode: "BOT", lastInboundAt: null, optedOut: false, now }).result).toBe("DENY");
  });
  it("silences the bot during human takeover but lets humans and system notices through", () => {
    expect(evaluatePolicy({ origin: "bot", payload: text, ownerMode: "HUMAN", lastInboundAt: recent, optedOut: false, now })).toEqual({ result: "DENY", reason: "HUMAN_TAKEOVER" });
    expect(evaluatePolicy({ origin: "human", payload: text, ownerMode: "HUMAN", lastInboundAt: recent, optedOut: false, now }).result).toBe("ALLOW");
    expect(evaluatePolicy({ origin: "system", payload: text, ownerMode: "HUMAN", lastInboundAt: recent, optedOut: false, now }).result).toBe("ALLOW");
  });
  it("honours opt-out for everyone except the confirmation", () => {
    expect(evaluatePolicy({ origin: "human", payload: tpl, ownerMode: "BOT", lastInboundAt: recent, optedOut: true, now })).toEqual({ result: "DENY", reason: "OPTED_OUT" });
    expect(evaluatePolicy({ origin: "system", payload: text, ownerMode: "BOT", lastInboundAt: recent, optedOut: true, isOptOutConfirmation: true, now }).result).toBe("ALLOW");
  });
});

describe("keywords", () => {
  it("detects opt-out / opt-in in English and Tamil", () => {
    expect(keywordIntent("STOP")).toBe("opt_out");
    expect(keywordIntent(" stop. ")).toBe("opt_out");
    expect(keywordIntent("நிறுத்து")).toBe("opt_out");
    expect(keywordIntent("Start")).toBe("opt_in");
    expect(keywordIntent("stop the biscuits order")).toBeNull();
  });
});

describe("GraphClient", () => {
  function fakeFetch(status: number, json: unknown, capture: { url?: string; body?: any; auth?: string } = {}) {
    return (async (url: string, init: RequestInit) => {
      capture.url = url;
      capture.body = init.body ? JSON.parse(String(init.body)) : undefined;
      capture.auth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  it("sends reply buttons in Cloud API format and returns the wamid", async () => {
    const cap: any = {};
    const g = new GraphClient({ accessToken: "TOKEN", apiVersion: "v23.0", fetchImpl: fakeFetch(200, { messages: [{ id: "wamid.X" }] }, cap) });
    const id = await g.sendMessage(PHONE_ID, "+919876543210", {
      kind: "buttons",
      body: "1. Product A 100g x 2 CASE",
      buttons: [{ id: "confirm", title: "Confirm" }, { id: "change", title: "Change" }, { id: "staff", title: "Talk to staff" }],
    });
    expect(id).toBe("wamid.X");
    expect(cap.url).toBe(`https://graph.facebook.com/v23.0/${PHONE_ID}/messages`);
    expect(cap.auth).toBe("Bearer TOKEN");
    expect(cap.body.to).toBe("919876543210");
    expect(cap.body.interactive.action.buttons).toHaveLength(3);
  });

  it("classifies errors as retryable or permanent", async () => {
    const err = async (status: number, code?: number) => {
      const g = new GraphClient({ accessToken: "T", apiVersion: "v23.0", fetchImpl: fakeFetch(status, { error: { message: "x", code } }) });
      return g.sendMessage(PHONE_ID, "+919876543210", { kind: "text", text: "hi" }).then(
        () => { throw new Error("expected failure"); },
        (e: GraphApiError) => e,
      );
    };
    expect((await err(429)).retryable).toBe(true);
    expect((await err(503)).retryable).toBe(true);
    expect((await err(400, 131047)).retryable).toBe(false); // re-engagement: outside 24h window
    expect((await err(401, 190)).retryable).toBe(false); // expired token
  });

  it("strips mime parameters", () => {
    expect(baseMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
  });
});
