// Order drafting conversation (architecture 4.2 flows B and C, 8.3 steps 3-5). Pure logic over an
// in-memory state: the caller supplies the catalogue and an extractor and stores the state.
// The model only reports intent, language and candidate lines; code matches SKUs, converts units,
// prices lines, decides what to ask and writes every reply (messages.ts).
// Not yet persisted: orders / order_versions / confirmations arrive with E11; until retailer
// identity (E09) exists this must only be used for an already-authorised retailer (terminal tests).
import { createHash } from "node:crypto";
import { DOZEN_PIECES, matchProduct, parseQuantity, parseUnit, type LearningEvent, type ProductInput } from "@fmcg/catalogue";
import type { CandidateLine, ExtractionContext, Extractor, Intent, Language } from "./extract";
import { bill, CHOOSE_LANGUAGE, languageChoice, MESSAGES, priceList, qtyText, summary, type Messages, type ReplyLang } from "./messages";

export const MAX_FAILED_ANSWERS = 2; // then the conversation goes to staff (flow C step 4)
const MAX_CHOICES = 3;

export interface DraftLine {
  sku: string;
  name: string;
  unit: string;
  qty: number;
  base_unit: string;
  base_qty: number;
  rate: string; // per base unit, e.g. "8.60"
  amount: string; // e.g. "2476.80"
}

export type Question =
  | { kind: "product"; phrase: string; qty: number | null; unit: string | null; choices: string[] }
  | { kind: "unit"; sku: string; qty: number | null; choices: string[] }
  | { kind: "quantity"; sku: string; unit: string };

export type DraftStatus = "EMPTY" | "NEEDS_CLARIFICATION" | "AWAITING_RETAILER" | "CONFIRMED" | "WITH_STAFF";

export interface DraftState {
  status: DraftStatus;
  /** Reply language the retailer chose; null until they choose (they may type in any language). */
  lang: ReplyLang | null;
  /** A message sent before the language was chosen; handled right after the choice. */
  held: string | null;
  lang_asks: number;
  lines: DraftLine[];
  questions: Question[];
  failed_answers: number;
  /** Increments on every change to the lines; a confirmation is bound to version + summary_hash. */
  version: number;
  summary_hash: string | null;
  confirmed: { version: number; summary_hash: string; order_number?: string } | null;
  /** The price list was sent (it goes with the first reply of a conversation, and on "LIST"). */
  list_sent?: boolean;
  /** The order this conversation confirmed last: for "cancel", "where is my order" and the new-order note. */
  last_order?: { number: string; at: string; noted?: boolean } | null;
  /**
   * Changing a placed order that staff have not decided on yet: `lines` hold the whole order, and
   * YES saves them as its next version. `base` is the order as placed (for stock and "what's new").
   */
  amending?: { id: string; number: string; base: DraftLine[]; base_hash: string } | null;
}

/** A placed order the retailer may still change (staff have not decided on it). */
export interface OpenOrder {
  id: string;
  order_number: string;
  lines: DraftLine[];
}

/** Why a conversation needs a person even though the assistant replied. */
export type Attention = "question" | "cancel_request" | "handoff";

/** A placed order, as the retailer may ask about it. */
export interface OrderStatusInfo {
  order_number: string;
  status: string;
  total: string;
  at: Date;
  reason: string | null;
}

export const newDraft = (lang: ReplyLang | null = null, list_sent = false): DraftState => ({
  status: "EMPTY",
  lang,
  held: null,
  lang_asks: 0,
  lines: [],
  questions: [],
  failed_answers: 0,
  version: 0,
  summary_hash: null,
  confirmed: null,
  list_sent,
});

export interface TurnResult {
  state: DraftState;
  /** null = say nothing (the conversation is with staff). */
  reply: string | null;
  /** What retailers really typed, for staff to review as aliases (never applied automatically). */
  learn: LearningEvent[];
  trace: { intent?: Intent; language?: Language; choice?: number; extraction?: CandidateLine[]; model?: string; prompt_version?: string; unknown?: string[] };
  /** Set when staff must follow up (the caller flags the conversation on the dashboard). */
  attention?: Attention;
}

/** A new draft that keeps what belongs to the conversation, not to one order. */
const fresh = (s: DraftState): DraftState => ({ ...newDraft(s.lang, s.list_sent), last_order: s.last_order ?? null });

/**
 * Staff handed the chat back: the retailer's unconfirmed items are kept (not thrown away), and any
 * question that was pending is dropped, since the conversation has moved on.
 */
export function resumeAfterStaff(s: DraftState): DraftState {
  if (s.status !== "WITH_STAFF") return s;
  return { ...s, questions: [], failed_answers: 0, status: s.lines.length ? "AWAITING_RETAILER" : "EMPTY" };
}

export interface ConfirmedDraft {
  version: number;
  summary_hash: string;
  total: string;
  lines: DraftLine[];
  /** The retailer's confirming message (evidence). */
  text: string;
  /** Set when these lines replace a placed order (its next version) instead of starting one. */
  amend?: { id: string; number: string };
}

