// Every assistant reply, in English or Tamil (Tamil script). The retailer chooses the language once;
// they may still type in Tanglish or English letters. Written by code, never by the model, so a price
// or quantity can only ever be one that the catalogue and the draft computed (architecture 8.3).
// Wording rule (4.1): "confirmed" / "created" never implies dispatch or guaranteed delivery.

export type ReplyLang = "en" | "ta";

export interface SummaryLine {
  name: string;
  qty: number;
  unit: string;
  base_qty: number;
  base_unit: string;
  amount: string;
}

export const inr = (rupees: string | number) =>
  "₹" + Number(rupees).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const hi = (name?: string) => (name ? ` ${name}` : "");

/** "17 Nov" (India time). */
const fmtDay = (d: Date, lang: ReplyLang) =>
  new Date(d).toLocaleDateString(lang === "ta" ? "ta-IN" : "en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** Order status as a retailer should read it (never implies dispatch or delivery). */
const EN_STATUS: Record<string, string> = {
  READY_FOR_REVIEW: "waiting for our team to check",
  APPROVED: "accepted",
  EXPORTING: "accepted",
  EXPORTED: "accepted",
  EXPORT_UNCERTAIN: "accepted",
  EXPORT_FAILED: "accepted",
  REJECTED: "not accepted",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
};
const TA_STATUS: Record<string, string> = {
  READY_FOR_REVIEW: "எங்கள் குழு சரிபார்க்கக் காத்திருக்கிறது",
  APPROVED: "ஏற்றுக்கொள்ளப்பட்டது",
  EXPORTING: "ஏற்றுக்கொள்ளப்பட்டது",
  EXPORTED: "ஏற்றுக்கொள்ளப்பட்டது",
  EXPORT_UNCERTAIN: "ஏற்றுக்கொள்ளப்பட்டது",
  EXPORT_FAILED: "ஏற்றுக்கொள்ளப்பட்டது",
  REJECTED: "ஏற்றுக்கொள்ளப்படவில்லை",
  CANCELLED: "ரத்து செய்யப்பட்டது",
  EXPIRED: "காலாவதியானது",
};

export interface Messages {
  lang: ReplyLang;
  unit(u: string): string;
  greeting(name?: string): string;
  languageSet: string;
  howToOrder: string;
  added(items: string[]): string;
  updated(item: string, to: string): string;
  removed(item: string): string;
  notInOrder(item: string): string;
  notFound(items: string[]): string;
  summaryTitle: string;
  total: string;
  confirmPrompt: string;
  whichProduct(phrase: string): string;
  didYouMean(phrase: string, name: string): string;
  sendExactName(phrase: string): string;
  whichPack(name: string): string;
  howMany(name: string, unit: string): string;
  replyWithNumber: string;
  didNotUnderstand: string;
  confirmed(name?: string): string;
  nothingToConfirm: string;
  cancelled: string;
  nothingToCancel: string;
  thanks: string;
  question: string;
  handoff: string;
  outOfStock(name: string): string;
  onlyAvailable(name: string, amount: string): string;
  stockChanged: string;
  changeAndConfirm: string;
  /** Reply to a plain "ok": acknowledgements never place an order. */
  confirmNudge: string;
  /** "remove good day" when several Good Days are in the order. */
  whichOneInOrder(phrase: string, names: string[]): string;
  /** "bourbon 3" when Bourbon is in the order in two packs. */
  whichPackToChange(name: string, packs: string[]): string;
  /** First item after a confirmed order that can no longer change: it starts a separate order. */
  newOrderNote(orderNumber: string): string;
  /** Items sent while the last order still waits for review: they go into that order. */
  amendingNote(orderNumber: string): string;
  /** Title of the summary while changing a placed order. */
  amendTitle(orderNumber: string): string;
  /** The change was saved as the next version of the same order. */
  orderUpdated(orderNumber: string, name?: string): string;
  /** Staff decided on the order while the retailer was changing it. */
  orderClosedNow(orderNumber: string, status: string, hasNewItems: boolean): string;
  /** "cancel" while changing a placed order: the changes go, the order stays as it was. */
  changesDiscarded(orderNumber: string): string;
  /** Every item was removed from a placed order. */
  emptyOrder(orderNumber: string): string;
  /** "cancel" after confirming: staff decide, the retailer is told so. */
  cancelRequested(orderNumber: string): string;
  ordersTitle: string;
  noOrders: string;
  orderStatusLine(orderNumber: string, status: string, total: string, when: Date, reason: string | null): string;
  /** Sent when staff decide on a confirmed order. */
  orderAccepted(orderNumber: string, total: string, distributor: string): string;
  orderRejected(orderNumber: string, reason: string | null): string;
  orderCancelled(orderNumber: string, reason: string | null): string;
  priceListTitle(distributor: string): string;
  priceListNote: string;
  outOfStockTag: string;
  listAgain: string;
}

const EN_UNITS: Record<string, string> = { CASE: "case", BOX: "box", PCS: "pcs", BUNDLE: "bundle", STRIP: "strip", TRAY: "tray", DOZEN: "dozen" };
const TA_UNITS: Record<string, string> = { CASE: "கேஸ்", BOX: "பெட்டி", PCS: "பீஸ்", BUNDLE: "கட்டு", STRIP: "ஸ்ட்ரிப்", TRAY: "ட்ரே", DOZEN: "டஜன்" };

const en: Messages = {
  lang: "en",
  unit: (u) => EN_UNITS[u] ?? u.toLowerCase(),
  greeting: (n) => `Hello${hi(n)}! 🙏 What would you like to order today?`,
  languageSet: `Great, we'll chat in English 👍 (Send *தமிழ்* anytime to switch.)`,
  howToOrder: `Just send the items, like:\n"2 case Good Day 10, 5 box Marie Gold"\nShort forms are fine too.`,
  added: (items) => `Added ${items.join(", ")} ✅`,
  updated: (item, to) => `Changed ${item} to ${to} ✅`,
  removed: (item) => `Removed ${item} ✅`,
  notInOrder: (item) => `${item} isn't in your order.`,
  notFound: (items) => `Sorry, I couldn't find *${items.join(", ")}* in our list. Could you send the name as printed on the pack?`,
  summaryTitle: `Here's your order so far 👇`,
  total: `Total`,
  confirmPrompt: `Reply *YES* to confirm, or tell me what to change.\nNeed help? Reply *STAFF*.`,
  whichProduct: (p) => `Which *${p}* would you like?`,
  didYouMean: (p, n) => `By *${p}*, do you mean *${n}*?\nReply *YES* or *NO*.`,
  sendExactName: (p) => `Okay 👍 Please send the name of *${p}* as it's printed on the pack.`,
  whichPack: (n) => `*${n}*: case, box or pieces?`,
  howMany: (n, u) => `How many ${u} of *${n}*?`,
  replyWithNumber: `Just reply with the number.`,
  didNotUnderstand: `Sorry, I didn't quite get that 🙂`,
  confirmed: (n) => `Thank you${hi(n)}! 🙏 Your order is confirmed. Our team will check it and message you here once it's accepted.`,
  nothingToConfirm: `There's nothing to confirm yet. Send me your items first 🙂`,
  cancelled: `Okay, I've cancelled this order. Send a new one anytime 👍`,
  nothingToCancel: `There's no open order to cancel 🙂`,
  thanks: `You're welcome! 😊`,
  question: `Good question. I'll ask our team to reply to you on that 🙏`,
  handoff: `Sure, I'm passing you to our team. Someone will reply here shortly 🙏`,
  outOfStock: (n) => `Sorry, *${n}* is out of stock right now.`,
  onlyAvailable: (n, a) => `Sorry, only *${a}* of *${n}* is available right now. Could you send a smaller quantity?`,
  stockChanged: `Sorry, stock changed while you were ordering. Available now:`,
  changeAndConfirm: `Please change these items, then confirm again.`,
  confirmNudge: `Shall I place this order? Reply *YES* to confirm, or tell me what to change.`,
  whichOneInOrder: (p, names) => `Which *${p}* do you mean? Your order has:\n${names.map((n) => `• ${n}`).join("\n")}\nPlease send the full name.`,
  whichPackToChange: (n, packs) => `*${n}* is in your order as ${packs.join(" and ")}. Which one should I change? For example: "${n} 3 box".`,
  newOrderNote: (o) => `Your order *${o}* can no longer be changed here, so these items start a *new order*. To change ${o}, reply *STAFF*.`,
  amendingNote: (o) => `Your order *${o}* is not accepted yet, so I've made this change in the *same order*.`,
  amendTitle: (o) => `Order *${o}* with your changes 👇`,
  orderUpdated: (o, n) => `Thank you${hi(n)}! 🙏 Order *${o}* is updated. Our team will check it and message you here once it's accepted.`,
  orderClosedNow: (o, s, more) =>
    `Order *${o}* was just ${s === "REJECTED" ? "declined" : s === "CANCELLED" ? "cancelled" : "accepted"} by our team, so it can't be changed now.` +
    (more ? ` I can send your extra items as a *new order*:` : ` To change it, reply *STAFF*.`),
  changesDiscarded: (o) => `Okay, I've left order *${o}* as it was. To cancel the whole order, send *cancel* again.`,
  emptyOrder: (o) => `That would leave order *${o}* empty, so I haven't changed it. To cancel the order, send *cancel*.`,
  cancelRequested: (o) => `I've asked our team to cancel order *${o}*. They will confirm here shortly 🙏`,
  ordersTitle: `Your recent orders:`,
  noOrders: `You haven't placed any orders yet. Send your items whenever you're ready 🙂`,
  orderStatusLine: (o, s, t, w, r) => `• *${o}* (${fmtDay(w, "en")}, ${inr(t)}): ${EN_STATUS[s] ?? "being processed"}${r ? ` (${r})` : ""}`,
  orderAccepted: (o, t, d) => `✅ Your order *${o}* (${inr(t)}) has been accepted${d ? ` by ${d}` : ""}. Thank you! 🙏`,
  orderRejected: (o, r) => `Sorry, your order *${o}* could not be accepted.${r ? `\nReason: ${r}` : ""}\nReply here if you have any questions.`,
  orderCancelled: (o, r) => `Your order *${o}* has been cancelled.${r ? `\nReason: ${r}` : ""}\nReply here if you have any questions.`,
  priceListTitle: (d) => `📋 *${d ? d + " price list" : "Price list"}*`,
  priceListNote: `Your rates, per pack.`,
  outOfStockTag: `out of stock`,
  listAgain: `Send *LIST* anytime to see this again.`,
};

const ta: Messages = {
  lang: "ta",
  unit: (u) => TA_UNITS[u] ?? u.toLowerCase(),
  greeting: (n) => `வணக்கம்${hi(n)}! 🙏 இன்று என்ன ஆர்டர் செய்ய விரும்புகிறீர்கள்?`,
  languageSet: `சரி, தமிழில் பேசலாம் 👍 (ஆங்கிலத்துக்கு மாற *English* என அனுப்புங்கள்.)`,
  howToOrder: `பொருட்களை இப்படி அனுப்புங்கள்:\n"2 case Good Day 10, 5 box Marie Gold"\nசுருக்கப் பெயர்கள், தமிழ் அல்லது ஆங்கில எழுத்துகள் எதுவானாலும் பரவாயில்லை.`,
  added: (items) => `${items.join(", ")} சேர்க்கப்பட்டது ✅`,
  updated: (item, to) => `${item} ${to} ஆக மாற்றப்பட்டது ✅`,
  removed: (item) => `${item} நீக்கப்பட்டது ✅`,
  notInOrder: (item) => `${item} உங்கள் ஆர்டரில் இல்லை.`,
  notFound: (items) => `மன்னிக்கவும், *${items.join(", ")}* எங்கள் பட்டியலில் இல்லை. பாக்கெட்டில் உள்ள பெயரை அனுப்ப முடியுமா?`,
  summaryTitle: `உங்கள் ஆர்டர் 👇`,
  total: `மொத்தம்`,
  confirmPrompt: `உறுதிசெய்ய *சரி* (அல்லது *YES*) என அனுப்புங்கள், அல்லது என்ன மாற்ற வேண்டும் என்று சொல்லுங்கள்.\nஉதவி தேவைப்பட்டால் *STAFF* என அனுப்புங்கள்.`,
  whichProduct: (p) => `எந்த *${p}* வேண்டும்?`,
  didYouMean: (p, n) => `*${p}* என்றால் *${n}* தானா?\n*ஆம்* அல்லது *இல்லை* என பதில் அனுப்புங்கள்.`,
  sendExactName: (p) => `சரி 👍 *${p}*: பாக்கெட்டில் அச்சிடப்பட்டுள்ள பெயரை அனுப்புங்கள்.`,
  whichPack: (n) => `*${n}*: கேஸா, பெட்டியா, பீஸா?`,
  howMany: (n, u) => `*${n}* எத்தனை ${u} வேண்டும்?`,
  replyWithNumber: `எண்ணை மட்டும் அனுப்புங்கள்.`,
  didNotUnderstand: `மன்னிக்கவும், புரியவில்லை 🙂`,
  confirmed: (n) => `நன்றி${hi(n)}! 🙏 உங்கள் ஆர்டர் உறுதி செய்யப்பட்டது. எங்கள் குழு சரிபார்த்து, ஏற்றுக்கொண்டதும் இங்கே தெரிவிக்கும்.`,
  nothingToConfirm: `உறுதிசெய்ய இன்னும் எதுவும் இல்லை. முதலில் பொருட்களை அனுப்புங்கள் 🙂`,
  cancelled: `சரி, இந்த ஆர்டர் ரத்து செய்யப்பட்டது. புதிய ஆர்டரை எப்போது வேண்டுமானாலும் அனுப்பலாம் 👍`,
  nothingToCancel: `ரத்து செய்ய ஆர்டர் எதுவும் இல்லை 🙂`,
  thanks: `மிக்க நன்றி! 😊`,
  question: `நல்ல கேள்வி. இதற்கு எங்கள் குழு உங்களுக்குப் பதில் அளிக்கும் 🙏`,
  handoff: `சரி, உங்களை எங்கள் குழுவுடன் இணைக்கிறேன். விரைவில் இங்கே பதில் வரும் 🙏`,
  outOfStock: (n) => `மன்னிக்கவும், *${n}* தற்போது கையிருப்பில் இல்லை.`,
  onlyAvailable: (n, a) => `மன்னிக்கவும், *${n}* தற்போது *${a}* மட்டுமே உள்ளது. குறைவான அளவு அனுப்புகிறீர்களா?`,
  stockChanged: `மன்னிக்கவும், நீங்கள் ஆர்டர் செய்யும்போது கையிருப்பு மாறிவிட்டது. தற்போது உள்ளவை:`,
  changeAndConfirm: `இந்தப் பொருட்களை மாற்றி, மீண்டும் உறுதிசெய்யுங்கள்.`,
  confirmNudge: `இந்த ஆர்டரை உறுதிசெய்யட்டுமா? *சரி* (அல்லது *YES*) என அனுப்புங்கள், அல்லது என்ன மாற்ற வேண்டும் என்று சொல்லுங்கள்.`,
  whichOneInOrder: (p, names) => `எந்த *${p}*? உங்கள் ஆர்டரில் உள்ளவை:\n${names.map((n) => `• ${n}`).join("\n")}\nமுழுப் பெயரை அனுப்புங்கள்.`,
  whichPackToChange: (n, packs) => `*${n}* உங்கள் ஆர்டரில் ${packs.join(", ")} என உள்ளது. எதை மாற்ற வேண்டும்? உதாரணம்: "${n} 3 box".`,
  newOrderNote: (o) => `உங்கள் ஆர்டர் *${o}* ஐ இனி இங்கே மாற்ற முடியாது; இந்தப் பொருட்கள் *புதிய ஆர்டராக* பதிவாகும். ${o} ஐ மாற்ற *STAFF* என அனுப்புங்கள்.`,
  amendingNote: (o) => `உங்கள் ஆர்டர் *${o}* இன்னும் ஏற்றுக்கொள்ளப்படவில்லை; அதனால் இந்த மாற்றத்தை *அதே ஆர்டரில்* செய்துள்ளேன்.`,
  amendTitle: (o) => `மாற்றங்களுடன் ஆர்டர் *${o}* 👇`,
  orderUpdated: (o, n) => `நன்றி${hi(n)}! 🙏 ஆர்டர் *${o}* புதுப்பிக்கப்பட்டது. எங்கள் குழு சரிபார்த்து, ஏற்றுக்கொண்டதும் இங்கே தெரிவிக்கும்.`,
  orderClosedNow: (o, s, more) =>
    `ஆர்டர் *${o}* இப்போதுதான் எங்கள் குழுவால் ${s === "REJECTED" ? "நிராகரிக்கப்பட்டது" : s === "CANCELLED" ? "ரத்து செய்யப்பட்டது" : "ஏற்றுக்கொள்ளப்பட்டது"}; அதனால் இனி மாற்ற முடியாது.` +
    (more ? ` கூடுதல் பொருட்களை *புதிய ஆர்டராக* அனுப்பலாம்:` : ` மாற்ற *STAFF* என அனுப்புங்கள்.`),
  changesDiscarded: (o) => `சரி, ஆர்டர் *${o}* ஐ முன்பு இருந்தபடியே விட்டுவிட்டேன். முழு ஆர்டரையும் ரத்து செய்ய மீண்டும் *cancel* என அனுப்புங்கள்.`,
  emptyOrder: (o) => `அப்படிச் செய்தால் ஆர்டர் *${o}* காலியாகிவிடும்; அதனால் மாற்றவில்லை. ஆர்டரை ரத்து செய்ய *cancel* என அனுப்புங்கள்.`,
  cancelRequested: (o) => `ஆர்டர் *${o}* ஐ ரத்து செய்ய எங்கள் குழுவிடம் கேட்டுள்ளேன். அவர்கள் விரைவில் இங்கே உறுதிசெய்வார்கள் 🙏`,
  ordersTitle: `உங்கள் சமீபத்திய ஆர்டர்கள்:`,
  noOrders: `நீங்கள் இன்னும் ஆர்டர் எதுவும் செய்யவில்லை. தயாரானதும் பொருட்களை அனுப்புங்கள் 🙂`,
  orderStatusLine: (o, s, t, w, r) => `• *${o}* (${fmtDay(w, "ta")}, ${inr(t)}): ${TA_STATUS[s] ?? "செயல்பாட்டில் உள்ளது"}${r ? ` (${r})` : ""}`,
  orderAccepted: (o, t, d) => `✅ உங்கள் ஆர்டர் *${o}* (${inr(t)})${d ? ` ${d} ஆல்` : ""} ஏற்றுக்கொள்ளப்பட்டது. நன்றி! 🙏`,
  orderRejected: (o, r) => `மன்னிக்கவும், உங்கள் ஆர்டர் *${o}* ஏற்றுக்கொள்ளப்படவில்லை.${r ? `\nகாரணம்: ${r}` : ""}\nகேள்விகள் இருந்தால் இங்கே பதில் அனுப்புங்கள்.`,
  orderCancelled: (o, r) => `உங்கள் ஆர்டர் *${o}* ரத்து செய்யப்பட்டது.${r ? `\nகாரணம்: ${r}` : ""}\nகேள்விகள் இருந்தால் இங்கே பதில் அனுப்புங்கள்.`,
  priceListTitle: (d) => `📋 *${d ? d + " விலைப் பட்டியல்" : "விலைப் பட்டியல்"}*`,
  priceListNote: `உங்களுக்கான விலை, ஒவ்வொரு பேக்கிற்கும்.`,
  outOfStockTag: `கையிருப்பில் இல்லை`,
  listAgain: `இதை மீண்டும் பார்க்க *LIST* (அல்லது *பட்டியல்*) என அனுப்புங்கள்.`,
};

export const MESSAGES: Record<ReplyLang, Messages> = { en, ta };

/** Shown before the language is known, so it is in both languages. */
export const CHOOSE_LANGUAGE = `Welcome! 🙏 Please choose your language.\nவணக்கம்! 🙏 உங்கள் மொழியைத் தேர்ந்தெடுக்கவும்.\n\n1. English\n2. தமிழ்`;

const EN_CHOICE = new Set(["1", "english", "eng", "en", "inglish", "ஆங்கிலம்"]);
const TA_CHOICE = new Set(["2", "tamil", "thamizh", "tamizh", "thamil", "தமிழ்", "tamil la", "tamilla"]);

/** "English" / "தமிழ்" / "1" / "2" -> the language; anything else -> null. */
export function languageChoice(text: string, allowNumbers: boolean): ReplyLang | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (!allowNumbers && /^\d+$/.test(t)) return null;
  if (EN_CHOICE.has(t)) return "en";
  if (TA_CHOICE.has(t)) return "ta";
  return null;
}

