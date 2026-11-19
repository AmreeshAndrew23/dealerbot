import { useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type ImportResult, type Learning, type Product, type ProductDraft, type StockMovement } from "../api";
import { fmtFull } from "../format";
import { useMe } from "../auth";
import { Icon } from "../icons";

const rupees = (v: string) => `₹${v}`;
const packText = (p: Record<string, number>, base: string) =>
  Object.entries(p)
    .filter(([u]) => u !== base)
    .map(([u, n]) => `${u.toLowerCase()} = ${n} ${base.toLowerCase()}`)
    .join(" · ") || `sold per ${base.toLowerCase()}`;

type Filter = "active" | "hidden" | "all";
type Panel = { kind: "add" } | { kind: "edit"; product: Product } | { kind: "stock"; product: Product } | { kind: "import" } | null;

const unitName = (u: string) => u.toLowerCase();
/** Packs largest first, e.g. [["CASE",144],["BOX",12],["PCS",1]]. */
const packsDesc = (p: Product) => Object.entries(p.pack_units).sort((a, b) => b[1] - a[1]);
/** 308 pcs -> "2 case · 1 box · 8 pcs" (what a person counts on the shelf). */
function stockBreakdown(p: Product, qty: number): string {
  if (qty <= 0) return "0";
  let left = qty;
  const parts: string[] = [];
  for (const [u, n] of packsDesc(p)) {
    const k = Math.floor(left / n);
    if (k > 0) {
      parts.push(`${k} ${unitName(u)}`);
      left -= k * n;
    }
  }
  return parts.join(" · ");
}