export interface Deps {
  /** Active products; stock = available base units (null/undefined = not tracked, unlimited). */
  products: StockedProduct[];
  extract: Extractor;
  /** Shop or person name for a friendlier greeting, e.g. "Murugan anna". */
  retailerName?: string;
  /** For the bill: the distributor's and the shop's names. */
  distributorName?: string;
  shopName?: string;
  /**
   * Saves the confirmed version (orders module) and returns its number. Without it nothing is
   * saved and the retailer gets a plain confirmation instead of a bill.
   */
  onConfirm?: (c: ConfirmedDraft) => Promise<{ order_number: string; confirmed_at: Date }>;
  /** This retailer's latest orders, newest first, for "where is my order?". */
  orderStatus?: () => Promise<OrderStatusInfo[]>;
  /**
   * This retailer's latest order that staff have not accepted yet, if any. New items, changes and
   * removals go into it (as its next version) instead of starting a separate order. onConfirm with
   * `amend` must throw `{ closed: status }` if staff decided on it meanwhile.
   */
  openOrder?: () => Promise<OpenOrder | null>;
  signal?: AbortSignal;
}

// ---- money and lines ---------------------------------------------------------------------------

const paise = (rupees: string) => {
  const [r, p = ""] = rupees.split(".");
  return Number(r) * 100 + Number((p + "00").slice(0, 2));
};
const fromPaise = (n: number) => `${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;

/** Pack units the retailer can order, largest first (CASE, BOX, PCS). */
const unitsOf = (p: ProductInput) => Object.entries(p.pack_units).sort((a, b) => b[1] - a[1]).map(([u]) => u);

function priceLine(p: ProductInput, unit: string, qty: number): DraftLine {
  const base_qty = qty * p.pack_units[unit]!;
  return { sku: p.sku, name: p.name, unit, qty, base_unit: p.base_unit, base_qty, rate: p.dealer_price, amount: fromPaise(Math.round(base_qty * paise(p.dealer_price))) };
}

/** A priced line, or the question needed before it can become one. */
function buildLine(p: ProductInput, qty: number | null, unitRaw: string | null): DraftLine | Question {
  let unit = unitRaw;
  let q = qty;
  if (unit === "DOZEN" && !("DOZEN" in p.pack_units) && p.base_unit === "PCS") {
    unit = "PCS";
    q = qty === null ? null : qty * DOZEN_PIECES;
  }
  const units = unitsOf(p);
  if (!unit) {
    if (units.length > 1) return { kind: "unit", sku: p.sku, qty: q, choices: units.slice(0, MAX_CHOICES) };
    unit = p.base_unit;
  }
  if (!(unit in p.pack_units)) return { kind: "unit", sku: p.sku, qty: q, choices: units.slice(0, MAX_CHOICES) };
  if (q === null) return { kind: "quantity", sku: p.sku, unit };
  return priceLine(p, unit, q);
}

const isQuestion = (x: DraftLine | Question): x is Question => "kind" in x;
type Item = Pick<DraftLine, "qty" | "unit" | "name">;
const label = (l: Item, m: Messages = MESSAGES.en) => `${qtyText(m, l.qty, l.unit)} ${l.name}`;
const msgs = (s: DraftState): Messages => MESSAGES[s.lang ?? "en"];
function msgsFor(s: DraftState): Messages {
  return MESSAGES[s.lang ?? "en"];
}

// ---- state transitions -------------------------------------------------------------------------

const hashLines = (lines: DraftLine[]) => createHash("sha256").update(JSON.stringify(lines.map((l) => [l.sku, l.unit, l.qty, l.rate]))).digest("hex");

function newVersion(state: DraftState): DraftState {
  const hash = hashLines(state.lines);
  if (hash === state.summary_hash) return state;
  if (!state.lines.length && !state.summary_hash) return state;
  return { ...state, version: state.version + 1, summary_hash: hash, confirmed: null };
}

function settle(state: DraftState): DraftState {
  const s = newVersion(state);
  const status: DraftStatus = s.questions.length ? "NEEDS_CLARIFICATION" : s.lines.length ? "AWAITING_RETAILER" : "EMPTY";
  return { ...s, status };
}

export type StockedProduct = ProductInput & { stock?: string | number | null };
const stockOf = (p: ProductInput | undefined): number | null => {
  const v = (p as StockedProduct | undefined)?.stock;
  return v === null || v === undefined ? null : Number(v);
};

/** Not enough stock for a request: shown to the retailer, the line is not added. */
interface Short {
  name: string;
  unit: string;
  base_unit: string;
  per: number;
  available: number;
}

interface Changes {
  short: Short[];
  added: Item[];
  updated: Item[];
  removed: Item[];
  notInOrder: string[];
  unknown: string[];
  /** Edits we could not place without guessing; each is a ready question for the retailer. */
  unclear: string[];
  learn: LearningEvent[];
}
const noChanges = (): Changes => ({ short: [], added: [], updated: [], removed: [], notInOrder: [], unknown: [], unclear: [], learn: [] });

/**
 * add = new line or more of the same pack.
 * set = the new quantity replaces `replace` (default: every line of the product). Lines replaced in a
 *       different pack are reported as removed, so nothing disappears without being mentioned.
 */
function putLine(state: DraftState, line: DraftLine, mode: "add" | "set", ch: Changes, byId: Map<string, ProductInput>, replace?: DraftLine[]): DraftState {
  const same = state.lines.find((l) => l.sku === line.sku && l.unit === line.unit);
  const sameSku = state.lines.filter((l) => l.sku === line.sku);
  const replaced = mode === "set" ? (replace ?? sameSku) : [];
  // Stock: never accept more than is available (lines of the same product already in the order count).
  const p = byId.get(line.sku)!;
  // A placed order being changed already holds its stock: that counts as available to it.
  const held = state.amending?.base.filter((l) => l.sku === line.sku).reduce((n, l) => n + l.base_qty, 0) ?? 0;
  const live = stockOf(p);
  const stock = live === null ? null : live + held;
  if (stock !== null) {
    const kept = mode === "set" ? sameSku.filter((l) => !replaced.includes(l)) : sameSku.filter((l) => l !== same);
    const keptQty = kept.reduce((n, l) => n + l.base_qty, 0);
    const wanted = mode === "add" && same ? same.base_qty + line.base_qty : line.base_qty;
    if (keptQty + wanted > stock) {
      ch.short.push({ name: line.name, unit: line.unit, base_unit: line.base_unit, per: p.pack_units[line.unit] ?? 1, available: Math.max(0, stock - keptQty) });
      return state;
    }
  }
  if (mode === "add" && same) {
    const merged = priceLine(byId.get(line.sku)!, line.unit, same.qty + line.qty);
    ch.updated.push(merged);
    return { ...state, lines: state.lines.map((l) => (l === same ? merged : l)) };
  }
  if (mode === "set" && replaced.length) {
    ch.updated.push(line);
    for (const l of replaced) if (l.unit !== line.unit) ch.removed.push(l);
    const at = state.lines.indexOf(replaced[0]!);
    const rest = state.lines.filter((l) => !replaced.includes(l));
    rest.splice(Math.min(at, rest.length), 0, line);
    return { ...state, lines: rest };
  }
  ch.added.push(line);
  return { ...state, lines: [...state.lines, line] };
}

function applyLine(state: DraftState, c: CandidateLine, products: ProductInput[], byId: Map<string, ProductInput>, ch: Changes): DraftState {
  const qty = c.qty_text ? parseQuantity(c.qty_text) : null;
  const unit = parseUnit(c.unit_text);

  if (c.action === "remove" || c.action === "set") {
    // Look in the current order first: "remove marie" means the Marie that is already there.
    const inDraft = products.filter((p) => state.lines.some((l) => l.sku === p.sku));
    const m = matchProduct(c.product_text, inDraft);
    // Several products in the order fit the words: ask, never pick one (gate 5).
    if (m.kind === "ambiguous" && m.candidates.length > 1) {
      ch.unclear.push(msgsFor(state).whichOneInOrder(c.product_text, m.candidates.map((x) => byId.get(x.sku)?.name ?? x.sku)));
      return state;
    }
    const sku = m.kind === "resolved" ? m.sku : m.kind === "ambiguous" ? m.candidates[0]!.sku : null;
    if (c.action === "remove") {
      if (!sku) {
        ch.notInOrder.push(c.product_text);
        return state;
      }
      const gone = state.lines.filter((l) => l.sku === sku && (!unit || l.unit === unit));
      gone.forEach((l) => ch.removed.push(l));
      return { ...state, lines: state.lines.filter((l) => !gone.includes(l)) };
    }
    if (sku) {
      const lines = state.lines.filter((l) => l.sku === sku);
      const inPack = unit ? lines.filter((l) => l.unit === unit) : [];
      // In the order in two packs and no pack named: ask which one changes.
      if (lines.length > 1 && !unit) {
        const mm = msgsFor(state);
        ch.unclear.push(mm.whichPackToChange(lines[0]!.name, lines.map((l) => qtyText(mm, l.qty, l.unit))));
        return state;
      }
      const r = buildLine(byId.get(sku)!, qty, unit ?? lines[0]!.unit);
      if (isQuestion(r)) return { ...state, questions: [...state.questions, r] };
      // "bourbon 3 box" changes the box line only; a pack not in the order replaces them all (reported).
      return putLine(state, r, "set", ch, byId, inPack.length ? inPack : lines);
    }
    // "set" for something not yet ordered is simply an order for it.
  }

  // Picked from the price list in the app: the exact product, no matching needed.
  const picked = (c as CartLine).sku;
  const m: ReturnType<typeof matchProduct> = picked && byId.has(picked) ? { kind: "resolved", sku: picked, candidates: [] } : matchProduct(c.product_text, products);
  if (m.kind === "none") {
    ch.unknown.push(c.product_text);
    ch.learn.push({ kind: "unmatched", phrase: c.product_text });
    return state;
  }
  if (m.kind === "ambiguous") {
    return { ...state, questions: [...state.questions, { kind: "product", phrase: c.product_text, qty, unit, choices: m.candidates.map((x) => x.sku) }] };
  }
  const r = buildLine(byId.get(m.sku)!, qty, unit);
  if (isQuestion(r)) return { ...state, questions: [...state.questions, r] };
  return putLine(state, r, c.action === "set" ? "set" : "add", ch, byId);
}

/** Resolves the first pending question with option n (1-based) or a parsed value. */
function answerQuestion(state: DraftState, value: { n?: number; text?: string }, byId: Map<string, ProductInput>, ch: Changes): DraftState | null {
  const q = state.questions[0];
  if (!q) return null;
  const rest = state.questions.slice(1);
  const n = value.n;
  let result: DraftLine | Question | null = null;
  if (q.kind === "product" && n && n >= 1 && n <= q.choices.length) {
    const sku = q.choices[n - 1]!;
    result = buildLine(byId.get(sku)!, q.qty, q.unit);
    ch.learn.push({ kind: "picked", phrase: q.phrase, sku });
  } else if (q.kind === "unit") {
    const u = n && n >= 1 && n <= q.choices.length ? q.choices[n - 1]! : value.text ? parseUnit(value.text) : null;
    if (u && q.choices.includes(u)) result = buildLine(byId.get(q.sku)!, q.qty, u);
  } else if (q.kind === "quantity") {
    const qty = n ?? (value.text ? parseQuantity(value.text) : null);
    if (qty) result = buildLine(byId.get(q.sku)!, qty, q.unit);
  }
  if (!result) return null;
  const s = { ...state, questions: rest, failed_answers: 0 };
  return isQuestion(result) ? { ...s, questions: [result, ...rest] } : putLine(s, result, "add", ch, byId);
}

// ---- reply text --------------------------------------------------------------------------------

function optionsOf(q: Question, byId: Map<string, ProductInput>, m: Messages): string[] {
  if (q.kind === "product") return q.choices.map((s) => byId.get(s)?.name ?? s);
  if (q.kind === "unit") {
    const p = byId.get(q.sku)!;
    return q.choices.map((u) => (u === p.base_unit ? m.unit(u) : `${m.unit(u)} (${p.pack_units[u]} ${m.unit(p.base_unit)})`));
  }
  return [];
}

function questionText(q: Question, m: Messages, byId: Map<string, ProductInput>): string {
  const opts = optionsOf(q, byId, m).map((o, i) => `${i + 1}. ${o}`);
  if (q.kind === "product" && q.choices.length === 1) return m.didYouMean(q.phrase, byId.get(q.choices[0]!)?.name ?? q.choices[0]!);
  if (q.kind === "product") return [m.whichProduct(q.phrase), ...opts, m.replyWithNumber].join("\n");
  const p = byId.get(q.sku)!;
  if (q.kind === "unit") return [m.whichPack(p.name), ...opts, m.replyWithNumber].join("\n");
  return m.howMany(p.name, q.unit);
}

/** "1 case (144 pcs)" in the pack the retailer asked for, or just pieces. */
function stockText(m: Messages, x: Short): string {
  if (x.available <= 0) return `0 ${m.unit(x.base_unit)}`;
  const packs = Math.floor(x.available / x.per);
  if (x.unit !== x.base_unit && packs >= 1) return `${packs} ${m.unit(x.unit)} (${x.available} ${m.unit(x.base_unit)})`;
  return `${x.available} ${m.unit(x.base_unit)}`;
}

function orderText(state: DraftState, m: Messages): string {
  const total = fromPaise(state.lines.reduce((t, l) => t + paise(l.amount), 0));
  return summary(m, state.lines, total, state.amending ? m.amendTitle(state.amending.number) : undefined);
}

/** Acknowledge what changed, then ask the next question or show the order. */
function compose(state: DraftState, ch: Changes, byId: Map<string, ProductInput>, lead?: string): string {
  const m = msgs(state);
  const parts: string[] = [];
  if (lead) parts.push(lead);
  const acks: string[] = [];
  if (ch.added.length) acks.push(m.added(ch.added.map((l) => label(l, m))));
  for (const l of ch.updated) acks.push(m.updated(l.name, qtyText(m, l.qty, l.unit)));
  for (const item of ch.removed) acks.push(m.removed(label(item, m)));
  for (const item of ch.notInOrder) acks.push(m.notInOrder(item));
  if (acks.length) parts.push(acks.join("\n"));
  if (ch.unknown.length) parts.push(m.notFound(ch.unknown));
  parts.push(...ch.unclear);
  for (const x of ch.short) parts.push(x.available <= 0 ? m.outOfStock(x.name) : m.onlyAvailable(x.name, stockText(m, x)));
  if (state.questions[0]) parts.push(questionText(state.questions[0], m, byId));
  else if (state.lines.length) parts.push(orderText(state, m));
  else if (!ch.unknown.length && !ch.removed.length && !ch.short.length && !ch.unclear.length) parts.push(m.howToOrder);
  return parts.join("\n\n");
}

// ---- cart from the app's price list -------------------------------------------------------------

/** One product the retailer picked on the price list screen. */
export interface CartItem {
  sku: string;
  unit: string;
  qty: number;
}
type CartLine = CandidateLine & { sku?: string };

/**
 * The cart as a chat message plus an extractor that returns exactly those lines, so the order goes
 * through the same rules as typed text (stock, adding to an open order, summary, YES) but without
 * the model: the products, packs and quantities were picked from the list, nothing is guessed.
 * Items for products or packs the dealer no longer sells are left out and reported in `dropped`.
 */
export function cartMessage(items: CartItem[], products: ProductInput[], lang: ReplyLang | null): { text: string; extract: Extractor; dropped: string[] } {
  const byId = new Map(products.map((p) => [p.sku, p]));
  const m = MESSAGES[lang ?? "en"];
  const ok = items.filter((i) => byId.get(i.sku)?.active !== false && byId.get(i.sku)?.pack_units[i.unit] !== undefined && Number.isInteger(i.qty) && i.qty > 0);
  const dropped = items.filter((i) => !ok.includes(i)).map((i) => byId.get(i.sku)?.name ?? i.sku);
  const lines: CartLine[] = ok.map((i) => ({ action: "add", product_text: byId.get(i.sku)!.name, qty_text: String(i.qty), unit_text: i.unit, sku: i.sku }));
  const text = ok.map((i) => `${qtyText(m, i.qty, i.unit)} ${byId.get(i.sku)!.name}`).join("\n");
  const extract: Extractor = async () => ({ intent: "order", language: lang === "ta" ? "ta" : "en", choice: 0, lines, model: "cart", prompt_version: "cart" });
  return { text, extract, dropped };
}

// ---- one retailer message ---------------------------------------------------------------------

// Clear agreement only. A bare "ok" is how people acknowledge a message, so it never places an order.
const YES = new Set(["yes", "y", "yes confirm", "confirm", "confirmed", "confirm order", "place order", "sari", "seri", "sariyana", "aama", "ama", "haan", "podunga", "anuppunga", "ஆம்", "ஆமா", "சரி"]);
const ACK = new Set(["ok", "okay", "k", "kk", "ok ok", "oki", "okie", "oke", "done", "fine", "correct", "sure", "ஓகே", "👍", "👌", "🙏", "👍🏻", "👍🏼", "👍🏽"]);
const NO = new Set(["no", "n", "nope", "illa", "illai", "ille", "venda", "vendam", "wrong", "இல்லை", "இல்ல", "வேண்டாம்"]);
const STAFF = new Set(["staff", "talk to staff", "human", "agent", "manager", "call me", "ஊழியர்"]);
const norm = (t: string) => t.trim().toLowerCase().replace(/[.!?]+$/, "");

/** Pure greetings ("hi", "vanakkam anna"): nothing to keep for after the language choice. Anything else may be an order. */
const GREETING_WORDS = new Set(["hi", "hii", "hiii", "hello", "helo", "hai", "hey", "vanakkam", "vanakam", "namaste", "namaskaram", "anna", "akka", "sir", "madam", "bro", "boss", "thambi", "good", "morning", "evening", "afternoon", "gm", "ok", "okay", "வணக்கம்", "அண்ணா", "சார்"]);
const isSmallTalk = (text: string) => {
  const words = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return words.every((w) => GREETING_WORDS.has(w));
};

/**
 * "10" or "rs 10" to "1. Bourbon Rs10  2. Bourbon Rs30": the words name exactly one option, so that
 * option is the answer (an option number is handled before this). Never a guess: every word must be
 * in that option's name and in no other's.
 */
const FILLER = new Set(["rs", "rupees", "rupee", "the", "one", "wala", "vala", "that", "this", "pack", "packet", "ah", "a"]);
const words = (t: string) =>
  t.toLowerCase().replace(/₹/g, " ").replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2").split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
function optionNamed(text: string, names: string[]): number | null {
  const said = words(text).filter((w) => !FILLER.has(w));
  if (!said.length || said.length > 4) return null;
  const hits = names.map((n, i) => (said.every((w) => words(n).includes(w)) ? i + 1 : 0)).filter(Boolean);
  return hits.length === 1 ? hits[0]! : null;
}

const singleChoice = (s: DraftState) => {
  const q = s.questions[0];
  return q?.kind === "product" && q.choices.length === 1 ? q : null;
};

const LIST_WORDS = new Set(["list", "price list", "pricelist", "rate list", "ratelist", "price", "prices", "rate", "rates", "menu", "items", "catalogue", "catalog", "stock list", "rate enna", "vilai", "vilai pattiyal", "பட்டியல்", "விலை", "விலைப் பட்டியல்", "விலை பட்டியல்"]);

const listFor = (m: Messages | null, deps: Deps) =>
  priceList(
    m,
    deps.distributorName ?? "",
    deps.products.map((p) => ({ name: p.name, category: p.category, base_unit: p.base_unit, pack_units: p.pack_units, rate: p.dealer_price, available: p.stock == null ? null : Number(p.stock) })),
  );

/**
 * One retailer message -> the next state and reply. The first reply of a conversation starts with
 * the price list (selling rates only), so the retailer can answer from it.
 */
export async function handleMessage(prev: DraftState, text: string, deps: Deps): Promise<TurnResult> {
  let r = await turn(prev, text, deps);
  // The first items after a confirmed order start a separate order: say so once, so the retailer
  // does not think they were added to the order the team is already checking.
  const last = r.state.last_order;
  const hadLines = prev.status !== "CONFIRMED" && prev.lines.length > 0;
  if (last && !last.noted && !hadLines && !r.state.amending && r.state.lines.length > 0 && r.state.status !== "CONFIRMED" && r.reply !== null) {
    const m = MESSAGES[r.state.lang ?? "en"];
    r = { ...r, state: { ...r.state, last_order: { ...last, noted: true } }, reply: `${m.newOrderNote(last.number)}\n\n${r.reply}` };
  }
  if (prev.list_sent || r.state.list_sent || r.reply === null || !deps.products.length) return r;
  return { ...r, state: { ...r.state, list_sent: true }, reply: `${listFor(r.state.lang ? MESSAGES[r.state.lang] : null, deps)}\n\n${r.reply}` };
}

async function turn(prev: DraftState, text: string, deps: Deps): Promise<TurnResult> {
  const byId = new Map(deps.products.map((p) => [p.sku, p]));
  const t = norm(text);
  const ch = noChanges();
  let trace: TurnResult["trace"] = {};
  const say = (state: DraftState, reply: string | null, attention?: Attention): TurnResult => ({ state, reply, learn: ch.learn, trace, ...(attention ? { attention } : {}) });
  const handoff = (state: DraftState) => say({ ...state, status: "WITH_STAFF", questions: [] }, msgs(state).handoff, "handoff");
  const done = (state: DraftState, lead?: string) => {
    const s = { ...settle(state), failed_answers: 0 };
    return say(s, compose(s, ch, byId, lead));
  };

  if (STAFF.has(t)) return handoff(prev);
  // Conversation ownership HUMAN: automated replies are dropped (architecture 5.3, gate 11).
  if (prev.status === "WITH_STAFF") return say(prev, null);

  let state = prev.status === "CONFIRMED" ? fresh(prev) : prev;

  // Reply language: asked once, in both languages. The retailer may still type in any language.
  const chosen = languageChoice(text, state.lang === null);
  if (chosen) {
    const held = state.held;
    state = { ...state, lang: chosen, held: null };
    const m = msgs(state);
    if (held) {
      const next = await turn(state, held, deps);
      return { ...next, learn: [...ch.learn, ...next.learn], reply: next.reply === null ? null : `${m.languageSet}\n\n${next.reply}` };
    }
    return say(state, compose(state, ch, byId, `${m.languageSet}\n\n${m.greeting(deps.retailerName)}`));
  }
  if (state.lang === null) {
    // Keep everything that is not a pure greeting (it may be an order, even without a number) and
    // ask once more at most. Several such messages are kept together.
    const held = isSmallTalk(text) ? state.held : state.held ? `${state.held}\n${text}` : text;
    if (state.lang_asks < 2) return say({ ...state, held, lang_asks: state.lang_asks + 1 }, CHOOSE_LANGUAGE);
    // Still no choice: Tamil script gets Tamil, anything else English (both can switch later),
    // and what they sent earlier is handled now instead of being dropped.
    state = { ...state, lang: /[஀-௿]/.test(`${held ?? ""} ${text}`) ? "ta" : "en", held: null };
    if (held) {
      const next = await turn(state, held, deps);
      return { ...next, learn: [...ch.learn, ...next.learn], reply: next.reply === null ? null : `${msgs(state).languageSet}\n\n${next.reply}` };
    }
  }
  if (LIST_WORDS.has(t) && deps.products.length) {
    const m = msgs(state);
    // Keep an open order in view under the list.
    const open = state.lines.length || state.questions.length ? compose(state, ch, byId) : m.howToOrder;
    return say({ ...state, list_sent: true }, `${listFor(m, deps)}\n\n${open}`);
  }
  const confirm = async (s: DraftState) => {
    const m = msgs(s);
    const confirmed = { version: s.version, summary_hash: s.summary_hash! };
    if (!deps.onConfirm) return say({ ...s, status: "CONFIRMED", confirmed }, m.confirmed(deps.retailerName));
    const total = fromPaise(s.lines.reduce((sum, l) => sum + paise(l.amount), 0));
    const amend = s.amending ? { id: s.amending.id, number: s.amending.number } : undefined;
    let saved: { order_number: string; confirmed_at: Date };
    try {
      saved = await deps.onConfirm({ ...confirmed, total, lines: s.lines, text, ...(amend ? { amend } : {}) });
    } catch (e) {
      const closed = (e as { closed?: string }).closed;
      if (closed && s.amending) return orderClosed(s, closed);
      const short = (e as { short?: Array<{ sku: string; available: number }> }).short;
      if (!short) throw e;
      // Someone else took the stock while this retailer was ordering: nothing was saved.
      const items = short.map((x) => {
        const l = s.lines.find((y) => y.sku === x.sku)!;
        const per = byId.get(x.sku)?.pack_units[l.unit] ?? 1;
        return `• ${l.name}: ${stockText(m, { name: l.name, unit: l.unit, base_unit: l.base_unit, per, available: x.available })}`;
      });
      return say(s, [m.stockChanged, ...items, "", m.changeAndConfirm].join("\n"));
    }
    const copy = bill(m, {
      distributor: deps.distributorName ?? "",
      shop: deps.shopName ?? deps.retailerName ?? "-",
      orderNumber: saved.order_number,
      at: saved.confirmed_at,
      lines: s.lines,
      total,
      updated: !!amend,
    });
    return say(
      {
        ...s,
        status: "CONFIRMED",
        amending: null,
        confirmed: { ...confirmed, order_number: saved.order_number },
        last_order: { number: saved.order_number, at: new Date(saved.confirmed_at).toISOString() },
      },
      `${amend ? m.orderUpdated(saved.order_number, deps.retailerName) : m.confirmed(deps.retailerName)}\n\n${copy}`,
    );
  };
  /**
   * Staff accepted (or declined) the order while the retailer was changing it. Nothing was saved.
   * Only the extra quantities can still go, as a new order the retailer confirms; reductions and
   * removals cannot, so they are not carried over (the message says to ask staff when nothing is new).
   */
  const orderClosed = (s: DraftState, status: string) => {
    const a = s.amending!;
    const extra: DraftLine[] = [];
    for (const l of s.lines) {
      const before = a.base.filter((b) => b.sku === l.sku && b.unit === l.unit).reduce((n, b) => n + b.qty, 0);
      const p = byId.get(l.sku);
      if (p && l.qty > before) extra.push(priceLine(p, l.unit, l.qty - before));
    }
    const next = settle({ ...fresh(s), lines: extra, last_order: s.last_order ? { ...s.last_order, noted: true } : null });
    const m = msgs(next);
    const head = m.orderClosedNow(a.number, status, extra.length > 0);
    return say(next, extra.length ? `${head}\n\n${orderText(next, m)}` : head);
  };
  /** "No" to "Did you mean X?": drop the guess and ask for the name as printed. */
  const declineGuess = (s: DraftState) => {
    const q = singleChoice(s)!;
    ch.learn.push({ kind: "unmatched", phrase: q.phrase });
    const next = settle({ ...s, questions: s.questions.slice(1) });
    const m = msgs(next);
    return say(next, [m.sendExactName(q.phrase), next.questions[0] ? questionText(next.questions[0], m, byId) : ""].filter(Boolean).join("\n\n"));
  };

  // Fast paths that need no model.
  // "ok" may answer "Did you mean X?" (nothing is ordered by that), but never places the order.
  if ((YES.has(t) || ACK.has(t)) && singleChoice(state)) {
    const a = answerQuestion(state, { n: 1 }, byId, ch);
    if (a) return done(a);
  }
  if (NO.has(t) && singleChoice(state)) return declineGuess(state);
  if (YES.has(t) && state.status === "AWAITING_RETAILER" && state.summary_hash) return confirm(state);
  if (ACK.has(t) && state.status === "AWAITING_RETAILER" && state.summary_hash) return say(state, msgs(state).confirmNudge);
  if (state.questions.length) {
    const n = /^\s*(\d{1,2})\s*$/.exec(text);
    const a = answerQuestion(state, n ? { n: Number(n[1]) } : { text }, byId, ch);
    if (a) return done(a);
    const q = state.questions[0]!;
    const named = q.kind === "product" ? optionNamed(text, optionsOf(q, byId, MESSAGES.en)) : null;
    const b = named ? answerQuestion(state, { n: named }, byId, ch) : null;
    if (b) return done(b);
  }

  const ctx: ExtractionContext = {
    draftItems: state.lines.map((l) => label(l)),
    pendingOptions: state.questions[0] ? optionsOf(state.questions[0], byId, MESSAGES.en) : undefined,
  };
  const ex = await deps.extract(text, ctx, deps.signal);
  trace = { intent: ex.intent, language: ex.language, choice: ex.choice, extraction: ex.lines, model: ex.model, prompt_version: ex.prompt_version };
  const m = msgs(state);

  if (ex.intent === "talk_to_staff") return handoff(state);

  // An answer in words ("the cashew one", "mudhal onnu", "aama", "periya pack").
  let lines = ex.lines;
  if (state.questions.length) {
    const q = state.questions[0]!;
    const pick = ex.choice > 0 ? ex.choice : ex.intent === "confirm" && singleChoice(state) ? 1 : 0;
    const a = pick ? answerQuestion(state, { n: pick }, byId, ch) : null;
    if (a) {
      state = a;
      // The model sometimes also returns the chosen product as a line ("10" -> choice 1 and
      // "Bourbon Rs10"). That is the answer, not a second item: drop it unless it has a quantity.
      const answered = q.kind === "product" ? q.choices[pick - 1] : q.sku;
      lines = lines.filter((c) => {
        if (c.qty_text || c.action !== "add") return true;
        const mm = matchProduct(c.product_text, deps.products);
        return !(mm.kind === "resolved" ? mm.sku === answered : mm.kind === "ambiguous" && mm.candidates.some((x) => x.sku === answered));
      });
    }
  }

  if (lines.length) {
    // Nothing open in the chat, but the last order still waits for review: the items (and any
    // changes or removals) go into that order, which the retailer then confirms again.
    const before = state;
    let lead: string | undefined;
    if (!state.lines.length && !state.questions.length && !state.amending && deps.openOrder) {
      const open = await deps.openOrder();
      if (open?.lines.length) {
        const base_hash = hashLines(open.lines);
        state = { ...state, lines: open.lines, summary_hash: base_hash, amending: { id: open.id, number: open.order_number, base: open.lines, base_hash } };
        lead = m.amendingNote(open.order_number);
      }
    }
    for (const c of lines) state = applyLine(state, c, deps.products, byId, ch);
    trace.unknown = ch.unknown;
    const a = state.amending;
    if (a && !state.questions.length) {
      // Everything removed: never save an empty order (cancelling is for staff).
      if (!state.lines.length) return say(fresh(before), m.emptyOrder(a.number));
      // Nothing actually changed (unknown item, out of stock...): leave the placed order alone.
      if (hashLines(state.lines) === a.base_hash && lead) return done(before);
    }
    return done(state, lead);
  }
  if (ch.added.length || ch.updated.length) return done(state);

  switch (ex.intent) {
    case "confirm":
      if (state.status === "AWAITING_RETAILER" && state.summary_hash) return confirm(state);
      if (state.questions[0]) return say(state, questionText(state.questions[0], m, byId));
      return say(state, m.nothingToConfirm);
    case "cancel_order":
      if (singleChoice(state)) return declineGuess(state);
      // Changing a placed order: "cancel" drops the changes; the order stays as placed.
      if (state.amending) return say({ ...fresh(state), last_order: state.last_order ? { ...state.last_order, noted: true } : null }, m.changesDiscarded(state.amending.number));
      if (!state.lines.length && !state.questions.length) {
        // Nothing open, but an order was placed: only staff can cancel it, so ask them (and say so).
        if (state.last_order) return say(state, m.cancelRequested(state.last_order.number), "cancel_request");
        return say(state, m.nothingToCancel);
      }
      return say({ ...fresh(state), version: state.version }, m.cancelled);
    case "greeting":
      return say(state, compose(state, ch, byId, m.greeting(deps.retailerName)));
    case "thanks":
      return say(state, state.questions[0] ? `${m.thanks}\n\n${questionText(state.questions[0], m, byId)}` : m.thanks);
    case "order_status":
      if (deps.orderStatus) {
        const orders = (await deps.orderStatus()).slice(0, 3);
        const text = orders.length ? [m.ordersTitle, ...orders.map((o) => m.orderStatusLine(o.order_number, o.status, o.total, o.at, o.reason))].join("\n") : m.noOrders;
        return say(state, state.questions[0] ? `${text}\n\n${questionText(state.questions[0], m, byId)}` : text);
      }
    // Without order access, staff answer it like any other question.
    // falls through
    case "question":
      // The reply promises that the team will answer, so the conversation is flagged for them.
      return say(state, state.questions[0] ? `${m.question}\n\n${questionText(state.questions[0], m, byId)}` : m.question, "question");
  }

  // Nothing understood.
  const pending = state.questions[0];
  if (pending) {
    const failed = state.failed_answers + 1;
    if (failed >= MAX_FAILED_ANSWERS) return handoff({ ...state, failed_answers: failed });
    return say({ ...state, failed_answers: failed }, `${m.didNotUnderstand}\n\n${questionText(pending, m, byId)}`);
  }
  return say(state, compose(state, ch, byId));
}
