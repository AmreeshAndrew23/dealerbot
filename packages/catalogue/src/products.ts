// Product validation, CSV import/export and database access. Used by the staff API, the CLIs
// and the order assistant, so every path applies the same rules.
import { z } from "zod";
import type { Tx } from "@fmcg/db";
import { parseCsv, toCsv } from "./csv";
import { normaliseText } from "./normalise";
import { changeStock, type Actor } from "./stock";

const money = z.union([z.number(), z.string().trim()]).transform((v, ctx) => {
  const s = typeof v === "number" ? String(v) : v.replace(/^(rs\.?|₹)\s*/i, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    ctx.addIssue({ code: "custom", message: "must be an amount like 8.60 (up to 2 decimals)" });
    return z.NEVER;
  }
  if (Number(s) > 9_999_999) {
    ctx.addIssue({ code: "custom", message: "is too large" });
    return z.NEVER;
  }
  return Number(s).toFixed(2);
});

const unit = z.string().trim().min(1, "is required").max(12).regex(/^[A-Za-z][A-Za-z0-9]*$/, "must be letters/digits, e.g. BOX").transform((u) => u.toUpperCase());

export const ProductInput = z
  .object({
    sku: z.string().trim().min(1, "is required").max(40).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "may use letters, digits and - _ . /").transform((s) => s.toUpperCase()),
    name: z.string().trim().min(1, "is required").max(120),
    category: z.string().trim().max(60).default(""),
    base_unit: unit.default("PCS"),
    pack_units: z.record(z.string(), z.number().int("must be a whole number").positive("must be more than 0").max(100_000)),
    mrp: money,
    /** Our cost per base unit (what we pay the company). Staff only; null = not entered. */
    purchase_rate: z.union([money, z.null()]).optional(),
    dealer_price: money,
    aliases: z.array(z.string().trim().max(60)).max(40).default([]),
    active: z.boolean().default(true),
  })
  .transform((p, ctx) => {
    const packs: Record<string, number> = {};
    for (const [k, n] of Object.entries(p.pack_units)) {
      const u = unit.safeParse(k);
      if (!u.success) {
        ctx.addIssue({ code: "custom", path: ["pack_units"], message: `unit "${k}" ${u.error.issues[0]?.message}` });
        return z.NEVER;
      }
      if (packs[u.data] !== undefined) {
        ctx.addIssue({ code: "custom", path: ["pack_units"], message: `unit ${u.data} is listed twice` });
        return z.NEVER;
      }
      packs[u.data] = n;
    }
    if (packs[p.base_unit] === undefined) packs[p.base_unit] = 1;
    if (packs[p.base_unit] !== 1) {
      ctx.addIssue({ code: "custom", path: ["pack_units"], message: `${p.base_unit} is the base unit, so it must be 1` });
      return z.NEVER;
    }
    const seen = new Set<string>();
    const aliases = p.aliases.filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
    return { ...p, purchase_rate: p.purchase_rate ?? null, pack_units: orderPacks(packs), aliases };
  });

/** Smallest pack first (the base unit), so display and comparisons are stable (jsonb reorders keys). */
export function orderPacks(p: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(p).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])));
}
export type ProductInput = z.output<typeof ProductInput>;

export interface Product extends ProductInput {
  id: string;
  /** "manual" = maintained in the dashboard; "tally" = synced by the connector (E07). */
  source: "manual" | "tally";
  /** Available to sell, in base units; null = stock not tracked (unlimited). */
  stock: string | null;
  created_at: Date;
  updated_at: Date;
}

/** "PCS=1;BOX=12;CASE=144" <-> { PCS: 1, BOX: 12, CASE: 144 } (numbers left unvalidated here). */
export function parsePackUnits(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of s.split(/[;|]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^([^=:\s]+)\s*[=:]\s*(.+)$/.exec(part);
    out[m ? m[1]! : part] = m ? Number(m[2]!.trim()) : NaN;
  }
  return out;
}
export const formatPackUnits = (p: Record<string, number>) => Object.entries(p).map(([u, n]) => `${u}=${n}`).join(";");

// ---- CSV (bulk upload / download / template) ---------------------------------------------------
//
// One row per product. Headings are matched loosely (case, spaces, underscores and anything in
// brackets are ignored), so "Selling Rate (per pc)" and the older "dealer_price_per_pcs" both work.

interface ColumnSpec {
  key: "sku" | "name" | "category" | "base_unit" | "pack_units" | "mrp" | "purchase_rate" | "dealer_price" | "stock_qty" | "stock_unit" | "aliases" | "active";
  head: string;
  also: string[];
  required?: boolean;
  help: string;
  example: [string, string];
}