export const qtyText = (m: Messages, qty: number, unit: string) => `${qty} ${m.unit(unit)}`;

export function summary(m: Messages, lines: SummaryLine[], total: string, title: string = m.summaryTitle): string {
  const rows = lines.map(
    (l, i) => `${i + 1}. ${l.name}\n    ${qtyText(m, l.qty, l.unit)}${l.unit !== l.base_unit ? ` (${l.base_qty} ${m.unit(l.base_unit)})` : ""} · ${inr(l.amount)}`,
  );
  return [title, ...rows, ``, `*${m.total}: ${inr(total)}*`, ``, m.confirmPrompt].join("\n");
}

// ---- bill-style confirmation ------------------------------------------------------------------

export interface BillInput {
  distributor: string;
  shop: string;
  orderNumber: string;
  at: Date;
  lines: Array<SummaryLine & { rate: string }>;
  total: string;
  /** The retailer changed an order already placed. */
  updated?: boolean;
}

const BILL_LABELS: Record<ReplyLang, Record<string, string>> = {
  en: {
    title: "🧾 *ORDER CONFIRMED*",
    updatedTitle: "🧾 *ORDER UPDATED*",
    orderNo: "Order No",
    shop: "Shop",
    date: "Date",
    items: "Items",
    total: "TOTAL",
    status: "Status: Received. Our team will review it and confirm once the order is created.",
    note: "Prices as per today's price list. This is an order copy, not a tax invoice.",
  },
  ta: {
    title: "🧾 *ஆர்டர் உறுதி செய்யப்பட்டது*",
    updatedTitle: "🧾 *ஆர்டர் புதுப்பிக்கப்பட்டது*",
    orderNo: "ஆர்டர் எண்",
    shop: "கடை",
    date: "தேதி",
    items: "பொருட்கள்",
    total: "மொத்தம்",
    status: "நிலை: பெறப்பட்டது. எங்கள் குழு சரிபார்த்து, ஆர்டர் பதிவானதும் தெரிவிக்கும்.",
    note: "இன்றைய விலைப்பட்டியல்படி விலைகள். இது ஆர்டர் நகல் மட்டுமே, வரி விலைப்பட்டியல் (tax invoice) அல்ல.",
  },
};

