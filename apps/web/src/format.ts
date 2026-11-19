// Dashboard times are shown in Asia/Kolkata (stored in UTC).
const TZ = "Asia/Kolkata";

const time = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: true });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const short = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short" });
const full = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });

export function fmtTime(iso: string): string {
  return time.format(new Date(iso));
}

/** "10:42 am" today, "Yesterday", or "12 Nov". */
export function fmtRelativeDay(iso: string): string {
  const d = new Date(iso);
  const today = dayKey.format(new Date());
  const yesterday = dayKey.format(new Date(Date.now() - 86_400_000));
  const k = dayKey.format(d);
  if (k === today) return time.format(d);
  if (k === yesterday) return "Yesterday";
  return short.format(d);
}

export function fmtDayHeading(iso: string): string {
  const k = dayKey.format(new Date(iso));
  if (k === dayKey.format(new Date())) return "Today";
  if (k === dayKey.format(new Date(Date.now() - 86_400_000))) return "Yesterday";
  return short.format(new Date(iso));
}

export function sameDay(a: string, b: string): boolean {
  return dayKey.format(new Date(a)) === dayKey.format(new Date(b));
}

export function fmtFull(iso: string): string {
  return full.format(new Date(iso));
}

export function initials(name: string | null, fallback: string): string {
  const src = (name ?? "").trim() || fallback;
  const parts = src.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "#";
}

/** "+919840011111" -> "+91 98400 11111" (Indian mobiles); other numbers unchanged. */
export function fmtPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}