export const CSV_SPEC: ColumnSpec[] = [
  { key: "sku", head: "Item Code", also: ["sku_code", "sku", "code", "item code", "product code"], required: true, help: "Your code for the item (as in Tally). Letters, digits, - _ . /", example: ["EXAMPLE-1", "EXAMPLE-2"] },
  { key: "name", head: "Item Name", also: ["name", "product", "product name", "item"], required: true, help: "Name as printed on the pack", example: ["Good Day Cashew Rs10", "Marie Gold 250g"] },
  { key: "category", head: "Category", also: [], help: "Optional, e.g. Biscuits", example: ["Biscuits", "Biscuits"] },
  { key: "base_unit", head: "Base Unit", also: ["base_unit", "unit"], help: "Smallest unit you sell; rates are per this unit. Usually PCS", example: ["PCS", "PCS"] },
  { key: "pack_units", head: "Pack Sizes", also: ["pack_units", "packs", "pack"], required: true, help: "Pieces in each pack, e.g. BOX=12;CASE=144", example: ["BOX=12;CASE=144", "BOX=12;CASE=48"] },
  { key: "mrp", head: "MRP", also: ["mrp_per_pcs", "mrp per pcs"], required: true, help: "Printed MRP per base unit", example: ["10.00", "40.00"] },
  { key: "purchase_rate", head: "Purchase Rate", also: ["purchase_rate_per_pcs", "purchase price", "cost", "cost price", "buying rate", "our rate"], help: "What you pay the company per base unit. Never shown to retailers. Optional", example: ["7.90", "31.50"] },
  { key: "dealer_price", head: "Selling Rate", also: ["dealer_price_per_pcs", "dealer price", "retailer rate", "selling price", "rate", "price"], required: true, help: "What you charge the retailer per base unit. The assistant quotes this", example: ["8.60", "34.40"] },
  { key: "stock_qty", head: "Stock Qty", also: ["stock_pcs", "stock", "stock pcs", "quantity", "qty"], help: "How much you have now. Empty = leave stock as it is", example: ["5", "120"] },
  { key: "stock_unit", head: "Stock Unit", also: ["stock_unit"], help: "Unit of Stock Qty: PCS, BOX or CASE (default: base unit)", example: ["CASE", "PCS"] },
  { key: "aliases", head: "Retailer Names", also: ["aliases", "other names", "also called"], help: "Names retailers type, separated by ; (English, Tanglish, Tamil)", example: ["good day cashew;gudday;குட் டே முந்திரி", "marie;மேரி கோல்டு"] },
  { key: "active", head: "Active", also: [], help: "yes or no (no = hidden from retailers). Default yes", example: ["yes", "yes"] },
];
/** Kept for callers that list the headings. */
export const CSV_COLUMNS = CSV_SPEC.map((c) => c.head);

/** Rows whose Item Code starts with this are the template's examples and are skipped. */
export const EXAMPLE_PREFIX = "EXAMPLE-";