export function CataloguePage() {
  const me = useMe();
  const canEdit = me.permissions.includes("catalogue.edit");
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["catalogue"], queryFn: () => api<{ products: Product[] }>("/v1/catalogue/products") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["catalogue"] });

  const [panel, setPanel] = useState<Panel>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("active");
  const [notice, setNotice] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const open = (p: Panel) => {
    setPanel(p);
    setNotice(null);
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const toggle = useMutation({
    mutationFn: (p: Product) => api<Product>(`/v1/catalogue/products/${p.id}`, { method: "PATCH", body: { active: !p.active } }),
    onSuccess: (p) => setNotice(`${p.name} is ${p.active ? "back in the catalogue" : "hidden. Retailers will not be offered it"}.`),
    onSettled: refresh,
  });

  const products = list.data?.products ?? [];
  const counts = { active: products.filter((p) => p.active).length, hidden: products.filter((p) => !p.active).length, all: products.length };
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return products.filter((p) => {
      if (filter === "active" && !p.active) return false;
      if (filter === "hidden" && p.active) return false;
      const hay = [p.sku, p.name, p.category, ...p.aliases].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [products, q, filter]);

  return (
    <div className="page" ref={top}>
      <div className="page-head">
        <div>
          <h1>Catalogue</h1>
          <p className="sub">The WhatsApp assistant uses these product names, pack sizes and prices. Changes apply to the next message.</p>
        </div>
        <div className="head-actions">
          {canEdit && (
            <>
              <button className="btn primary" onClick={() => open({ kind: "add" })}>
                <Icon name="plus" size={16} /> Add product
              </button>
              <button className="btn" onClick={() => open({ kind: "import" })}>
                <Icon name="upload" size={16} /> Bulk upload
              </button>
              <a className="btn" href="/v1/catalogue/template.csv" download>
                <Icon name="download" size={16} /> Template
              </a>
            </>
          )}
          <a className="btn" href="/v1/catalogue/export.csv" download title="Your current items, prices and stock, ready to edit and upload back">
            <Icon name="download" size={16} /> Download list
          </a>
        </div>
      </div>

      {notice && (
        <div className="banner info" role="status" style={{ marginBottom: 12 }}>
          {notice}
        </div>
      )}
      {toggle.error && <p className="error-text">{toggle.error instanceof ApiError ? toggle.error.message : "Could not save the change."}</p>}

      {panel?.kind === "add" && (
        <ProductForm
          onClose={() => setPanel(null)}
          onSaved={(p) => {
            setPanel(null);
            setNotice(`${p.name} added.`);
            refresh();
          }}
        />
      )}
      {panel?.kind === "edit" && (
        <ProductForm
          key={panel.product.id}
          product={panel.product}
          onClose={() => setPanel(null)}
          onSaved={(p) => {
            setPanel(null);
            setNotice(`${p.name} saved.`);
            refresh();
          }}
        />
      )}
      {panel?.kind === "stock" && (
        <StockPanel
          key={panel.product.id}
          product={panel.product}
          onClose={() => setPanel(null)}
          onSaved={(p) => {
            setNotice(`Stock of ${p.name} saved: ${p.stock === null ? "not tracked" : `${Number(p.stock)} ${unitName(p.base_unit)}`}.`);
            refresh();
          }}
        />
      )}
      {panel?.kind === "import" && (
        <ImportPanel
          onClose={() => setPanel(null)}
          onDone={(msg) => {
            setPanel(null);
            setNotice(msg);
            refresh();
          }}
        />
      )}

      {canEdit && <ReviewPanel products={products} onChanged={refresh} onNotice={setNotice} />}

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input className="input" type="search" placeholder="Search name, SKU or retailer name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
        </div>
        <div className="seg" role="group" aria-label="Show">
          {(["active", "hidden", "all"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "active" ? "Active" : f === "hidden" ? "Hidden" : "All"} {counts[f]}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <table className="table stack">
          <colgroup>
            <col />
            <col style={{ width: "15%" }} />
            <col style={{ width: "17%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: canEdit ? "21%" : "0" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Product</th>
              <th>Pack sizes</th>
              <th>In stock</th>
              <th className="num">MRP</th>
              <th className="num" title="What retailers pay. Below it: your purchase rate and margin">
                Selling rate
              </th>
              <th>{canEdit ? <span className="sr-only">Actions</span> : null}</th>
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr>
                <td colSpan={6}>Loading…</td>
              </tr>
            )}
            {list.error && (
              <tr>
                <td colSpan={6} className="error-text">
                  Could not load the catalogue.
                </td>
              </tr>
            )}
            {list.data && shown.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="empty">
                    {products.length === 0
                      ? canEdit
                        ? "No products yet. Add one, or upload your price list as a CSV."
                        : "No products yet."
                      : "No products match."}
                  </div>
                </td>
              </tr>
            )}
            {shown.map((p) => (
              <tr
                key={p.id}
                className={`${p.active ? "" : "row-hidden"}${canEdit ? " clickable" : ""}`}
                onClick={canEdit ? () => open({ kind: "edit", product: p }) : undefined}
                title={canEdit ? "Click to edit" : undefined}
              >
                <td>
                  <div style={{ fontWeight: 600 }}>
                    {p.name} {!p.active && <span className="badge neutral">Hidden</span>}
                  </div>
                  <div className="cell-sub">
                    {p.sku}
                    {p.category ? ` · ${p.category}` : ""}
                  </div>
                  {p.aliases.length > 0 && (
                    <div className="cell-sub aliases" title={p.aliases.join(", ")}>
                      Also: {p.aliases.join(", ")}
                    </div>
                  )}
                </td>
                <td>
                  <span className="stack-label">Packs </span>
                  {packText(p.pack_units, p.base_unit)}
                </td>
                <td>
                  <span className="stack-label">In stock </span>
                  {p.stock === null ? (
                    <span className="cell-sub">Not tracked</span>
                  ) : Number(p.stock) <= 0 ? (
                    <span className="badge bad">Out of stock</span>
                  ) : (
                    <>
                      <strong>{stockBreakdown(p, Number(p.stock))}</strong>
                      <div className="cell-sub">
                        {Number(p.stock)} {unitName(p.base_unit)}
                      </div>
                    </>
                  )}
                </td>
                <td className="num">
                  <span className="stack-label">MRP </span>
                  {rupees(p.mrp)}
                </td>
                <td className="num">
                  <span className="stack-label">Selling rate </span>
                  <strong>{rupees(p.dealer_price)}</strong>
                  {p.purchase_rate !== null && <Margin cost={p.purchase_rate} sell={p.dealer_price} />}
                </td>
                <td>
                  {canEdit && (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn small primary" onClick={() => open({ kind: "stock", product: p })}>
                        Stock
                      </button>
                      <button className="btn small" onClick={() => open({ kind: "edit", product: p })}>
                        Edit
                      </button>
                      <button className={`btn small${p.active ? " danger" : ""}`} disabled={toggle.isPending} onClick={() => toggle.mutate(p)}>
                        {p.active ? "Hide" : "Restore"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Add / edit -------------------------------------------------------------------------------

/** "Cost ₹7.90 · margin ₹0.70 (8.1%)"; red when selling below cost. */
function Margin({ cost, sell }: { cost: string; sell: string }) {
  const c = Number(cost);
  const s = Number(sell);
  if (!Number.isFinite(c) || !Number.isFinite(s) || c <= 0) return null;
  const m = s - c;
  return (
    <div className={`cell-sub margin${m < 0 ? " loss" : ""}`}>
      cost {rupees(c.toFixed(2))} · margin {rupees(m.toFixed(2))} ({((m / c) * 100).toFixed(1)}%)
    </div>
  );
}

interface PackRow {
  unit: string;
  n: string;
}

function ProductForm({ product, onClose, onSaved }: { product?: Product; onClose: () => void; onSaved: (p: Product) => void }) {
  const [sku, setSku] = useState(product?.sku ?? "");
  const [name, setName] = useState(product?.name ?? "");
  const [category, setCategory] = useState(product?.category ?? "");
  const [baseUnit, setBaseUnit] = useState(product?.base_unit ?? "PCS");
  const [packs, setPacks] = useState<PackRow[]>(() => {
    const rows = Object.entries(product?.pack_units ?? { BOX: 12, CASE: 144 })
      .filter(([u]) => u !== (product?.base_unit ?? "PCS"))
      .map(([unit, n]) => ({ unit, n: String(n) }));
    return rows.length ? rows : [{ unit: "", n: "" }];
  });
  const [mrp, setMrp] = useState(product?.mrp ?? "");
  const [price, setPrice] = useState(product?.dealer_price ?? "");
  const [cost, setCost] = useState(product?.purchase_rate ?? "");
  const [aliases, setAliases] = useState((product?.aliases ?? []).join("\n"));
  // Stock, in pieces (base unit) when editing; any pack when adding.
  const startStock = product?.stock == null ? "" : String(Number(product.stock));
  const [stockQty, setStockQty] = useState(startStock);
  const [stockUnit, setStockUnit] = useState(product ? product.base_unit : "CASE");
  const base = baseUnit.trim().toUpperCase() || "PCS";
  const packChoices = [base, ...packs.map((r) => r.unit.trim().toUpperCase()).filter((u) => u && u !== base)];

  const save = useMutation({
    mutationFn: async () => {
      const pack_units: Record<string, number> = { [base]: 1 };
      for (const r of packs) if (r.unit.trim() || r.n.trim()) pack_units[r.unit.trim().toUpperCase() || "?"] = Number(r.n);
      const body: Partial<ProductDraft> = {
        sku,
        name,
        category,
        base_unit: base,
        pack_units,
        mrp,
        purchase_rate: cost.trim() ? cost.trim() : null,
        dealer_price: price,
        aliases: aliases.split(/[\n;]/).map((a) => a.trim()).filter(Boolean),
      };
      if (!product) {
        const unit = packChoices.includes(stockUnit) ? stockUnit : base;
        const stock = stockQty.trim() ? { stock_qty: Number(stockQty), stock_unit: unit } : {};
        return api<Product>("/v1/catalogue/products", { method: "POST", body: { ...body, ...stock, active: true } });
      }
      let saved = await api<Product>(`/v1/catalogue/products/${product.id}`, { method: "PATCH", body });
      // Stock is a ledger: a changed count is recorded as a correction (or tracking stops if cleared).
      if (stockQty.trim() !== startStock || stockUnit !== product.base_unit) {
        const stockBody = stockQty.trim() ? { mode: "set", quantity: Number(stockQty), unit: stockUnit, note: "Edited in product form" } : { mode: "untrack" };
        if (stockQty.trim() || product.stock !== null) {
          const { history: _h, ...p } = await api<Product & { history: unknown }>(`/v1/catalogue/products/${product.id}/stock`, { method: "POST", body: stockBody });
          saved = p;
        }
      }
      return saved;
    },
    onSuccess: onSaved,
  });

  const fieldErr = (f: string) => {
    const e = save.error;
    if (!(e instanceof ApiError)) return null;
    if (e.code === "SKU_EXISTS" && f === "sku") return e.message;
    const hit = (e.details.fields as Array<{ path: string; message: string }> | undefined)?.find((x) => x.path.split(".")[0] === f);
    return hit ? hit.message : null;
  };
  const anyFieldErr = ["sku", "name", "category", "base_unit", "pack_units", "mrp", "purchase_rate", "dealer_price", "aliases", "stock_qty", "stock_unit", "quantity", "unit"].some((f) => fieldErr(f));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const Err = ({ f }: { f: string }) => {
    const m = fieldErr(f);
    return m ? <span className="error-text">{m}</span> : null;
  };

  return (
    <form className="card card-pad panel" onSubmit={submit} aria-label={product ? `Edit ${product.name}` : "Add product"}>
      <div className="panel-head">
        <h2>{product ? `Edit ${product.name}` : "Add product"}</h2>
        <button type="button" className="btn small" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="form-grid">
        <div className="field span-2">
          <label htmlFor="p-name">Product name</label>
          <input id="p-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Good Day Cashew Cookies Rs10" />
          <Err f="name" />
        </div>
        <div className="field">
          <label htmlFor="p-sku">SKU / item code</label>
          <input id="p-sku" className="input" required value={sku} onChange={(e) => setSku(e.target.value)} placeholder="BR-GD-CASH-10" autoCapitalize="characters" />
          <Err f="sku" />
        </div>
        <div className="field">
          <label htmlFor="p-cat">Category</label>
          <input id="p-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Biscuits" />
        </div>

        <div className="field">
          <label htmlFor="p-base">Sold per (base unit)</label>
          <input id="p-base" className="input" value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} placeholder="PCS" autoCapitalize="characters" />
          <Err f="base_unit" />
        </div>
        <div className="field">
          <label htmlFor="p-mrp">MRP per {baseUnit.toUpperCase() || "PCS"} (₹)</label>
          <input id="p-mrp" className="input" required inputMode="decimal" value={mrp} onChange={(e) => setMrp(e.target.value)} placeholder="10.00" />
          <Err f="mrp" />
        </div>
        <div className="field">
          <label htmlFor="p-cost">Purchase rate per {base} (₹)</label>
          <input id="p-cost" className="input" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="7.90 (our cost)" />
          <Err f="purchase_rate" />
        </div>
        <div className="field">
          <label htmlFor="p-price">Selling rate to retailers per {base} (₹)</label>
          <input id="p-price" className="input" required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="8.60" />
          <Err f="dealer_price" />
          {cost.trim() && price.trim() && <Margin cost={cost} sell={price} />}
        </div>
        <div className="field span-2">
          <label htmlFor="p-stock">{product ? "Stock available now" : "Opening stock"}</label>
          <div className="stock-inline">
            <input
              id="p-stock"
              className="input"
              inputMode="numeric"
              value={stockQty}
              onChange={(e) => setStockQty(e.target.value)}
              placeholder={product ? "empty = not tracked" : "e.g. 5"}
            />
            <select className="select" value={packChoices.includes(stockUnit) ? stockUnit : base} onChange={(e) => setStockUnit(e.target.value)} aria-label="Stock unit">
              {packChoices.map((u) => (
                <option key={u} value={u}>
                  {u.toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <span className="hint">
            {product
              ? "Changing it records a stock correction. For goods received, use the Stock button (adds to the count)."
              : "Leave empty to not track stock. Retailers can't order more than the stock."}
          </span>
          <Err f="stock_qty" />
          <Err f="quantity" />
        </div>

        <fieldset className="field span-2 packs">
          <legend>Pack sizes</legend>
          {packs.map((r, i) => (
            <div className="pack-row" key={i}>
              <input
                className="input"
                aria-label={`Pack ${i + 1} unit`}
                placeholder="BOX"
                value={r.unit}
                onChange={(e) => setPacks(packs.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}
              />
              <span className="cell-sub">=</span>
              <input
                className="input"
                aria-label={`Pack ${i + 1} quantity`}
                inputMode="numeric"
                placeholder="12"
                value={r.n}
                onChange={(e) => setPacks(packs.map((x, j) => (j === i ? { ...x, n: e.target.value } : x)))}
              />
              <span className="cell-sub">{baseUnit.toUpperCase() || "PCS"}</span>
              <button type="button" className="btn small" aria-label={`Remove pack ${i + 1}`} onClick={() => setPacks(packs.filter((_, j) => j !== i))}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => setPacks([...packs, { unit: "", n: "" }])}>
            <Icon name="plus" size={14} /> Add pack size
          </button>
          <Err f="pack_units" />
        </fieldset>

        <div className="field span-2">
          <label htmlFor="p-alias">Names retailers use</label>
          <textarea
            id="p-alias"
            className="textarea"
            rows={4}
            style={{ maxHeight: "none", resize: "vertical" }}
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder={"good day cashew\ngudday cashew\nகுட் டே முந்திரி"}
          />
          <span className="hint">One per line. English, Tanglish or Tamil spellings help the assistant understand orders.</span>
          <Err f="aliases" />
        </div>
      </div>

      {save.error && !anyFieldErr && <p className="error-text">{save.error instanceof ApiError ? save.error.message : "Could not save the product."}</p>}
      <div className="panel-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={save.isPending}>
          {save.isPending ? "Saving…" : product ? "Save changes" : "Add product"}
        </button>
      </div>
    </form>
  );
}

// ---- CSV upload -------------------------------------------------------------------------------

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  category: "Category",
  base_unit: "Base unit",
  pack_units: "Packs",
  mrp: "MRP",
  purchase_rate: "Purchase rate",
  dealer_price: "Selling rate",
  aliases: "Retailer names",
  active: "Active",
  stock: "Stock (pcs)",
};

function showValue(f: string, v: unknown): string {
  if (f === "purchase_rate" && (v === null || v === undefined)) return "none";
  if (f === "mrp" || f === "dealer_price" || f === "purchase_rate") return rupees(String(v));
  if (f === "pack_units") return Object.entries(v as Record<string, number>).map(([u, n]) => `${u} ${n}`).join(" · ");
  if (f === "aliases") return (v as string[]).join(", ") || "none";
  if (f === "active") return v ? "yes" : "no";
  if (f === "stock") return v === null || v === undefined ? "not tracked" : String(v);
  return String(v) || "empty";
}

function ImportPanel({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [hideMissing, setHideMissing] = useState(false);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const guide = useQuery({
    queryKey: ["catalogue-template-columns"],
    queryFn: () => api<{ columns: Array<{ head: string; required: boolean; help: string; example: string }> }>("/v1/catalogue/template-columns"),
    staleTime: Infinity,
  });

  const run = useMutation({
    mutationFn: (dry_run: boolean) => api<ImportResult>("/v1/catalogue/import", { method: "POST", body: { csv: file!.text, dry_run, hide_missing: hideMissing } }),
    onSuccess: (r) => {
      if (r.applied) {
        const c = r.counts;
        onDone(`Upload saved: ${c.create} new, ${c.update} changed${c.hide ? `, ${c.hide} hidden` : ""}.`);
      } else setPreview(r);
    },
  });

  const pick = async (f: File | undefined) => {
    setPreview(null);
    setReadErr(null);
    run.reset();
    if (!f) return setFile(null);
    if (f.size > 900_000) return setReadErr("This file is larger than 900 KB. Split it into smaller files.");
    const text = await f.text();
    if (text.includes("�")) setReadErr("Some characters could not be read. In Excel, save as “CSV UTF-8 (Comma delimited)” so Tamil names stay correct.");
    setFile({ name: f.name, text });
  };

  const changes = preview?.items.filter((i) => i.action !== "unchanged") ?? [];
  const total = (preview?.counts.create ?? 0) + (preview?.counts.update ?? 0) + (preview?.counts.hide ?? 0);

  return (
    <div className="card card-pad panel">
      <div className="panel-head">
        <h2>Bulk upload: items, rates and stock</h2>
        <button type="button" className="btn small" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>
      <ol className="steps">
        <li>
          <strong>Get the sheet.</strong> New list: <a href="/v1/catalogue/template.csv" download>download the template</a>. Changing your items:{" "}
          <a href="/v1/catalogue/export.csv" download>download your current list</a>.
        </li>
        <li>
          <strong>Fill it in Excel</strong>, one row per item: MRP, purchase rate, selling rate, stock. Rows with code <code>EXAMPLE-…</code> are skipped.
        </li>
        <li>
          <strong>Save as “CSV UTF-8 (Comma delimited)”</strong> so Tamil names stay correct.
        </li>
        <li>
          <strong>Upload it below</strong> and check the preview. Nothing is saved until you press Save.
        </li>
      </ol>
      <button type="button" className="linkbtn guide-toggle" onClick={() => setShowGuide(!showGuide)} aria-expanded={showGuide}>
        {showGuide ? "Hide" : "Show"} what each column means
      </button>
      {showGuide && guide.data && (
        <table className="table guide">
          <colgroup>
            <col style={{ width: "22%" }} />
            <col />
            <col style={{ width: "26%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Column</th>
              <th>What to enter</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            {guide.data.columns.map((c) => (
              <tr key={c.head}>
                <td>
                  <strong>{c.head}</strong>
                  {c.required && <span className="req"> required</span>}
                </td>
                <td>{c.help}</td>
                <td>
                  <code>{c.example}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">
        Items are matched by <strong>Item Code</strong>: new codes are added, existing ones are updated. Empty <strong>Stock Qty</strong> keeps the current stock.
      </p>

      <div className="upload-row">
        <input id="csv-file" type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} />
        <label className="check">
          <input
            type="checkbox"
            checked={hideMissing}
            onChange={(e) => {
              setHideMissing(e.target.checked);
              setPreview(null);
            }}
          />
          Hide products that are not in this file (use when the file is your full price list)
        </label>
      </div>
      {readErr && <p className="error-text">{readErr}</p>}

      {!preview && (
        <div className="panel-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!file || run.isPending} onClick={() => run.mutate(true)}>
            {run.isPending ? "Checking…" : "Check file"}
          </button>
        </div>
      )}
      {run.error && <p className="error-text">{run.error instanceof ApiError ? run.error.message : "Could not read the file."}</p>}

      {preview && (
        <div className="preview">
          <div className="preview-counts">
            <span className="badge ok">{preview.counts.create} new</span>
            <span className="badge bot">{preview.counts.update} changed</span>
            <span className="badge neutral">{preview.counts.unchanged} unchanged</span>
            {preview.counts.skipped > 0 && <span className="badge neutral">{preview.counts.skipped} example rows skipped</span>}
            {preview.counts.hide > 0 && <span className="badge human">{preview.counts.hide} to hide</span>}
            {preview.errors.length > 0 && <span className="badge bad">{preview.errors.length} with errors</span>}
          </div>

          {preview.errors.length > 0 && (
            <div className="banner bad" role="alert">
              <div>
                <strong>Nothing has been saved.</strong> Fix these rows in the file and upload it again:
                <ul className="err-list">
                  {preview.errors.slice(0, 50).map((e, i) => (
                    <li key={i}>
                      Line {e.line}: {e.message}
                    </li>
                  ))}
                  {preview.errors.length > 50 && <li>…and {preview.errors.length - 50} more</li>}
                </ul>
              </div>
            </div>
          )}

          {changes.length > 0 && (
            <ul className="change-list">
              {changes.slice(0, 200).map((c) => (
                <li key={c.sku}>
                  <div>
                    <span className={`badge ${c.action === "create" ? "ok" : "bot"}`}>{c.action === "create" ? "New" : "Changed"}</span> <strong>{c.name}</strong>{" "}
                    <span className="cell-sub">{c.sku}</span>
                  </div>
                  {c.action === "update" && (
                    <div className="cell-sub">
                      {Object.entries(c.changes).map(([f, v]) => (
                        <div key={f}>
                          {FIELD_LABEL[f] ?? f}: {showValue(f, v.from)} → <strong>{showValue(f, v.to)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
              {preview.hide.map((h) => (
                <li key={h.sku}>
                  <span className="badge human">Hide</span> <strong>{h.name}</strong> <span className="cell-sub">{h.sku}</span>
                </li>
              ))}
              {changes.length > 200 && <li className="cell-sub">…and {changes.length - 200} more</li>}
            </ul>
          )}
          {preview.errors.length === 0 && total === 0 && <p className="hint">Everything in this file already matches the catalogue. Nothing to save.</p>}

          <div className="panel-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            {preview.errors.length === 0 && total > 0 && (
              <button className="btn primary" disabled={run.isPending} onClick={() => run.mutate(false)}>
                {run.isPending ? "Saving…" : `Save ${total} change${total === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Learned from chats -----------------------------------------------------------------------

/**
 * What retailers actually typed. The assistant never learns on its own: a suggestion only starts
 * matching after someone approves it here (architecture 8.3, approved aliases).
 */
function ReviewPanel({ products, onChanged, onNotice }: { products: Product[]; onChanged: () => void; onNotice: (m: string) => void }) {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ["catalogue-learning"], queryFn: () => api<Learning>("/v1/catalogue/learning") });
  const [linkTo, setLinkTo] = useState<Record<string, string>>({});
  const done = (msg: string) => {
    onNotice(msg);
    void qc.invalidateQueries({ queryKey: ["catalogue-learning"] });
    onChanged();
  };
  const review = useMutation({
    mutationFn: (v: { id: string; decision: "approve" | "reject"; alias: string; product: string }) => api(`/v1/catalogue/aliases/${v.id}/${v.decision}`, { method: "POST", body: {} }),
    onSuccess: (_r, v) => done(v.decision === "approve" ? `"${v.alias}" now means ${v.product}.` : `"${v.alias}" will not be suggested for ${v.product} again.`),
  });
  const link = useMutation({
    mutationFn: (v: { id: string; sku_id: string; phrase: string; product: string }) => api(`/v1/catalogue/unmatched/${v.id}/link`, { method: "POST", body: { sku_id: v.sku_id } }),
    onSuccess: (_r, v) => done(`"${v.phrase}" now means ${v.product}.`),
  });
  const ignore = useMutation({
    mutationFn: (v: { id: string; phrase: string }) => api(`/v1/catalogue/unmatched/${v.id}/ignore`, { method: "POST", body: {} }),
    onSuccess: (_r, v) => done(`"${v.phrase}" ignored.`),
  });

  const s = data.data?.suggestions ?? [];
  const u = data.data?.unmatched ?? [];
  if (!s.length && !u.length) return null;
  const busy = review.isPending || link.isPending || ignore.isPending;
  const active = products.filter((p) => p.active);
  const err = review.error ?? link.error ?? ignore.error;

  return (
    <div className="card card-pad panel review">
      <div className="panel-head">
        <h2>
          Learned from chats <span className="badge human">{s.length + u.length} to review</span>
        </h2>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Words retailers used that the assistant was not sure about. Approve the ones that are right and the assistant will understand them next time without
        asking.
      </p>
      {err && <p className="error-text">{err instanceof ApiError ? err.message : "Could not save."}</p>}

      {s.length > 0 && (
        <>
          <h3>Retailers picked a product for these words</h3>
          <ul className="review-list">
            {s.map((x) => (
              <li key={x.id}>
                <div className="review-text">
                  <strong>"{x.alias}"</strong> → {x.product_name}
                  <span className="cell-sub"> · {x.times_seen === 1 ? "once" : `${x.times_seen} times`}</span>
                </div>
                <div className="row-actions">
                  <button className="btn small primary" disabled={busy} onClick={() => review.mutate({ id: x.id, decision: "approve", alias: x.alias, product: x.product_name })}>
                    Approve
                  </button>
                  <button className="btn small" disabled={busy} onClick={() => review.mutate({ id: x.id, decision: "reject", alias: x.alias, product: x.product_name })}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {u.length > 0 && (
        <>
          <h3>Names the assistant could not find</h3>
          <ul className="review-list">
            {u.map((x) => {
              const chosen = linkTo[x.id] ?? "";
              const product = active.find((p) => p.id === chosen);
              return (
                <li key={x.id}>
                  <div className="review-text">
                    <strong>"{x.example}"</strong>
                    <span className="cell-sub"> · {x.times_seen === 1 ? "once" : `${x.times_seen} times`}</span>
                  </div>
                  <div className="row-actions">
                    <select className="select link-select" value={chosen} onChange={(e) => setLinkTo({ ...linkTo, [x.id]: e.target.value })} aria-label={`Product for ${x.example}`}>
                      <option value="">Choose product…</option>
                      {active.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn small primary"
                      disabled={busy || !product}
                      onClick={() => product && link.mutate({ id: x.id, sku_id: product.id, phrase: x.example, product: product.name })}
                    >
                      Link
                    </button>
                    <button className="btn small" disabled={busy} onClick={() => ignore.mutate({ id: x.id, phrase: x.example })}>
                      Ignore
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

// ---- Stock --------------------------------------------------------------------------------------

const MOVE_TEXT: Record<StockMovement["kind"], string> = {
  SET: "Count set",
  RECEIVE: "Stock received",
  ORDER: "Ordered on chat",
  RELEASE: "Returned (order rejected/cancelled)",
  UNTRACK: "Stopped tracking",
};

/**
 * What we have to sell. Retailers cannot order more than this; a confirmed order takes its stock
 * straight away and a rejected or cancelled order gives it back.
 */
function StockPanel({ product, onClose, onSaved }: { product: Product; onClose: () => void; onSaved: (p: Product) => void }) {
  const qc = useQueryClient();
  const [p, setP] = useState(product);
  const tracked = p.stock !== null;
  const [mode, setMode] = useState<"set" | "add">(tracked ? "add" : "set");
  const units = packsDesc(p);
  const [unit, setUnit] = useState(units[0]?.[0] ?? p.base_unit);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const history = useQuery({ queryKey: ["stock", p.id], queryFn: () => api<{ history: StockMovement[] }>(`/v1/catalogue/products/${p.id}/stock`) });

  const per = p.pack_units[unit] ?? 1;
  const n = Number(qty);
  const valid = qty.trim() !== "" && Number.isFinite(n) && n >= 0 && (mode === "set" || n > 0) && Number.isInteger(n * per);
  const pieces = valid ? n * per : 0;
  const current = tracked ? Number(p.stock) : 0;
  const after = mode === "set" ? pieces : current + pieces;

  const save = useMutation({
    mutationFn: (body: { mode: "set" | "add" | "untrack"; quantity?: number; unit?: string; note?: string }) =>
      api<Product & { history: StockMovement[] }>(`/v1/catalogue/products/${p.id}/stock`, { method: "POST", body }),
    onSuccess: (r) => {
      const { history: _h, ...next } = r;
      setP(next);
      setQty("");
      setNote("");
      setMode(next.stock === null ? "set" : "add");
      void qc.invalidateQueries({ queryKey: ["stock", p.id] });
      onSaved(next);
    },
  });

  return (
    <div className="card card-pad panel">
      <div className="panel-head">
        <h2>Stock: {p.name}</h2>
        <button type="button" className="btn small" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="stock-now">
        <div>
          <div className="cell-sub">Available to sell now</div>
          {tracked ? (
            <div className="stock-big">
              {current <= 0 ? <span className="badge bad">Out of stock</span> : stockBreakdown(p, current)}
              <span className="cell-sub">
                {" "}
                = {current} {unitName(p.base_unit)}
              </span>
            </div>
          ) : (
            <div className="stock-big">
              Not tracked <span className="cell-sub">(retailers can order any quantity)</span>
            </div>
          )}
        </div>
        <div className="cell-sub">{packText(p.pack_units, p.base_unit)}</div>
      </div>

      <form
        className="stock-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate({ mode, quantity: n, unit, note: note.trim() || undefined });
        }}
      >
        <div className="seg" role="group" aria-label="Stock change">
          <button type="button" aria-pressed={mode === "add"} onClick={() => setMode("add")} disabled={!tracked}>
            Add received stock
          </button>
          <button type="button" aria-pressed={mode === "set"} onClick={() => setMode("set")}>
            {tracked ? "Correct the count" : "Start tracking"}
          </button>
        </div>
        <div className="stock-row">
          <label className="field" style={{ margin: 0 }}>
            <span>{mode === "add" ? "Received" : "Available now"}</span>
            <input className="input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" autoFocus />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Pack</span>
            <select className="select" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {units.map(([u, k]) => (
                <option key={u} value={u}>
                  {unitName(u)}
                  {u !== p.base_unit ? ` (${k} ${unitName(p.base_unit)})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, flex: "2 1 200px" }}>
            <span>Note (optional)</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === "add" ? "e.g. Invoice 4521 from Britannia" : "e.g. Shelf count 12 Nov"} />
          </label>
        </div>
        {valid && (
          <p className="hint">
            {mode === "add" ? `+${pieces} ${unitName(p.base_unit)}. ` : ""}New stock: <strong>{after} {unitName(p.base_unit)}</strong>
            {after > 0 ? ` (${stockBreakdown(p, after)})` : " (out of stock: retailers cannot order it)"}
          </p>
        )}
        {qty.trim() !== "" && !valid && <p className="error-text">Enter a whole number{per > 1 ? ` of ${unitName(unit)}` : ""}.</p>}
        {save.error && <p className="error-text">{save.error instanceof ApiError ? save.error.message : "Could not save."}</p>}
        <div className="panel-actions" style={{ justifyContent: "space-between" }}>
          {tracked ? (
            <button type="button" className="linkbtn muted" onClick={() => save.mutate({ mode: "untrack" })} disabled={save.isPending}>
              Stop tracking stock for this product
            </button>
          ) : (
            <span />
          )}
          <button className="btn primary" disabled={!valid || save.isPending}>
            {save.isPending ? "Saving…" : mode === "add" ? "Add stock" : "Save count"}
          </button>
        </div>
      </form>

      <h3 className="section-title" style={{ marginTop: 14 }}>
        Recent stock changes
      </h3>
      {history.data && history.data.history.length === 0 && <p className="hint">No changes yet.</p>}
      {history.data && history.data.history.length > 0 && (
        <ul className="change-list">
          {history.data.history.map((h, i) => {
            const q = Number(h.quantity);
            return (
              <li key={i}>
                <div>
                  <strong>{MOVE_TEXT[h.kind]}</strong>
                  {h.kind === "SET" ? ` to ${q}` : h.kind !== "UNTRACK" ? ` ${q > 0 ? "+" : ""}${q}` : ""} {h.kind !== "UNTRACK" ? unitName(p.base_unit) : ""}
                  {h.order_number ? ` · ORD-${h.order_number.padStart(6, "0")}` : ""}
                  {h.balance_after !== null ? <span className="cell-sub"> → {Number(h.balance_after)} left</span> : null}
                </div>
                <div className="cell-sub">
                  {fmtFull(h.at)}
                  {h.by ? ` · ${h.by}` : ""}
                  {h.note ? ` · ${h.note}` : ""}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
