// Fixes from the chat-flow review of 17 Nov 2026: each test is one mistake that was found by
// running real conversations, and must not come back.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCatalogueCsv } from "@fmcg/catalogue";
import { handleMessage, newDraft, resumeAfterStaff, type DraftState, type Deps, type Extraction, type Extractor } from "../src";

const products = parseCatalogueCsv(readFileSync(path.resolve(__dirname, "../../../data/britannia/catalogue.csv"), "utf8")).rows.map((r) => r.product);
type L = [string, string, string, ("add" | "set" | "remove")?];
const fake =
  (t: Record<string, Partial<Omit<Extraction, "lines">> & { lines?: L[] }>): Extractor =>
  async (msg) => {
    const f = t[msg] ?? { intent: "other" };
    return {
      intent: f.intent ?? (f.lines?.length ? "order" : "other"),
      language: "en",
      choice: f.choice ?? 0,
      lines: (f.lines ?? []).map(([product_text, qty_text, unit_text, action = "add"]) => ({ action, product_text, qty_text, unit_text })),
      model: "fake",
      prompt_version: "test",
    };
  };

let n = 0;
const onConfirm: Deps["onConfirm"] = async () => ({ order_number: `ORD-0000${++n}`, confirmed_at: new Date("2026-11-17T10:00:00Z") });

async function run(msgs: string[], ex: Extractor, start: DraftState, extra: Partial<Deps> = {}) {
  let state = start;
  const replies: string[] = [];
  const attention: Array<string | undefined> = [];
  for (const m of msgs) {
    const t = await handleMessage(state, m, { products, extract: ex, onConfirm, distributorName: "Britannia Distributor", ...extra });
    state = t.state;
    replies.push(t.reply ?? "(none)");
    attention.push(t.attention);
  }
  return { state, replies, attention, last: replies[replies.length - 1]! };
}
const ready = (): DraftState => ({ ...newDraft("en"), list_sent: true });
const one = fake({ x: { lines: [["borbon", "1", "box"]] } });

describe("a bare 'ok' never places an order", () => {
  it("asks for a clear YES instead", async () => {
    const s = await run(["x", "ok"], one, ready());
    expect(s.state.status).toBe("AWAITING_RETAILER");
    expect(s.last).toContain("Shall I place this order?");
    const y = await run(["yes"], one, s.state);
    expect(y.state.status).toBe("CONFIRMED");
  });

  it("'ok' still answers 'Did you mean X?' (that orders nothing yet)", async () => {
    const ex = fake({ x: { lines: [["gudday cashw", "1", "box"]] } });
    const s = await run(["x"], ex, ready());
    if (s.state.questions[0]?.kind === "product" && s.state.questions[0].choices.length === 1) {
      const a = await run(["ok"], ex, s.state);
      expect(a.state.lines).toHaveLength(1);
      expect(a.state.status).not.toBe("CONFIRMED");
    }
  });
});

describe("answering 'which one?' (chat of 18 Nov 2026: 2 pcs became 5)", () => {
  const ask = fake({ "add bourban 2 pcs": { lines: [["bourban", "2", "pcs"]] } });

  it("'10' to 'Bourbon Rs10 / Bourbon Rs30' picks Rs10 without the model, and adds 2 pcs once", async () => {
    const s = await run(["add bourban 2 pcs"], ask, ready());
    expect(s.last).toContain("Which *bourban*");
    let called = false;
    const spy: Extractor = async (m, c, sig) => ((called = true), ask(m, c, sig));
    const a = await run(["10"], spy, s.state);
    expect(called).toBe(false);
    expect(a.state.lines.map((l) => `${l.qty} ${l.unit} ${l.sku}`)).toEqual(["2 PCS BR-BOUR-10"]);
    expect(a.state.questions).toEqual([]);
    expect((await run(["rs 30"], ask, s.state)).state.lines.map((l) => l.sku)).toEqual(["BR-BOUR-30"]);
  });

  it("the model's choice plus the same product as a line counts once", async () => {
    // What gpt-4.1 really returned for "10": choice 1 and a quantity-less "Bourbon Rs10" line.
    const live: Extractor = async (m, c, sig) =>
      m === "the ten rupee one"
        ? { intent: "order", language: "en", choice: 1, lines: [{ action: "add", product_text: "Bourbon Rs10", qty_text: "", unit_text: "" }], model: "fake", prompt_version: "test" }
        : ask(m, c, sig);
    const s = await run(["add bourban 2 pcs", "the ten rupee one"], live, ready());
    expect(s.state.lines.map((l) => `${l.qty} ${l.unit} ${l.sku}`)).toEqual(["2 PCS BR-BOUR-10"]);
    expect(s.state.questions).toEqual([]);
    expect(s.last).not.toContain("case, box or pieces");
  });
});