const headKey = (h: string) =>
  h
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[_\-./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export interface CsvRowError {
  line: number;
  message: string;
}

export interface ParsedCsv {
  /** stock: available base units to set; undefined = cell empty (leave stock as it is). */
  rows: Array<{ line: number; product: ProductInput; stock?: number }>;
  errors: CsvRowError[];
  /** Template example rows that were ignored. */
  skipped: number;
}

const FIELD_HEAD: Record<string, string> = Object.fromEntries(CSV_SPEC.map((c) => [c.key, c.head]));

function issueText(e: z.ZodError): string {
  return e.issues.map((i) => `${FIELD_HEAD[String(i.path[0])] ?? i.path.join(".") ?? "row"} ${i.message}`).join("; ");
}

export function parseCatalogueCsv(text: string): ParsedCsv {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map(headKey);
  const index: Partial<Record<ColumnSpec["key"], number>> = {};
  for (const c of CSV_SPEC) {
    const names = [c.head, ...c.also].map(headKey);
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) index[c.key] = i;
  }
  const missing = CSV_SPEC.filter((c) => c.required && index[c.key] === undefined).map((c) => c.head);
  if (missing.length) {
    return { rows: [], skipped: 0, errors: [{ line: 1, message: `Missing column(s): ${missing.join(", ")}. Download the template to get the right headings.` }] };
  }
  const col = (r: string[], key: ColumnSpec["key"]) => {
    const i = index[key];
    return i === undefined ? undefined : (r[i] ?? "").trim();
  };

  const rows: ParsedCsv["rows"] = [];
  const errors: CsvRowError[] = [];
  const skuLine = new Map<string, number>();
  let skipped = 0;
  table.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    if (r.every((c) => !c.trim())) return; // blank line
    if ((col(r, "sku") ?? "").toUpperCase().startsWith(EXAMPLE_PREFIX)) {
      skipped++;
      return;
    }
    const activeRaw = (col(r, "active") ?? "").toLowerCase();
    if (activeRaw && !["yes", "no", "true", "false", "1", "0", "y", "n"].includes(activeRaw)) {
      errors.push({ line, message: "Active must be yes or no" });
      return;
    }
    const res = ProductInput.safeParse({
      sku: col(r, "sku"),
      name: col(r, "name"),
      category: col(r, "category") || undefined,
      base_unit: col(r, "base_unit") || undefined,
      pack_units: parsePackUnits(col(r, "pack_units") ?? ""),
      mrp: col(r, "mrp"),
      purchase_rate: col(r, "purchase_rate") || null,
      dealer_price: col(r, "dealer_price"),
      aliases: (col(r, "aliases") ?? "").split(";").map((a) => a.trim()).filter(Boolean),
      active: activeRaw ? ["yes", "true", "1", "y"].includes(activeRaw) : true,
    });
    if (!res.success) {
      errors.push({ line, message: issueText(res.error) });
      return;
    }
    const p = res.data;

    // Stock: a quantity in any of the product's packs, stored in base units.
    let stock: number | undefined;
    const qtyRaw = (col(r, "stock_qty") ?? "").replace(/,/g, "");
    if (qtyRaw) {
      const unitRaw = (col(r, "stock_unit") ?? "").trim().toUpperCase() || p.base_unit;
      const per = p.pack_units[unitRaw];
      if (!/^\d+(\.\d+)?$/.test(qtyRaw)) {
        errors.push({ line, message: "Stock Qty must be a number (or empty to leave stock as it is)" });
        return;
      }
      if (!per) {
        errors.push({ line, message: `Stock Unit ${unitRaw} is not one of this item's packs (${Object.keys(p.pack_units).join(", ")})` });
        return;
      }
      stock = Number(qtyRaw) * per;
      if (!Number.isInteger(stock)) {
        errors.push({ line, message: `Stock Qty ${qtyRaw} ${unitRaw} is not a whole number of ${p.base_unit}` });
        return;
      }
    }

    const prev = skuLine.get(p.sku);
    if (prev) {
      errors.push({ line, message: `Item Code ${p.sku} is already on line ${prev}` });
      return;
    }
    skuLine.set(p.sku, line);
    rows.push({ line, product: p, ...(stock !== undefined ? { stock } : {}) });
  });
  if (!rows.length && !errors.length) {
    errors.push({ line: 2, message: skipped ? "The file only has the template's EXAMPLE rows. Add your own items below them." : "The file has no product rows." });
  }
  return { rows, errors, skipped };
}

/** Download of the current catalogue, in the same layout the upload accepts. */
export function catalogueToCsv(products: Array<ProductInput & { stock?: string | null }>): string {
  return toCsv([
    CSV_SPEC.map((c) => c.head),
    ...products.map((p) => [
      p.sku,
      p.name,
      p.category,
      p.base_unit,
      formatPackUnits(Object.fromEntries(Object.entries(p.pack_units).filter(([u]) => u !== p.base_unit))),
      p.mrp,
      p.purchase_rate ?? "",
      p.dealer_price,
      p.stock == null ? "" : String(Number(p.stock)),
      p.stock == null ? "" : p.base_unit,
      p.aliases.join(";"),
      p.active ? "yes" : "no",
    ]),
  ]);
}

/** Empty template with two EXAMPLE rows (skipped on upload) showing how to fill each column. */
export function catalogueTemplateCsv(): string {
  return toCsv([CSV_SPEC.map((c) => c.head), CSV_SPEC.map((c) => c.example[0]), CSV_SPEC.map((c) => c.example[1])]);
}

// ---- Database ----------------------------------------------------------------------------------

// A "product" is the dashboard's view of one SKU: skus + sku_units + sku_aliases + its STANDARD price.

const PRICE_LIST = "STANDARD"; // selling rate to retailers
const PURCHASE_LIST = "PURCHASE"; // our cost; staff only, never quoted

