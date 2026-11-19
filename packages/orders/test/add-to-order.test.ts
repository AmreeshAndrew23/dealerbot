// Extra items before the order is accepted go into the same order (user rule, 17 Nov 2026):
// while staff have not accepted it, the retailer may add, change and remove items; YES saves the
// whole order as its next version. Once accepted, extras start a new order.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCatalogueCsv } from "@fmcg/catalogue";
import { handleMessage, newDraft, type ConfirmedDraft, type DraftLine, type DraftState, type Deps, type Extraction, type Extractor, type OpenOrder } from "../src";

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

const ex = fake({
  "2 box tiger 5": { lines: [["tiger 5", "2", "box"]] },
  "1 box bourbon": { lines: [["borbon", "1", "box"]] },
  "bourbon 5 box": { lines: [["borbon", "5", "box", "set"]] },
  "remove bourbon": { lines: [["borbon", "", "", "remove"]] },
  "1 box xyzzy": { lines: [["xyzzy", "1", "box"]] },
  cancel: { intent: "cancel_order" },
});

const bourbon = products.find((p) => p.sku === "BR-BOUR-10")!;
const placedLine = (qty: number): DraftLine => {
  const base_qty = qty * bourbon.pack_units.BOX!;
  return { sku: bourbon.sku, name: bourbon.name, unit: "BOX", qty, base_unit: bourbon.base_unit, base_qty, rate: bourbon.dealer_price, amount: (base_qty * Number(bourbon.dealer_price)).toFixed(2) };
};
const OPEN: OpenOrder = { id: "order-1", order_number: "ORD-000007", lines: [placedLine(2)] };
const afterOrder = (): DraftState => ({ ...newDraft("en", true), last_order: { number: "ORD-000007", at: "2026-11-17T10:00:00Z" } });

function harness(open: OpenOrder | null, failWith?: object) {
  const saved: ConfirmedDraft[] = [];
  const deps: Partial<Deps> = {
    openOrder: async () => open,
    onConfirm: async (c) => {
      if (failWith && c.amend) throw failWith;
      saved.push(c);
      return { order_number: c.amend?.number ?? "ORD-000008", confirmed_at: new Date("2026-11-17T11:00:00Z") };
    },
  };
  return { saved, deps };
}

async function run(msgs: string[], start: DraftState, extra: Partial<Deps>) {
  let state = start;
  const replies: string[] = [];
  for (const m of msgs) {
    const t = await handleMessage(state, m, { products, extract: ex, distributorName: "Britannia Distributor", ...extra });
    state = t.state;
    replies.push(t.reply ?? "(none)");
  }
  return { state, replies, last: replies[replies.length - 1]! };
}

