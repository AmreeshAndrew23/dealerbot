// Fixed assistant texts. English + Tamil, because retailers may write in either.

export const NEUTRAL_ACK =
  "Thank you, we have received your message. Our team will get back to you shortly.\n" +
  "நன்றி, உங்கள் செய்தி எங்களுக்கு கிடைத்தது. எங்கள் குழு விரைவில் உங்களைத் தொடர்பு கொள்ளும்.";

export const OPT_OUT_CONFIRMATION =
  "You will no longer receive messages from us. Reply START to subscribe again.\n" +
  "இனி உங்களுக்கு செய்திகள் அனுப்பப்படாது. மீண்டும் பெற START என பதிலளிக்கவும்.";

export const OPT_IN_CONFIRMATION =
  "You are subscribed again. Send your order any time.\n" +
  "நீங்கள் மீண்டும் இணைந்துள்ளீர்கள். எப்போது வேண்டுமானாலும் உங்கள் ஆர்டரை அனுப்பலாம்.";

const OPT_OUT = new Set(["stop", "unsubscribe", "stop all", "நிறுத்து"]);
const OPT_IN = new Set(["start", "subscribe", "தொடங்கு"]);

export type KeywordIntent = "opt_out" | "opt_in" | null;

export function keywordIntent(text: string | null): KeywordIntent {
  if (!text) return null;
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (OPT_OUT.has(t)) return "opt_out";
  if (OPT_IN.has(t)) return "opt_in";
  return null;
}