const SELECT_PRODUCT = `
  SELECT s.id, s.sku_code AS sku, s.name, s.category, s.base_unit, s.mrp, s.active, s.source, s.created_at, s.updated_at,
         COALESCE((SELECT jsonb_object_agg(u.unit, u.base_multiplier) FROM sku_units u
                    WHERE u.tenant_id = s.tenant_id AND u.sku_id = s.id), '{}'::jsonb) AS pack_units,
         (SELECT p.rate FROM prices p WHERE p.tenant_id = s.tenant_id AND p.sku_id = s.id AND p.price_list = '${PRICE_LIST}') AS dealer_price,
         (SELECT p.rate FROM prices p WHERE p.tenant_id = s.tenant_id AND p.sku_id = s.id AND p.price_list = '${PURCHASE_LIST}') AS purchase_rate,
         COALESCE((SELECT array_agg(a.alias ORDER BY a.position, a.alias) FROM sku_aliases a
                    WHERE a.tenant_id = s.tenant_id AND a.sku_id = s.id AND a.status = 'approved'), '{}') AS aliases,
         (SELECT sl.available FROM stock_levels sl WHERE sl.tenant_id = s.tenant_id AND sl.sku_id = s.id) AS stock
    FROM skus s`;

const fromRow = (p: Product): Product => ({
  ...p,
  pack_units: orderPacks(Object.fromEntries(Object.entries(p.pack_units).map(([u, n]) => [u, Number(n)]))),
});

export async function listProducts(tx: Tx, opts: { activeOnly?: boolean } = {}): Promise<Product[]> {
  const r = await tx.query<Product>(`${SELECT_PRODUCT} ${opts.activeOnly ? "WHERE s.active" : ""} ORDER BY s.category, s.name, s.sku_code`);
  return r.rows.map(fromRow);
}

export async function getProduct(tx: Tx, id: string, forUpdate = false): Promise<Product | undefined> {
  if (forUpdate) await tx.query(`SELECT 1 FROM skus WHERE id = $1 FOR UPDATE`, [id]);
  const p = (await tx.query<Product>(`${SELECT_PRODUCT} WHERE s.id = $1`, [id])).rows[0];
  return p && fromRow(p);
}

/** Replaces the SKU's units, aliases and price with the input (inside the caller's transaction). */
async function writeChildren(tx: Tx, tenantId: string, skuId: string, p: ProductInput): Promise<void> {
  await tx.query(`DELETE FROM sku_units WHERE tenant_id = $1 AND sku_id = $2`, [tenantId, skuId]);
  const units = Object.entries(p.pack_units);
  await tx.query(
    `INSERT INTO sku_units (tenant_id, sku_id, unit, base_multiplier) SELECT $1, $2, u, m FROM unnest($3::text[], $4::numeric[]) AS t(u, m)`,
    [tenantId, skuId, units.map(([u]) => u), units.map(([, n]) => n)],
  );
  // The product's alias list replaces its approved aliases. Suggestions learned from chats (and
  // rejected ones) are kept; listing a suggested alias here approves it.
  const seen = new Set<string>();
  const aliases = p.aliases.map((a) => ({ a, n: normaliseText(a) })).filter(({ n }) => n && !seen.has(n) && seen.add(n));
  await tx.query(`DELETE FROM sku_aliases WHERE tenant_id = $1 AND sku_id = $2 AND status = 'approved' AND NOT (alias_norm = ANY($3))`, [
    tenantId,
    skuId,
    aliases.map((x) => x.n),
  ]);
  await tx.query(
    `INSERT INTO sku_aliases (tenant_id, sku_id, alias, alias_norm, position, status)
     SELECT $1, $2, a, n, i, 'approved' FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS t(a, n, i)
     ON CONFLICT (tenant_id, sku_id, alias_norm)
       DO UPDATE SET alias = EXCLUDED.alias, position = EXCLUDED.position, status = 'approved'`,
    [tenantId, skuId, aliases.map((x) => x.a), aliases.map((x) => x.n)],
  );
  await tx.query(
    `INSERT INTO prices (tenant_id, sku_id, price_list, rate) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, sku_id, price_list) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now() WHERE prices.rate <> EXCLUDED.rate`,
    [tenantId, skuId, PRICE_LIST, p.dealer_price],
  );
  if (p.purchase_rate === null) {
    await tx.query(`DELETE FROM prices WHERE tenant_id = $1 AND sku_id = $2 AND price_list = $3`, [tenantId, skuId, PURCHASE_LIST]);
  } else {
    await tx.query(
      `INSERT INTO prices (tenant_id, sku_id, price_list, rate) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, sku_id, price_list) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now() WHERE prices.rate <> EXCLUDED.rate`,
      [tenantId, skuId, PURCHASE_LIST, p.purchase_rate],
    );
  }
}

