import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCatalogueCsv } from "@fmcg/catalogue";
import { CHOOSE_LANGUAGE, handleMessage, newDraft, normalisePhone, type DraftState, type Extraction, type Extractor } from "../src";

const products = parseCatalogueCsv(readFileSync(path.resolve(__dirname, "../../../data/britannia/catalogue.csv"), "utf8")).rows.map((r) => r.product);

type Line = [product: string, qty: string, unit: string, action?: "add" | "set" | "remove"];
type Fake = Partial<Omit<Extraction, "lines">> & { lines?: Line[] };

/** Fake model: per message, what it "extracted". Tests never call the network. */
const fake = (table: Record<string, Fake>): Extractor => async (msg) => {
  const f = table[msg] ?? { intent: "other" };
  return {
    intent: f.intent ?? (f.lines?.length ? "order" : "other"),
    language: f.language ?? "en",
    choice: f.choice ?? 0,
    lines: (f.lines ?? []).map(([product_text, qty_text, unit_text, action = "add"]) => ({ action, product_text, qty_text, unit_text })),
    model: "fake",
    prompt_version: "test",
  };
};

async function run(msgs: string[], ex: Extractor, start: DraftState = newDraft("en")) {
  let state = start;
  const replies: Array<string | null> = [];
  const learn: unknown[] = [];
  for (const m of msgs) {
    const t = await handleMessage(state, m, { products, extract: ex });
    state = t.state;
    replies.push(t.reply);
    learn.push(...t.learn);
  }
  return { state, replies, learn, last: replies[replies.length - 1] ?? "" };
}