describe("extra items before the order is accepted", () => {
  it("are added to the same order, shown whole, and YES saves it as the next version", async () => {
    const h = harness(OPEN);
    const s = await run(["2 box tiger 5"], afterOrder(), h.deps);
    expect(s.last).toContain("Your order *ORD-000007* is not accepted yet, so I've made this change in the *same order*");
    expect(s.last).toContain("Order *ORD-000007* with your changes");
    expect(s.last).not.toContain("new order");
    expect(s.state.lines.map((l) => `${l.qty} ${l.unit} ${l.sku}`)).toEqual(["2 BOX BR-BOUR-10", "2 BOX BR-TIG-5"]);

    const y = await run(["yes"], s.state, h.deps);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.amend).toEqual({ id: "order-1", number: "ORD-000007" });
    expect(h.saved[0]!.lines).toHaveLength(2);
    expect(y.last).toContain("Order *ORD-000007* is updated");
    expect(y.last).toContain("ORDER UPDATED");
    expect(y.state.status).toBe("CONFIRMED");
    expect(y.state.amending).toBeNull();
  });

  it("more of an item already in the order increases that line", async () => {
    const h = harness(OPEN);
    const s = await run(["1 box bourbon"], afterOrder(), h.deps);
    expect(s.state.lines.map((l) => `${l.qty} ${l.unit}`)).toEqual(["3 BOX"]);
  });

  it("the retailer can change a quantity in the placed order", async () => {
    const h = harness(OPEN);
    const s = await run(["bourbon 5 box", "yes"], afterOrder(), h.deps);
    expect(h.saved[0]!.lines.map((l) => `${l.qty} ${l.unit}`)).toEqual(["5 BOX"]);
    expect(s.last).toContain("is updated");
  });

  it("removing an item works; removing every item never saves an empty order", async () => {
    const h = harness({ ...OPEN, lines: [placedLine(2), { ...placedLine(1), sku: "BR-TIG-5", name: "Tiger" }] });
    const s = await run(["remove bourbon"], afterOrder(), h.deps);
    expect(s.state.lines.map((l) => l.sku)).toEqual(["BR-TIG-5"]);

    const only = harness(OPEN);
    const e = await run(["remove bourbon"], afterOrder(), only.deps);
    expect(e.last).toContain("That would leave order *ORD-000007* empty");
    expect(e.state.lines).toEqual([]);
    expect(e.state.amending ?? null).toBeNull();
  });

  it("a message that changes nothing leaves the placed order alone", async () => {
    const h = harness(OPEN);
    const s = await run(["1 box xyzzy"], afterOrder(), h.deps);
    expect(s.state.amending ?? null).toBeNull();
    expect(s.state.lines).toEqual([]);
  });

  it("'cancel' while changing drops the changes, and a second 'cancel' asks staff", async () => {
    const h = harness(OPEN);
    const s = await run(["2 box tiger 5", "cancel", "cancel"], afterOrder(), h.deps);
    expect(s.replies[1]).toContain("I've left order *ORD-000007* as it was");
    expect(s.replies[2]).toContain("asked our team to cancel order *ORD-000007*");
    expect(h.saved).toHaveLength(0);
  });

  it("the stock the placed order already holds counts as available to it", async () => {
    // The order holds 2 box; the store has 1 more box free (12 pcs).
    const tight = products.map((p) => (p.sku === bourbon.sku ? { ...p, stock: 12 } : p));
    const h = harness(OPEN);
    const more = await handleMessage(afterOrder(), "1 box bourbon", { products: tight, extract: ex, ...h.deps });
    expect(more.state.lines.map((l) => `${l.qty} ${l.unit}`)).toEqual(["3 BOX"]);
    const tooMany = await handleMessage(afterOrder(), "bourbon 5 box", { products: tight, extract: ex, ...h.deps });
    expect(tooMany.reply).toContain("only *3 box (36 pcs)* of *Bourbon Rs10* is available");
  });
});

describe("when staff decide first", () => {
  it("accepted meanwhile: nothing is changed, and only the extra items are offered as a new order", async () => {
    const h = harness(OPEN, { closed: "APPROVED" });
    const s = await run(["2 box tiger 5", "1 box bourbon", "yes"], afterOrder(), h.deps);
    expect(s.last).toContain("Order *ORD-000007* was just accepted by our team, so it can't be changed now");
    expect(s.last).toContain("as a *new order*");
    expect(s.state.amending ?? null).toBeNull();
    expect(s.state.lines.map((l) => `${l.qty} ${l.unit} ${l.sku}`)).toEqual(["1 BOX BR-BOUR-10", "2 BOX BR-TIG-5"]);
    // YES now places a new order with just those.
    const y = await run(["yes"], s.state, harness(null).deps);
    expect(y.last).toContain("ORDER CONFIRMED");
  });

  it("only reductions and staff decided: says to ask staff, offers nothing", async () => {
    const h = harness(OPEN, { closed: "REJECTED" });
    const s = await run(["bourbon 5 box"], afterOrder(), { ...h.deps });
    const smaller = { ...s.state, lines: [placedLine(1)] };
    const r = await run(["yes"], { ...smaller, summary_hash: "x", status: "AWAITING_RETAILER" }, h.deps);
    expect(r.last).toContain("was just declined");
    expect(r.last).toContain("reply *STAFF*");
    expect(r.state.lines).toEqual([]);
  });

  it("an accepted order (not open) still starts a new order, with the note", async () => {
    const h = harness(null);
    const s = await run(["2 box tiger 5"], afterOrder(), h.deps);
    expect(s.last).toContain("can no longer be changed here, so these items start a *new order*");
  });
});