export async function insertProduct(tx: Tx, tenantId: string, p: ProductInput): Promise<Product> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO skus (tenant_id, sku_code, name, category, base_unit, mrp, active, source) VALUES ($1,$2,$3,$4,$5,$6,$7,'manual') RETURNING id`,
    [tenantId, p.sku, p.name, p.category, p.base_unit, p.mrp, p.active],
  );
  const id = r.rows[0]!.id;
  await writeChildren(tx, tenantId, id, p);
  return (await getProduct(tx, id))!;
}

export async function updateProduct(tx: Tx, id: string, p: ProductInput): Promise<Product> {
  const r = await tx.query<{ tenant_id: string }>(
    `UPDATE skus SET sku_code=$2, name=$3, category=$4, base_unit=$5, mrp=$6, active=$7, updated_at=now() WHERE id = $1 RETURNING tenant_id`,
    [id, p.sku, p.name, p.category, p.base_unit, p.mrp, p.active],
  );
  await writeChildren(tx, r.rows[0]!.tenant_id, id, p);
  return (await getProduct(tx, id))!;
}

const FIELDS = ["name", "category", "base_unit", "pack_units", "mrp", "purchase_rate", "dealer_price", "aliases", "active"] as const;
type Field = (typeof FIELDS)[number];

/** Fields that differ between the stored product and the new input (sku is the match key). */
export function diffProduct(cur: ProductInput, next: ProductInput): Partial<Record<Field, { from: unknown; to: unknown }>> {
  const out: Partial<Record<Field, { from: unknown; to: unknown }>> = {};
  for (const f of FIELDS) {
    if (JSON.stringify(cur[f]) !== JSON.stringify(next[f])) out[f] = { from: cur[f], to: next[f] };
  }
  return out;
}

export interface ImportPlanItem {
  line: number;
  sku: string;
  name: string;
  action: "create" | "update" | "unchanged";
  changes: ReturnType<typeof diffProduct> & { stock?: { from: number | null; to: number } };
}

export interface ImportResult {
  dry_run: boolean;
  applied: boolean;
  errors: CsvRowError[];
  counts: { rows: number; create: number; update: number; unchanged: number; hide: number; skipped: number };
  items: ImportPlanItem[];
  hide: Array<{ sku: string; name: string }>;
}

/**
 * Upserts CSV rows by SKU. All or nothing: if any row has an error, nothing is saved.
 * hideMissing hides active products whose SKU is not in the file (a full price-list replacement).
 */
export async function importCatalogue(
  tx: Tx,
  tenantId: string,
  csv: string,
  opts: { dryRun: boolean; hideMissing: boolean; actor?: Actor },
): Promise<ImportResult> {
  const parsed = parseCatalogueCsv(csv);
  const existing = new Map((await listProducts(tx)).map((p) => [p.sku, p]));
  const items: ImportPlanItem[] = parsed.rows.map(({ line, product, stock }) => {
    const cur = existing.get(product.sku);
    const changes: ImportPlanItem["changes"] = cur ? diffProduct(cur, product) : {};
    const curStock = cur?.stock == null ? null : Number(cur.stock);
    if (cur && stock !== undefined && stock !== curStock) changes.stock = { from: curStock, to: stock };
    return { line, sku: product.sku, name: product.name, action: !cur ? "create" : Object.keys(changes).length ? "update" : "unchanged", changes };
  });
  const inFile = new Set(parsed.rows.map((r) => r.product.sku));
  const hide = opts.hideMissing ? [...existing.values()].filter((p) => p.active && !inFile.has(p.sku)).map((p) => ({ sku: p.sku, name: p.name })) : [];
  const count = (a: ImportPlanItem["action"]) => items.filter((i) => i.action === a).length;
  const result: ImportResult = {
    dry_run: opts.dryRun,
    applied: false,
    errors: parsed.errors,
    counts: { rows: items.length, create: count("create"), update: count("update"), unchanged: count("unchanged"), hide: hide.length, skipped: parsed.skipped },
    items,
    hide,
  };
  if (opts.dryRun || parsed.errors.length) return result;

  const actor = opts.actor ?? { type: "system" as const, id: null };
  for (const { product, stock } of parsed.rows) {
    const cur = existing.get(product.sku);
    const id = !cur ? (await insertProduct(tx, tenantId, product)).id : cur.id;
    if (cur && Object.keys(diffProduct(cur, product)).length) await updateProduct(tx, cur.id, product);
    const curStock = cur?.stock == null ? null : Number(cur.stock);
    if (stock !== undefined && stock !== curStock) await changeStock(tx, tenantId, id, { mode: "set", quantity: stock, note: "CSV upload" }, actor);
  }
  if (hide.length) {
    await tx.query(`UPDATE skus SET active = false, updated_at = now() WHERE sku_code = ANY($1) AND active`, [hide.map((h) => h.sku)]);
  }
  result.applied = true;
  return result;
}