const RULE = "━━━━━━━━━━━━━━━━━━";
const billTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });

/** A WhatsApp-friendly order copy. Every number comes from the saved order version. */
export function bill(m: Messages, b: BillInput): string {
  const L = BILL_LABELS[m.lang];
  const rows = b.lines.map((l, i) => {
    const pack = l.unit !== l.base_unit ? ` (${l.base_qty} ${m.unit(l.base_unit)})` : "";
    return `${i + 1}. ${l.name}\n    ${qtyText(m, l.qty, l.unit)}${pack} × ${inr(l.rate)}/${m.unit(l.base_unit)}\n    = ${inr(l.amount)}`;
  });
  return [
    b.updated ? L.updatedTitle : L.title,
    `*${b.distributor}*`,
    RULE,
    `${L.orderNo}: *${b.orderNumber}*`,
    `${L.shop}: ${b.shop}`,
    `${L.date}: ${billTime.format(b.at)}`,
    RULE,
    ...rows,
    RULE,
    `${L.items}: ${b.lines.length}`,
    `*${L.total}: ${inr(b.total)}*`,
    RULE,
    L.status,
    `_${L.note}_`,
  ].join("\n");
}

// ---- price list (first message, and on "LIST") ---------------------------------------------------

export interface PriceListItem {
  name: string;
  category: string;
  base_unit: string;
  pack_units: Record<string, number>;
  /** Selling rate per base unit. The purchase rate is never passed here. */
  rate: string;
  /** Available base units; null = not tracked. */
  available: number | null;
}