describe("messages sent before the language is chosen are kept", () => {
  it("an order followed by two greetings is handled, not dropped", async () => {
    const ex = fake({ "2 case gudday cashew": { lines: [["gudday cashew", "2", "case"]] }, hi: { intent: "greeting" }, hello: { intent: "greeting" } });
    const s = await run(["2 case gudday cashew", "hi", "hello"], ex, newDraft());
    expect(s.state.lang).toBe("en");
    expect(s.state.lines[0]).toMatchObject({ sku: "BR-GD-CASH-10", qty: 2, unit: "CASE" });
    expect(s.last).toContain("we'll chat in English");
  });

  it("an order without a number is kept too (only pure greetings are not)", async () => {
    const ex = fake({ "marie gold venum": { lines: [["marie gold", "", ""]] } });
    const s = await run(["marie gold venum", "1"], ex, newDraft());
    expect(s.state.questions.length + s.state.lines.length).toBeGreaterThan(0);
    expect(s.last).not.toContain("What would you like to order today");
  });

  it("two order messages before choosing are both kept", async () => {
    const ex = fake({ "2 box bourbon 10": { lines: [["borbon", "2", "box"]] }, "1 box tiger 5": { lines: [["tiger 5", "1", "box"]] }, "2 box bourbon 10\n1 box tiger 5": { lines: [["borbon", "2", "box"], ["tiger 5", "1", "box"]] } });
    const s = await run(["2 box bourbon 10", "1 box tiger 5", "2"], ex, newDraft());
    expect(s.state.lines.map((l) => l.sku).sort()).toEqual(["BR-BOUR-10", "BR-TIG-5"]);
  });
});

describe("edits never guess", () => {
  const two = fake({
    x: { lines: [["gudday cashew", "1", "box"], ["good day butter", "1", "box"]] },
    "remove good day": { lines: [["good day", "", "", "remove"]] },
    "remove good day butter": { lines: [["good day butter", "", "", "remove"]] },
  });

  it("'remove good day' with two Good Days asks which one and removes nothing", async () => {
    const s = await run(["x", "remove good day"], two, ready());
    expect(s.state.lines).toHaveLength(2);
    expect(s.last).toContain("Which *good day* do you mean?");
    expect(s.last).toContain("Good Day Cashew Cookies Rs10");
    expect(s.last).toContain("Good Day Butter Cookies Rs10");
    const r = await run(["remove good day butter"], two, s.state);
    expect(r.state.lines.map((l) => l.sku)).toEqual(["BR-GD-CASH-10"]);
  });

  const packs = fake({
    x: { lines: [["borbon", "1", "case"], ["borbon", "2", "box"]] },
    "bourbon 3 box": { lines: [["borbon", "3", "box", "set"]] },
    "bourbon 5": { lines: [["borbon", "5", "", "set"]] },
    "bourbon 1 pcs only": { lines: [["borbon", "1", "pcs", "set"]] },
  });

  it("changing the box quantity keeps the case line", async () => {
    const s = await run(["x", "bourbon 3 box"], packs, ready());
    expect(s.state.lines.map((l) => `${l.qty} ${l.unit}`)).toEqual(["1 CASE", "3 BOX"]);
  });

  it("a quantity without a pack, when the product is in two packs, asks which pack", async () => {
    const s = await run(["x", "bourbon 5"], packs, ready());
    expect(s.state.lines.map((l) => `${l.qty} ${l.unit}`)).toEqual(["1 CASE", "2 BOX"]);
    expect(s.last).toContain("is in your order as 1 case and 2 box");
  });

  it("a pack not in the order replaces both, and says what was removed", async () => {
    const s = await run(["x", "bourbon 1 pcs only"], packs, ready());
    expect(s.state.lines.map((l) => `${l.qty} ${l.unit}`)).toEqual(["1 PCS"]);
    expect(s.last).toContain("Removed 1 case Bourbon Rs10");
    expect(s.last).toContain("Removed 2 box Bourbon Rs10");
  });
});

