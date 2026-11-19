// One dealer's price list: search, categories, MRP / the shop's rate / margin, out-of-stock tags,
// and a cart. "Send order" puts the cart into the chat; the assistant answers with the order
// summary and the order is placed only when the shop replies YES there (same rules as typing it).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Catalogue, type CatalogueItem, type Dealer } from "../api";
import { useCart } from "../cart";
import { Icon, go, rupees, unit, unitTitle, useWide } from "../ui";

const paise = (v: string) => Math.round(Number(v) * 100);
/** The shop's margin on MRP, e.g. 14 (%); null when it would mislead (no MRP, rate above MRP). */
function margin(i: CatalogueItem): number | null {
  const mrp = Number(i.mrp);
  const rate = Number(i.rate);
  if (!(mrp > 0) || !(rate > 0) || rate >= mrp) return null;
  return Math.round(((mrp - rate) / mrp) * 100);
}

export function PriceList({ dealer, openCart }: { dealer: Dealer; openCart: boolean }) {
  const wide = useWide();
  const cat = useQuery({
    queryKey: ["catalogue", dealer.id],
    queryFn: () => api<Catalogue>(`/dealers/${dealer.id}/catalogue`),
    refetchInterval: 60_000,
  });
  const cart = useCart();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState(openCart);

  const items = cat.data?.items ?? [];
  const categories = useMemo(() => [...new Set(items.map((i) => i.category))], [items]);
  const shown = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((i) => (!category || i.category === category) && words.every((w) => `${i.name} ${i.category}`.toLowerCase().includes(w)));
  }, [items, search, category]);

  const bySku = new Map(items.map((i) => [i.sku, i]));
  const lines = cart.items(dealer.id);
  const priced = lines.map((l) => {
    const item = bySku.get(l.sku);
    const pack = item?.packs.find((p) => p.unit === l.unit);
    return {
      ...l,
      item,
      pack,
      amount: pack && item?.in_stock ? paise(pack.price) * l.qty : 0,
    };
  });
  const total = priced.reduce((t, l) => t + l.amount, 0);
  const count = priced.filter((l) => l.pack && l.item?.in_stock).length;

  const toolbar = (
    <>
      <div className="search">
        <Icon name="search" size={18} />
        <label htmlFor="q" className="sr-only">
          Search products
        </label>
        <input id="q" className="input" type="search" placeholder={`Search ${items.length} products`} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {categories.length > 1 && (
        <div className="cats" role="group" aria-label="Categories">
          <button className={`chip small${category === null ? " on" : ""}`} onClick={() => setCategory(null)}>
            All
          </button>
          {categories.map((c) => (
            <button key={c} className={`chip small${category === c ? " on" : ""}`} onClick={() => setCategory(category === c ? null : c)}>
              {c}
            </button>
          ))}
        </div>
      )}
    </>
  );
  const setQty = (sku: string, u: string, v: number) => cart.set(dealer.id, sku, u, v);

  if (cat.isPending)
    return (
      <div className="scroll">
        <div className="note">Loading the price list…</div>
      </div>
    );
  if (!cat.data)
    return (
      <div className="scroll">
        <div className="note">Could not load the price list. Check your internet.</div>
      </div>
    );

  if (wide) {
    return (
      <div className="prices-wide">
        <div className="scroll prices-main">
          <div className="toolbar">{toolbar}</div>
          <p className="hint list-note">Your rates, before any scheme. The dealer confirms the final bill.</p>
          {shown.length === 0 ? (
            <div className="note">{search ? `No product matches “${search}”.` : "No products in this category."}</div>
          ) : (
            <div className="table-wrap">
              <table className="table products-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">MRP</th>
                    <th className="num">Your rate</th>
                    <th>Order</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((i) => {
                    const m = margin(i);
                    return (
                      <tr key={i.sku} className={i.in_stock ? "" : "out"}>
                        <td>
                          <strong className="product-name">{i.name}</strong>
                          <span className="muted">{i.category}</span>
                          {!i.in_stock && <span className="badge bad">Out of stock</span>}
                        </td>
                        <td className="num">{rupees(i.mrp)}</td>
                        <td className="num">
                          {rupees(i.rate)}
                          <span className="muted">/{unit(i.base_unit)}</span>
                          {m !== null && <span className="margin rate-margin">{m}% margin</span>}
                        </td>

                        <td>
                          {i.in_stock ? (
                            <OrderCell item={i} qty={(u) => cart.qty(dealer.id, i.sku, u)} onChange={(u, v) => setQty(i.sku, u, v)} />
                          ) : (
                            <span className="muted">Ask the dealer in the chat when it will be back.</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <aside className="cart-panel" aria-labelledby="cart-title">
          <CartContents dealer={dealer} priced={priced} total={total} />
        </aside>
      </div>
    );
  }

  return (
    <>
      <div className="scroll prices">
        {toolbar}
        <p className="hint list-note">Your rates, before any scheme. The dealer confirms the final bill.</p>
        {shown.length === 0 && <div className="note">No product matches “{search}”.</div>}
        <ul className="products">
          {shown.map((i) => {
            const m = margin(i);
            const inCart = i.packs.reduce((n, p) => n + cart.qty(dealer.id, i.sku, p.unit), 0);
            const isOpen = open === i.sku;
            return (
              <li key={i.sku} className={`product${i.in_stock ? "" : " out"}`}>
                <button className="product-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i.sku)}>
                  <span className="product-main">
                    <strong>{i.name}</strong>
                    <span className="muted">
                      MRP {rupees(i.mrp)} · You pay {rupees(i.rate)}/{unit(i.base_unit)}
                      {m !== null && <span className="margin"> · {m}% margin</span>}
                    </span>
                    {!i.in_stock && <span className="badge bad">Out of stock</span>}
                  </span>
                  {inCart > 0 ? <span className="in-cart">{inCart} in cart</span> : i.in_stock ? <span className="add-pill">Add</span> : null}
                </button>
                {isOpen && (
                  <div className="packs">
                    {i.packs.map((p) => {
                      const q = cart.qty(dealer.id, i.sku, p.unit);
                      return (
                        <div key={p.unit} className="pack">
                          <span className="pack-name">
                            {unitTitle(p.unit)}
                            {p.unit !== i.base_unit && (
                              <span className="muted">
                                {" "}
                                · {p.per} {unit(i.base_unit)}
                              </span>
                            )}
                            <span className="pack-price">{rupees(p.price)}</span>
                          </span>
                          <Stepper value={q} disabled={!i.in_stock} label={`${i.name}, ${unit(p.unit)}`} onChange={(v) => cart.set(dealer.id, i.sku, p.unit, v)} />
                        </div>
                      );
                    })}
                    {!i.in_stock && <p className="hint">Out of stock right now. Ask the dealer in the chat when it will be back.</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {count > 0 && (
        <button className="cart-bar" onClick={() => setSheet(true)}>
          <Icon name="cart" />
          <span>
            {count} item{count === 1 ? "" : "s"} · <strong>{rupees(total / 100)}</strong>
          </span>
          <span className="cart-go">Review order</span>
        </button>
      )}
      {sheet && <CartSheet dealer={dealer} priced={priced} total={total} onClose={() => (setSheet(false), openCart && go(`/d/${dealer.id}/prices`, true))} />}
    </>
  );
}

/** One table cell: pick the pack (case, box, piece) and the quantity. Other packs already in the cart are listed under it. */
function OrderCell({ item, qty, onChange }: { item: CatalogueItem; qty: (unit: string) => number; onChange: (unit: string, v: number) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const u = picked ?? item.packs.find((p) => qty(p.unit) > 0)?.unit ?? item.packs[0]!.unit;
  const others = item.packs.filter((p) => p.unit !== u && qty(p.unit) > 0);
  return (
    <div className="order-cell">
      <div className="order-cell-row">
        <label htmlFor={`pk-${item.sku}`} className="sr-only">
          Pack for {item.name}
        </label>
        <select id={`pk-${item.sku}`} className="input pack-select" value={u} onChange={(e) => setPicked(e.target.value)}>
          {item.packs.map((p) => (
            <option key={p.unit} value={p.unit}>
              {unitTitle(p.unit)}
              {p.unit !== item.base_unit ? ` of ${p.per}` : ""} · {rupees(p.price)}
            </option>
          ))}
        </select>
        <Stepper value={qty(u)} label={`${item.name}, ${unit(u)}`} onChange={(v) => onChange(u, v)} />
      </div>
      {others.length > 0 && <span className="muted">Also in cart: {others.map((p) => `${qty(p.unit)} ${unit(p.unit)}`).join(", ")}</span>}
    </div>
  );
}

function Stepper({ value, onChange, disabled, label }: { value: number; onChange: (v: number) => void; disabled?: boolean; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <span className="stepper">
      <button className="step" aria-label={`One less ${label}`} disabled={disabled || value <= 0} onClick={() => onChange(value - 1)}>
        <Icon name="minus" size={18} />
      </button>
      <input
        className="step-qty"
        inputMode="numeric"
        aria-label={`Quantity, ${label}`}
        disabled={disabled}
        value={draft ?? String(value)}
        onFocus={(e) => (setDraft(value ? String(value) : ""), e.currentTarget.select())}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 5))}
        onBlur={() => {
          if (draft !== null) onChange(Number(draft || 0));
          setDraft(null);
        }}
      />
      <button className="step" aria-label={`One more ${label}`} disabled={disabled} onClick={() => onChange(value + 1)}>
        <Icon name="plus" size={18} />
      </button>
    </span>
  );
}

type Priced = {
  sku: string;
  unit: string;
  qty: number;
  item?: CatalogueItem;
  pack?: { unit: string; per: number; price: string };
  amount: number;
};

function CartSheet({ dealer, priced, total, onClose }: { dealer: Dealer; priced: Priced[]; total: number; onClose: () => void }) {
  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-labelledby="cart-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <CartContents dealer={dealer} priced={priced} total={total} onClose={onClose} />
      </div>
    </div>
  );
}

function CartContents({ dealer, priced, total, onClose }: { dealer: Dealer; priced: Priced[]; total: number; onClose?: () => void }) {
  const qc = useQueryClient();
  const cart = useCart();
  const ok = priced.filter((l) => l.pack && l.item?.in_stock);
  const gone = priced.filter((l) => !(l.pack && l.item?.in_stock));
  const body = ok.map(({ sku, unit, qty }) => ({ sku, unit, qty }));
  // Same id while the cart is unchanged: a retry after a network error is not a second order message.
  const sig = JSON.stringify(body);
  const clientId = useMemo(() => crypto.randomUUID(), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; dropped: string[] }>(`/dealers/${dealer.id}/cart`, {
        method: "POST",
        body: { client_id: clientId, items: body },
      }),
    onSuccess: () => {
      cart.clear(dealer.id);
      void qc.invalidateQueries({ queryKey: ["chat", dealer.id] });
      void qc.invalidateQueries({ queryKey: ["me"] });
      go(`/d/${dealer.id}/chat`, true);
    },
  });
  return (
    <>
      <div className="sheet-head">
        <h2 id="cart-title">Your order to {dealer.name}</h2>
        {onClose && (
          <button className="btn ghost" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        )}
      </div>
      {!ok.length && <p className="note">Your cart is empty. Add items from the price list.</p>}
      {ok.length > 0 && (
        <>
          <ul className="lines cart-lines">
            {ok.map((l) => (
              <li key={`${l.sku}:${l.unit}`}>
                <span className="line-name">
                  {l.item!.name}
                  <span className="muted">
                    {rupees(l.pack!.price)} per {unit(l.unit)}
                    {l.unit !== l.item!.base_unit ? ` (${l.pack!.per} ${unit(l.item!.base_unit)})` : ""}
                  </span>
                </span>
                <span className="cart-right">
                  <Stepper value={l.qty} label={`${l.item!.name}, ${unit(l.unit)}`} onChange={(v) => cart.set(dealer.id, l.sku, l.unit, v)} />
                  <span className="line-amount">{rupees(l.amount / 100)}</span>
                </span>
              </li>
            ))}
            <li className="total">
              <span>Estimated total</span>
              <span className="line-amount">{rupees(total / 100)}</span>
            </li>
          </ul>
          {gone.length > 0 && (
            <p className="hint warn-text">
              Not included (out of stock or no longer sold): {gone.map((l) => l.item?.name ?? l.sku).join(", ")}.{" "}
              <button className="link" onClick={() => gone.forEach((l) => cart.set(dealer.id, l.sku, l.unit, 0))}>
                Remove
              </button>
            </p>
          )}
          <p className="hint">The assistant will show you the order in the chat. It is placed only when you reply YES there.</p>
          {send.error && (
            <p className="error-text" role="alert">
              {send.error instanceof ApiError ? send.error.message : "Could not send. Check your internet and try again."}
            </p>
          )}
          <div className="sheet-actions">
            <button className="btn" onClick={() => cart.clear(dealer.id)} disabled={send.isPending}>
              <Icon name="trash" size={18} /> Clear
            </button>
            <button className="btn primary grow" disabled={!ok.length || send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? "Sending…" : "Send order to chat"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