const packPrice = (rate: string, per: number) => inr(Math.round(Number(rate) * 100 * per) / 100);

/** One line per product, grouped by category: "• Good Day 10: ₹8.60/pcs · box (12) ₹103.20 · case (144) ₹1,238.40". */
function priceLines(m: Messages, items: PriceListItem[]): string[] {
  const out: string[] = [];
  let cat: string | null = null;
  for (const p of items) {
    if (p.category !== cat) {
      cat = p.category;
      if (cat) out.push("", `*${cat}*`);
    }
    const packs = Object.entries(p.pack_units)
      .filter(([u]) => u !== p.base_unit)
      .sort((a, b) => a[1] - b[1])
      .map(([u, per]) => `${m.unit(u)} (${per}) ${packPrice(p.rate, per)}`);
    const soldOut = p.available !== null && p.available <= 0;
    out.push(`• ${p.name}: ${inr(p.rate)}/${m.unit(p.base_unit)}${packs.length ? " · " + packs.join(" · ") : ""}${soldOut ? ` (${m.outOfStockTag})` : ""}`);
  }
  return out;
}

/** The retailer's price list. m = null before a language is chosen (headings in both languages). */
export function priceList(m: Messages | null, distributor: string, items: PriceListItem[]): string {
  const sorted = [...items].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  if (m) return [m.priceListTitle(distributor), m.priceListNote, ...priceLines(m, sorted), "", m.listAgain].join("\n");
  return [
    `${en.priceListTitle(distributor)} / ${ta.priceListTitle("")}`,
    `${en.priceListNote} / ${ta.priceListNote}`,
    ...priceLines(en, sorted),
    "",
    en.listAgain,
  ].join("\n");
}

/** For numbers not recorded as a retailer: no prices, products or history (PRD flow E). */
export const notConnected = (distributor: string) =>
  `Sorry, this WhatsApp number is not connected to ${distributor || "us"} yet. Please contact your salesperson or our office to get it added.
` +
  `மன்னிக்கவும், இந்த WhatsApp எண் இன்னும் ${distributor ? distributor + " உடன்" : "எங்களுடன்"} இணைக்கப்படவில்லை. இணைக்க உங்கள் விற்பனையாளர் அல்லது எங்கள் அலுவலகத்தைத் தொடர்பு கொள்ளுங்கள்.`;
