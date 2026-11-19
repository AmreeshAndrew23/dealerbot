import { describe, expect, it } from "vitest";
import { catalogueTemplateCsv, catalogueToCsv, parseCatalogueCsv, ProductInput } from "../src";

const HEAD = "Item Code,Item Name,Category,Base Unit,Pack Sizes,MRP,Purchase Rate,Selling Rate,Stock Qty,Stock Unit,Retailer Names,Active\n";

describe("bulk upload template", () => {
  it("reads the friendly headings, purchase rate and stock in any pack", () => {
    const { rows, errors } = parseCatalogueCsv(HEAD + "gd-10,Good Day,Biscuits,PCS,BOX=12;CASE=144,10,7.90,8.60,5,case,gudday,yes\nmg,Marie,,,BOX=12,40,,34.40,,,,\n");
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ stock: 720, product: { sku: "GD-10", purchase_rate: "7.90", dealer_price: "8.60" } });
    expect(rows[1]).toMatchObject({ product: { sku: "MG", purchase_rate: null } });
    expect(rows[1]!.stock).toBeUndefined(); // empty = leave stock as it is
  });

  it("matches headings loosely, so Excel edits and older files still work", () => {
    const loose = "item_code,ITEM NAME,pack sizes (pcs per pack),MRP (per pc),Retailer rate,stock_pcs\nA1,Thing,BOX=6,5,4.50,60\n";
    const { rows, errors } = parseCatalogueCsv(loose);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ stock: 60, product: { sku: "A1", dealer_price: "4.50" } });
  });

  it("rejects stock in a pack the item does not have, or not a whole number of pieces", () => {
    const { errors } = parseCatalogueCsv(HEAD + "A,One,,PCS,BOX=12,10,,9,2,TRAY,,\nB,Two,,PCS,BOX=12,10,,9,1.5,PCS,,\n");
    expect(errors.map((e) => e.line)).toEqual([2, 3]);
    expect(errors[0]!.message).toContain("TRAY");
  });

  it("skips the template EXAMPLE rows, and says so when only examples are left", () => {
    const t = catalogueTemplateCsv();
    const parsed = parseCatalogueCsv(t);
    expect(parsed.skipped).toBe(2);
    expect(parsed.errors[0]!.message).toContain("EXAMPLE rows");
    const filled = parseCatalogueCsv(t + "REAL-1,Real item,,PCS,BOX=12,10,8,9,3,BOX,,yes\n");
    expect(filled.errors).toEqual([]);
    expect(filled.rows).toHaveLength(1);
    expect(filled.rows[0]).toMatchObject({ stock: 36 });
  });

  it("the download uploads back unchanged, including purchase rate and stock", () => {
    const p = ProductInput.parse({ sku: "X1", name: "X", pack_units: { BOX: 12 }, mrp: 10, purchase_rate: "7.25", dealer_price: "8.60", aliases: ["x"] });
    const back = parseCatalogueCsv(catalogueToCsv([{ ...p, stock: "48.000" }]));
    expect(back.errors).toEqual([]);
    expect(back.rows[0]).toEqual({ line: 2, product: p, stock: 48 });
  });
});