describe("order drafting: the model extracts, code decides", () => {
  it("exact names and approved aliases are priced in code, with exact rupee arithmetic", async () => {
    const msg = "2 case gudday cashew, 5 box marie gold";
    const { state, last } = await run([msg], fake({ [msg]: { lines: [["gudday cashew", "2", "case"], ["marie gold", "5", "box"]] } }));
    expect(state.status).toBe("AWAITING_RETAILER");
    expect(state.lines.map((l) => [l.sku, l.unit, l.qty, l.base_qty, l.amount])).toEqual([
      ["BR-GD-CASH-10", "CASE", 2, 288, "2476.80"],
      ["BR-MG-250", "BOX", 5, 60, "2064.00"],
    ]);
    expect(last).toContain("Added 2 case Good Day Cashew Cookies Rs10, 5 box Marie Gold 250g");
    expect(last).toContain("*Total: ₹4,540.80*");
    expect(last).toContain("STAFF");
  });

  it("short forms are never assumed: 'mb' asks which Milk Bikis, and the pick is learned", async () => {
    const ex = fake({ "2 box mb": { lines: [["mb", "2", "box"]] } });
    const asked = await run(["2 box mb"], ex);
    expect(asked.state.lines).toEqual([]);
    expect(asked.last).toMatch(/Which \*mb\*/);
    expect(asked.last).toContain("Milk Bikis Rs10");
    expect(asked.last).toContain("Milk Bikis 250g");
    const picked = await run(["1"], ex, asked.state);
    expect(picked.state.lines[0]).toMatchObject({ sku: "BR-MB-10", unit: "BOX", qty: 2 });
    expect(picked.learn).toEqual([{ kind: "picked", phrase: "mb", sku: "BR-MB-10" }]);
  });

  it("a single guess is confirmed with YES/NO; NO records the words as unmatched", async () => {
    const ex = fake({ "3 box mari gld": { lines: [["mari gld", "3", "box"]] } });
    const asked = await run(["3 box mari gld"], ex);
    expect(asked.last).toMatch(/do you mean \*Marie Gold 250g\*/);
    const yes = await run(["yes"], ex, asked.state);
    expect(yes.state.lines[0]).toMatchObject({ sku: "BR-MG-250", qty: 3 });
    expect(yes.learn).toEqual([{ kind: "picked", phrase: "mari gld", sku: "BR-MG-250" }]);
    const no = await run(["no"], ex, asked.state);
    expect(no.state.lines).toEqual([]);
    expect(no.learn).toEqual([{ kind: "unmatched", phrase: "mari gld" }]);
    expect(no.last).toMatch(/as it's printed on the pack/);
  });

  it("an answer in words is understood through the model's choice", async () => {
    const ex = fake({ "2 box good day 10": { lines: [["good day 10", "2", "box"]] }, "the butter one": { intent: "order", choice: 3 } });
    const { state } = await run(["2 box good day 10", "the butter one"], ex);
    expect(state.lines[0]).toMatchObject({ sku: "BR-GD-BUTR-10", unit: "BOX" });
  });

  it("gate 5: several close products give at most three numbered choices", async () => {
    const { state } = await run(["x"], fake({ x: { lines: [["good day 10", "2", "box"]] } }));
    const q = state.questions[0]!;
    expect(state.status).toBe("NEEDS_CLARIFICATION");
    expect(q.kind === "product" && q.choices.length).toBeLessThanOrEqual(3);
  });

  it("gate 5: a missing pack is asked, and the answer can be a local word", async () => {
    const ex = fake({ "3 bourbon": { lines: [["bourbon", "3", ""]] } });
    const { state, last } = await run(["3 bourbon"], ex);
    expect(last).toMatch(/case, box or pieces/);
    const after = await run(["petti"], ex, state);
    expect(after.state.lines[0]).toMatchObject({ sku: "BR-BOUR-10", unit: "BOX", qty: 3, base_qty: 36 });
  });

  it("'2 boxes biscuit' (a category word) needs clarification", async () => {
    const { state } = await run(["x"], fake({ x: { lines: [["biscuit", "2", "boxes"]] } }));
    expect(state.status).toBe("NEEDS_CLARIFICATION");
  });

  it("Tanglish input gets Tamil-script replies when Tamil was chosen", async () => {
    const msg = "rendu case tiger 5 anuppunga";
    const { state, last } = await run([msg], fake({ [msg]: { language: "tanglish", lines: [["tiger 5", "rendu", "case"]] } }), newDraft("ta"));
    expect(state.lines[0]).toMatchObject({ sku: "BR-TIG-5", qty: 2, unit: "CASE" });
    expect(last).toContain("2 கேஸ் Tiger Glucose Rs5 சேர்க்கப்பட்டது");
    expect(last).toContain("உங்கள் ஆர்டர்");
    expect(last).toContain("மொத்தம்");
    expect(last).not.toMatch(/pannitten|Unga order/);
  });

  it("add more, change and remove items; every change is a new version that voids confirmation", async () => {
    const ex = fake({
      a: { lines: [["bourbon", "1", "box"], ["marie gold", "2", "box"]] },
      more: { lines: [["bourbon", "2", "box", "add"]] },
      set: { lines: [["bourbon", "5", "", "set"]] },
      rm: { lines: [["marie", "", "", "remove"]] },
    });
    const confirmed = await run(["a", "yes"], ex);
    expect(confirmed.state.status).toBe("CONFIRMED");
    const s1 = await run(["a"], ex);
    const s2 = await run(["more"], ex, s1.state);
    expect(s2.state.lines.find((l) => l.sku === "BR-BOUR-10")!.qty).toBe(3);
    const s3 = await run(["set"], ex, s2.state);
    expect(s3.state.lines.find((l) => l.sku === "BR-BOUR-10")).toMatchObject({ qty: 5, unit: "BOX" });
    expect(s3.last).toContain("Changed Bourbon Rs10 to 5 box");
    const s4 = await run(["rm"], ex, s3.state);
    expect(s4.state.lines.map((l) => l.sku)).toEqual(["BR-BOUR-10"]);
    expect(s4.last).toContain("Removed 2 box Marie Gold 250g");
    expect(s4.state.version).toBe(4);
    expect(s4.state.confirmed).toBeNull();
  });

  it("unknown products are reported and recorded, never invented", async () => {
    const { state, last, learn } = await run(["x"], fake({ x: { lines: [["kurkure", "2", "box"]] } }));
    expect(state.lines).toEqual([]);
    expect(last).toContain("couldn't find *kurkure*");
    expect(learn).toEqual([{ kind: "unmatched", phrase: "kurkure" }]);
  });

  it("greetings, thanks and questions get a friendly reply without changing the order", async () => {
    const ex = fake({ hi: { intent: "greeting" }, "credit kidaikuma": { intent: "question" } });
    const { replies } = await run(["hi", "credit kidaikuma"], ex);
    expect(replies[0]).toMatch(/Hello! 🙏/);
    expect(replies[1]).toMatch(/our team/);
  });

  it("two unsuccessful answers hand the conversation to staff, and the bot then stays silent", async () => {
    const ex = fake({ x: { lines: [["good day 10", "2", "box"]] } });
    const { state, replies } = await run(["x", "hmm", "what?", "hello?"], ex);
    expect(state.status).toBe("WITH_STAFF");
    expect(replies[2]).toMatch(/team/);
    expect(replies[3]).toBeNull();
  });

  it("STAFF hands over immediately", async () => {
    const { state, last } = await run(["staff"], fake({}));
    expect(state.status).toBe("WITH_STAFF");
    expect(last).toMatch(/team/);
  });
});

describe("reply language: asked once, English or Tamil", () => {
  const ex = fake({
    "2 case gudday cashew": { language: "en", lines: [["gudday cashew", "2", "case"]] },
    "bourbon 3 box venum": { language: "tanglish", lines: [["bourbon", "3", "box"]] },
  });

  it("a new conversation asks for the language first, in both languages", async () => {
    const { state, last } = await run(["vanakkam anna"], ex, newDraft());
    expect(last.endsWith(CHOOSE_LANGUAGE)).toBe(true);
    const ta = await run(["2"], ex, state);
    expect(ta.state.lang).toBe("ta");
    expect(ta.last).toContain("தமிழில் பேசலாம்");
    expect(ta.last).toContain("வணக்கம்");
  });

  it("an order sent before choosing is kept and handled right after the choice", async () => {
    const asked = await run(["2 case gudday cashew"], ex, newDraft());
    expect(asked.last.endsWith(CHOOSE_LANGUAGE)).toBe(true);
    expect(asked.state.lines).toEqual([]);
    const after = await run(["தமிழ்"], ex, asked.state);
    expect(after.state.lines[0]).toMatchObject({ sku: "BR-GD-CASH-10", qty: 2, unit: "CASE" });
    expect(after.last).toContain("2 கேஸ் Good Day Cashew Cookies Rs10 சேர்க்கப்பட்டது");
  });

  it("the choice sticks whatever language the retailer types in, and can be changed anytime", async () => {
    const s = await run(["English", "bourbon 3 box venum"], ex, newDraft());
    expect(s.state.lang).toBe("en");
    expect(s.last).toContain("Added 3 box Bourbon Rs10");
    const t = await run(["tamil"], ex, s.state);
    expect(t.state.lang).toBe("ta");
    expect(t.last).toContain("உங்கள் ஆர்டர்");
    // Once chosen, "2" is an answer to a question, not a language switch.
    expect((await run(["2"], ex, t.state)).state.lang).toBe("ta");
  });

  it("if the retailer never chooses, Tamil script gets Tamil and anything else English", async () => {
    const s = await run(["hi", "hello", "வணக்கம்"], ex, newDraft());
    expect(s.state.lang).toBe("ta");
  });
});

describe("confirmed order: saved, then a bill-style copy", () => {
  it("YES saves the confirmed version through onConfirm and replies with the order number, shop and lines", async () => {
    const ex = fake({ a: { lines: [["gudday cashew", "2", "case"], ["bourbon", "3", "box"]] } });
    const saved: unknown[] = [];
    let state = newDraft("en");
    let reply: string | null = null;
    for (const msg of ["a", "yes"]) {
      const t = await handleMessage(state, msg, {
        products,
        extract: ex,
        shopName: "Murugan Stores",
        distributorName: "Britannia Distributor",
        onConfirm: async (c) => {
          saved.push(c);
          return { order_number: "ORD-000042", confirmed_at: new Date("2026-11-12T12:15:00Z") };
        },
      });
      state = t.state;
      reply = t.reply;
    }
    expect(reply).toContain("ORDER CONFIRMED");
    expect(reply).toContain("*Britannia Distributor*");
    expect(reply).toContain("Order No: *ORD-000042*");
    expect(reply).toContain("Shop: Murugan Stores");
    expect(reply).toMatch(/12[- ]Nov[- ]2026/); // shown in Asia/Kolkata
    expect(reply).toContain("2 case (288 pcs) × ₹8.60/pcs");
    expect(reply).toContain("*TOTAL: ₹2,786.40*");
    expect(reply).toContain("not a tax invoice");
    expect(saved).toEqual([expect.objectContaining({ version: 1, total: "2786.40", text: "yes" })]);
    expect(state.confirmed).toMatchObject({ version: 1, order_number: "ORD-000042" });
  });

  it("the Tamil bill uses Tamil labels and units", async () => {
    const ex = fake({ a: { lines: [["bourbon", "1", "box"]] } });
    let state = newDraft("ta");
    let reply: string | null = null;
    for (const msg of ["a", "சரி"]) {
      const t = await handleMessage(state, msg, {
        products,
        extract: ex,
        shopName: "முருகன் ஸ்டோர்ஸ்",
        distributorName: "Britannia Distributor",
        onConfirm: async () => ({ order_number: "ORD-000001", confirmed_at: new Date() }),
      });
      state = t.state;
      reply = t.reply;
    }
    expect(reply).toContain("ஆர்டர் எண்: *ORD-000001*");
    expect(reply).toContain("கடை: முருகன் ஸ்டோர்ஸ்");
    expect(reply).toContain("1 பெட்டி (12 பீஸ்)");
    expect(reply).toContain("*மொத்தம்: ₹103.20*");
  });
});

describe("stock: never take more than we have", () => {
  // Bourbon Rs10: box = 12, case = 144. Stock 200 pcs = 1 case + 4 box + 8 pcs.
  const withStock = (sku: string, stock: number | null) => products.map((p) => (p.sku === sku ? { ...p, stock } : p));
  const runS = async (msgs: string[], ex: Extractor, stocked: ReturnType<typeof withStock>, start = newDraft("en"), onConfirm?: Parameters<typeof handleMessage>[2]["onConfirm"]) => {
    let state = start;
    let reply: string | null = null;
    for (const m of msgs) {
      const t = await handleMessage(state, m, { products: stocked, extract: ex, onConfirm });
      state = t.state;
      reply = t.reply;
    }
    return { state, reply: reply ?? "" };
  };

  it("out of stock: the item is refused, nothing is added", async () => {
    const { state, reply } = await runS(["x"], fake({ x: { lines: [["bourbon", "2", "box"]] } }), withStock("BR-BOUR-10", 0));
    expect(state.lines).toEqual([]);
    expect(reply).toContain("Sorry, *Bourbon Rs10* is out of stock right now.");
  });

  it("not enough: says what is available, in the pack they asked for", async () => {
    const { state, reply } = await runS(["x"], fake({ x: { lines: [["bourbon", "2", "case"]] } }), withStock("BR-BOUR-10", 200));
    expect(state.lines).toEqual([]);
    expect(reply).toContain("only *1 case (200 pcs)* of *Bourbon Rs10* is available");
  });

  it("enough: accepted; adding more is checked against what is already in the order", async () => {
    const ex = fake({ a: { lines: [["bourbon", "1", "case"]] }, b: { lines: [["bourbon", "5", "box"]] }, c: { lines: [["bourbon", "4", "box"]] } });
    const one = await runS(["a"], ex, withStock("BR-BOUR-10", 200));
    expect(one.state.lines).toHaveLength(1);
    const tooMuch = await runS(["b"], ex, withStock("BR-BOUR-10", 200), one.state);
    expect(tooMuch.state.lines).toHaveLength(1);
    expect(tooMuch.reply).toContain("only *4 box (56 pcs)*");
    const fits = await runS(["c"], ex, withStock("BR-BOUR-10", 200), one.state);
    expect(fits.state.lines.map((l) => l.base_qty)).toEqual([144, 48]);
  });

  it("not tracked = unlimited", async () => {
    const { state } = await runS(["x"], fake({ x: { lines: [["bourbon", "50", "case"]] } }), withStock("BR-BOUR-10", null));
    expect(state.lines[0]).toMatchObject({ qty: 50, unit: "CASE" });
  });

  it("stock gone at the moment of confirming: nothing saved, retailer told what is left", async () => {
    const ex = fake({ a: { lines: [["bourbon", "1", "case"]] } });
    const stocked = withStock("BR-BOUR-10", 200);
    const { state, reply } = await runS(["a", "yes"], ex, stocked, newDraft("en"), async () => {
      throw Object.assign(new Error("Not enough stock"), { short: [{ sku: "BR-BOUR-10", name: "Bourbon Rs10", needed: 144, available: 20 }] });
    });
    expect(state.status).toBe("AWAITING_RETAILER");
    expect(state.confirmed).toBeNull();
    expect(reply).toContain("stock changed while you were ordering");
    expect(reply).toContain("• Bourbon Rs10: 20 pcs");
  });

  it("Tamil wording", async () => {
    const { reply } = await runS(["x"], fake({ x: { lines: [["bourbon", "2", "box"]] } }), withStock("BR-BOUR-10", 0), newDraft("ta"));
    expect(reply).toContain("*Bourbon Rs10* தற்போது கையிருப்பில் இல்லை");
  });
});

describe("price list: first reply of a conversation, and on LIST", () => {
  const ex = fake({ hi: { intent: "greeting" }, ok: { intent: "thanks" } });

  it("the first reply starts with the price list (selling rate per pack), then asks the language", async () => {
    const { state, replies } = await run(["hi"], ex, newDraft());
    expect(replies[0]!.startsWith("📋 *Price list* / 📋 *விலைப் பட்டியல்*")).toBe(true);
    expect(replies[0]).toContain("• Bourbon Rs10: ₹");
    expect(replies[0]).toContain("box (12)");
    expect(replies[0]!.endsWith(CHOOSE_LANGUAGE)).toBe(true);
    expect(state.list_sent).toBe(true);
  });

  it("is sent once: not again on the next message, nor for the next order", async () => {
    const { replies, state } = await run(["hi", "ok"], ex);
    expect(replies[0]).toContain("Price list");
    expect(replies[1]).not.toContain("Price list");
    expect(newDraft(state.lang, state.list_sent).list_sent).toBe(true);
  });

  it("LIST (or பட்டியல்) sends it again, in the chosen language, keeping the open order in view", async () => {
    const order = fake({ x: { lines: [["borbon", "2", "box"]] } });
    const s = await run(["x", "list"], order);
    expect(s.last).toContain("Price list");
    expect(s.last).toContain("Here's your order so far");
    expect(s.last).toContain("2 box (24 pcs)");
    const ta = await run(["பட்டியல்"], ex, { ...newDraft("ta"), list_sent: true });
    expect(ta.last).toContain("விலைப் பட்டியல்");
    expect(ta.last).toContain("பெட்டி (12)");
  });

  it("never shows the purchase rate, and marks out-of-stock items", async () => {
    const stocked = products.map((p) => ({ ...p, purchase_rate: "1.23", stock: p.sku === "BR-BOUR-10" ? 0 : null }));
    const r = await handleMessage(newDraft("en"), "hi", { products: stocked, extract: ex, distributorName: "Britannia Distributor" });
    expect(r.reply).toContain("Britannia Distributor price list");
    expect(r.reply).not.toContain("1.23");
    expect(r.reply).toMatch(/Bourbon Rs10: .*\(out of stock\)/);
    expect(r.reply).not.toMatch(/Bourbon Rs30: .*out of stock/);
  });
});

describe("retailer phone numbers", () => {
  it("normalises Indian numbers written any common way, and refuses junk", () => {
    for (const raw of ["98765 43210", "+91 98765-43210", "919876543210", "09876543210", "+91-9876543210"]) expect(normalisePhone(raw)).toBe("+919876543210");
    expect(normalisePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect([normalisePhone("12345"), normalisePhone("abc"), normalisePhone("")]).toEqual([null, null, null]);
  });
});