describe("after an order is confirmed", () => {
  const ex = fake({
    x: { lines: [["borbon", "1", "box"]] },
    "cancel the order": { intent: "cancel_order" },
    "add 2 box tiger 5": { lines: [["tiger 5", "2", "box"]] },
    "1 box marie gold 10": { lines: [["marie gold 10", "1", "box"]] },
    "en order enna aachu": { intent: "order_status" },
  });

  it("'cancel' asks staff to cancel it, says so, and flags the chat", async () => {
    const s = await run(["x", "yes", "cancel the order"], ex, ready());
    const no = s.state.last_order!.number;
    expect(s.last).toContain(`asked our team to cancel order *${no}*`);
    expect(s.attention[2]).toBe("cancel_request");
  });

  it("new items start a separate order, and the retailer is told so once", async () => {
    const s = await run(["x", "yes", "add 2 box tiger 5", "1 box marie gold 10"], ex, ready());
    const no = s.state.last_order!.number;
    expect(s.replies[2]).toContain(`Your order *${no}* can no longer be changed here, so these items start a *new order*`);
    expect(s.state.lines.map((l) => l.sku)).toEqual(["BR-TIG-5", "BR-MG-10"]);
    expect(s.replies[3]).not.toContain("new order");
  });

  it("'where is my order?' answers from the orders, in the retailer's language", async () => {
    const orderStatus = async () => [
      { order_number: "ORD-000012", status: "APPROVED", total: "1238.40", at: new Date("2026-11-17T05:00:00Z"), reason: null },
      { order_number: "ORD-000011", status: "REJECTED", total: "103.20", at: new Date("2026-11-16T05:00:00Z"), reason: "Out of stock" },
    ];
    const s = await run(["en order enna aachu"], ex, ready(), { orderStatus });
    expect(s.last).toContain("*ORD-000012*");
    expect(s.last).toContain("accepted");
    expect(s.last).toContain("not accepted (Out of stock)");
    expect(s.attention[0]).toBeUndefined();
    const ta = await run(["en order enna aachu"], ex, { ...ready(), lang: "ta" }, { orderStatus });
    expect(ta.last).toContain("ஏற்றுக்கொள்ளப்பட்டது");
  });

  it("without order access the status question goes to staff", async () => {
    const s = await run(["en order enna aachu"], ex, ready());
    expect(s.attention[0]).toBe("question");
  });

  it("the confirmation promises a message when the order is accepted", async () => {
    const s = await run(["x", "yes"], ex, ready());
    expect(s.last).toContain("message you here once it's accepted");
  });
});

describe("staff are told when the assistant promises a person", () => {
  it("a question is flagged", async () => {
    const s = await run(["credit tharuvingala"], fake({ "credit tharuvingala": { intent: "question" } }), ready());
    expect(s.last).toContain("our team");
    expect(s.attention[0]).toBe("question");
  });

  it("STAFF is flagged as a handoff", async () => {
    const s = await run(["staff"], one, ready());
    expect(s.state.status).toBe("WITH_STAFF");
    expect(s.attention[0]).toBe("handoff");
  });

  it("handing the chat back keeps the retailer's unconfirmed items", async () => {
    const s = await run(["x", "staff"], one, ready());
    const back = resumeAfterStaff(s.state);
    expect(back.status).toBe("AWAITING_RETAILER");
    expect(back.lines).toHaveLength(1);
    const y = await run(["yes"], one, back);
    expect(y.state.status).toBe("CONFIRMED");
  });
});
