import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { catalogueToCsv, diffProduct, matchProduct, normaliseText, parseCatalogueCsv, parseCsv, parseQuantity, parseUnit, ProductInput } from "../src";

const HEAD = "sku_code,name,category,base_unit,pack_units,mrp_per_pcs,dealer_price_per_pcs,aliases\n";

describe("CSV reader", () => {
  it("handles quotes, commas and newlines inside quotes, CRLF and the Excel BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi""\nok"\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"\nok'],
    ]);
  });
});

describe("catalogue CSV", () => {
  it("reads a row into a validated product", () => {
    const { rows, errors } = parseCatalogueCsv(HEAD + "br-x,Good Day Rs10,Biscuits,PCS,CASE=144;BOX=12,10,8.6,good day;gudday;Good Day\n");
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({
      line: 2,
      product: {
        sku: "BR-X",
        name: "Good Day Rs10",
        category: "Biscuits",
        base_unit: "PCS",
        pack_units: { PCS: 1, BOX: 12, CASE: 144 },
        mrp: "10.00",
        purchase_rate: null,
        dealer_price: "8.60",
        aliases: ["good day", "gudday"],
        active: true,
      },
    });
  });

  it("reports every bad row with its line number", () => {
    const { rows, errors } = parseCatalogueCsv(
      HEAD + "A,One,,PCS,BOX=12,10,abc,\n" + "B,,,PCS,BOX=12,10,8,\n" + "C,Three,,PCS,BOX=0,10,8,\n" + "D,Four,,PCS,PCS=2,10,8,\n" + "E,Five,,PCS,BOX=6,10,8,\n" + "e,Dup,,PCS,BOX=6,10,8,\n",
    );
    expect(rows.map((r) => r.product.sku)).toEqual(["E"]);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 7]);
    expect(errors[0]!.message).toContain("Selling Rate");
    expect(errors[4]!.message).toContain("line 6");
  });

  it("refuses a file without the required columns", () => {
    expect(parseCatalogueCsv("name,price\nx,1\n").errors[0]!.message).toContain("Item Code");
  });

  it("round-trips through export, including Tamil names and commas", () => {
    const p = ProductInput.parse({ sku: "T1", name: 'Tiger, "big"', pack_units: { BOX: 24 }, mrp: 5, dealer_price: "4.3", aliases: ["டைகர்"], active: false });
    const back = parseCatalogueCsv(catalogueToCsv([p]));
    expect(back.errors).toEqual([]);
    expect(back.rows[0]!.product).toEqual(p);
  });

  it("the Britannia sample file imports cleanly", () => {
    const csv = readFileSync(path.resolve(__dirname, "../../../data/britannia/catalogue.csv"), "utf8");
    const { rows, errors } = parseCatalogueCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.length).toBe(24);
  });

  it("diff ignores pack order and spots price changes", () => {
    const a = ProductInput.parse({ sku: "X", name: "X", pack_units: { CASE: 144, BOX: 12 }, mrp: 10, dealer_price: 8.6 });
    const b = ProductInput.parse({ sku: "X", name: "X", pack_units: { BOX: 12, CASE: 144 }, mrp: "10.00", dealer_price: "8.75" });
    expect(diffProduct(a, b)).toEqual({ dealer_price: { from: "8.60", to: "8.75" } });
  });
});

describe("matcher (gate 5: ambiguity is never resolved silently)", () => {
  const products = parseCatalogueCsv(readFileSync(path.resolve(__dirname, "../../../data/britannia/catalogue.csv"), "utf8")).rows.map((r) => r.product);
  const m = (q: string) => matchProduct(q, products);

  it("resolves exact aliases, misspellings, Tamil script and price points", () => {
    expect(m("gudday cashew")).toMatchObject({ kind: "resolved", sku: "BR-GD-CASH-10" });
    expect(m("borbon")).toMatchObject({ kind: "resolved", sku: "BR-BOUR-10" });
    expect(m("bourbon 30")).toMatchObject({ kind: "resolved", sku: "BR-BOUR-30" });
    expect(m("டைகர்")).toMatchObject({ kind: "resolved", sku: "BR-TIG-5" });
    expect(m("Good-Day Butter!")).toMatchObject({ kind: "resolved", sku: "BR-GD-BUTR-10" });
  });

  it("offers up to three choices when several products fit", () => {
    const r = m("good day 10");
    expect(r.kind).toBe("ambiguous");
    expect(r.candidates.length).toBeGreaterThan(1);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
    expect(m("biscuits").kind).toBe("ambiguous");
  });

  it("finds nothing rather than guessing", () => {
    expect(m("kurkure").kind).toBe("none");
  });

  it("ignores hidden products", () => {
    const hidden = products.map((p) => (p.sku === "BR-BOUR-10" ? { ...p, active: false } : p));
    expect(matchProduct("borbon", hidden).kind === "resolved" && matchProduct("borbon", hidden)).not.toMatchObject({ sku: "BR-BOUR-10" });
  });
});

describe("normalisation", () => {
  it("reads quantities and units in English, Tanglish and Tamil", () => {
    expect([parseQuantity("2"), parseQuantity("௩"), parseQuantity("rendu"), parseQuantity("இரண்டு"), parseQuantity("two"), parseQuantity("1.5"), parseQuantity("0")]).toEqual([2, 3, 2, 2, 2, null, null]);
    expect([parseUnit("petti"), parseUnit("Cases"), parseUnit("pkt"), parseUnit(""), parseUnit("tray")]).toEqual(["BOX", "CASE", "PCS", null, "TRAY"]);
    expect(normaliseText("Good Day Rs10, 250g ₹30")).toBe("good day 10 250 g 30");
  });
});
