// Small shared pieces: icons, formats, a hash router (so the phone's back button works), badges.
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { ShopOrderStatus } from "./api";

const TZ = "Asia/Kolkata";
export const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: true });
export const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short" });
export const fullFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
export const dayHeading = (iso: string) => {
  const k = dayKey.format(new Date(iso));
  if (k === dayKey.format(new Date())) return "Today";
  if (k === dayKey.format(new Date(Date.now() - 86_400_000))) return "Yesterday";
  return dayFmt.format(new Date(iso));
};
/** "10:42 am" today, "Yesterday", or "17 Nov". */
export const shortWhen = (iso: string) => (dayKey.format(new Date(iso)) === dayKey.format(new Date()) ? timeFmt.format(new Date(iso)) : dayHeading(iso));
export const rupees = (v: string | number) => "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UNIT: Record<string, string> = { CASE: "case", BOX: "box", PCS: "pcs", BUNDLE: "bundle", DOZEN: "dozen", STRIP: "strip", TRAY: "tray" };
export const unit = (u: string) => UNIT[u] ?? u.toLowerCase();
const UNIT_TITLE: Record<string, string> = { CASE: "Case", BOX: "Box", PCS: "Piece", BUNDLE: "Bundle", DOZEN: "Dozen", STRIP: "Strip", TRAY: "Tray" };
export const unitTitle = (u: string) => UNIT_TITLE[u] ?? u;

const ICONS = {
  chat: "M4 5h16v10H9l-5 4V5z",
  orders: "M7 3h10a2 2 0 0 1 2 2v15l-3-2-2 2-2-2-2 2-2-2-3 2V5a2 2 0 0 1 2-2zm2 5h6M9 12h6",
  list: "M4 6h16M4 12h16M4 18h10",
  store: "M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9c0 1.7 1.3 3 3 3s2.7-1.3 2.7-3c0 1.7 1.3 3 2.3 3s2.3-1.3 2.3-3c0 1.7 1.3 3 2.7 3s3-1.3 3-3M10 20v-5h4v5",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8c0-3.3 3.1-6 7-6s7 2.7 7 6",
  send: "M4 12l16-8-6 16-3-7-7-1z",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
  chevron: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 3l-4.5-4.5",
  cart: "M3 4h2l2.4 11h10.2L20 8H6.2M10 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm7 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  repeat: "M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16m0 4v-4h4",
  close: "M6 6l12 12M18 6L6 18",
  trash: "M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  home: "M4 11l8-7 8 7v9h-5v-6h-6v6H4v-9z",
};
export type IconName = keyof typeof ICONS;
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** The assistant writes WhatsApp-style *bold*; show it as bold. */
export function rich(text: string): ReactNode {
  return text.split(/(\*[^*\n]+\*)/g).map((part, i) => (part.length > 2 && part.startsWith("*") && part.endsWith("*") ? <strong key={i}>{part.slice(1, -1)}</strong> : <Fragment key={i}>{part}</Fragment>));
}
/** Chat preview: no stars, one line. */
export const plain = (text: string) => text.replace(/\*/g, "").replace(/\s+/g, " ").trim();

// ---- routing ---------------------------------------------------------------------------------

export interface Route {
  parts: string[];
  query: URLSearchParams;
}
const read = (): Route => {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path = "", qs = ""] = raw.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs) };
};
export function useRoute(): Route {
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => setR(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}
/** In-app navigation: each step is marked, so "back" knows whether it stays inside the app. */
export const go = (path: string, replace = false) => {
  const h = `#${path}`;
  if (replace) history.replaceState(history.state, "", h);
  else history.pushState({ inApp: true }, "", h);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
};
/** Back within the app, or to `fallback` when the app was opened on this page (a link, a reload). */
export const back = (fallback = "/") => ((history.state as { inApp?: boolean } | null)?.inApp ? history.back() : go(fallback, true));

// ---- badges ---------------------------------------------------------------------------------

export const STATUS: Record<ShopOrderStatus, { label: string; tone: string }> = {
  received: { label: "Waiting for the dealer", tone: "wait" },
  accepted: { label: "Accepted", tone: "ok" },
  rejected: { label: "Not accepted", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
export function StatusBadge({ s }: { s: ShopOrderStatus }) {
  return <span className={`badge ${STATUS[s].tone}`}>{STATUS[s].label}</span>;
}

/** Dealer initials for the round avatar. */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** True on a computer-sized window (sidebar + wide tables); false on a narrow window or phone. */
const WIDE = "(min-width: 900px)";
export function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}
