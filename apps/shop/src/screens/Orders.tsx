// Orders: one dealer's, all dealers' together, and one order in full (what happened to it, its
// items, "Order again" and "Ask about this order").
import { useQuery } from "@tanstack/react-query";
import { api, type Dealer, type ShopOrder, type ShopOrderDetail } from "../api";
import { useCart } from "../cart";
import { Icon, StatusBadge, back, fullFmt, go, rupees, unit, useWide } from "../ui";

function OrderList({ orders, showDealer, empty }: { orders: ShopOrder[]; showDealer: boolean; empty: React.ReactNode }) {
  const wide = useWide();
  if (!orders.length) return <div className="note">{empty}</div>;
  if (wide) {
    return (
      <table className="table orders-table">
        <thead>
          <tr>
            <th>Order</th>
            {showDealer && <th>Dealer</th>}
            <th>Placed</th>
            <th className="num">Items</th>
            <th>Status</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="clickable" tabIndex={0} onClick={() => go(`/d/${o.dealer.id}/orders/${o.id}`)} onKeyDown={(e) => e.key === "Enter" && go(`/d/${o.dealer.id}/orders/${o.id}`)}>
              <td>
                <strong>{o.order_number}</strong>
                {o.updated && <span className="muted"> · changed by you</span>}
              </td>
              {showDealer && <td>{o.dealer.name}</td>}
              <td>{fullFmt.format(new Date(o.placed_at))}</td>
              <td className="num">{o.line_count}</td>
              <td>
                <StatusBadge s={o.status} />
              </td>
              <td className="num">
                <strong>{rupees(o.total)}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <ul className="order-list">
      {orders.map((o) => (
        <li key={o.id}>
          <button className="order-row" onClick={() => go(`/d/${o.dealer.id}/orders/${o.id}`)}>
            <span className="order-main">
              <span className="order-top">
                <strong>{o.order_number}</strong>
                {showDealer && <span className="dealer-chip">{o.dealer.name}</span>}
              </span>
              <span className="muted">
                {fullFmt.format(new Date(o.placed_at))} · {o.line_count} item{o.line_count === 1 ? "" : "s"}
                {o.updated ? " · changed by you" : ""}
              </span>
              <StatusBadge s={o.status} />
            </span>
            <strong className="order-total">{rupees(o.total)}</strong>
            <span className="chev">
              <Icon name="chevron" size={18} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function DealerOrders({ dealer }: { dealer: Dealer }) {
  const list = useQuery({ queryKey: ["orders", dealer.id], queryFn: () => api<{ orders: ShopOrder[] }>(`/dealers/${dealer.id}/orders`), refetchInterval: 15_000 });
  return (
    <div className="scroll page">
      {list.isPending && <div className="note">Loading…</div>}
      {list.error && !list.data && <div className="note">Could not load your orders. Check your internet.</div>}
      {list.data && (
        <OrderList
          orders={list.data.orders}
          showDealer={false}
          empty={
            <>
              No orders with {dealer.name} yet.{" "}
              <button className="link" onClick={() => go(`/d/${dealer.id}/prices`, true)}>
                Open the price list
              </button>
            </>
          }
        />
      )}
    </div>
  );
}

export function AllOrders() {
  const list = useQuery({ queryKey: ["orders", "all"], queryFn: () => api<{ orders: ShopOrder[] }>(`/orders`), refetchInterval: 20_000 });
  const orders = list.data?.orders ?? [];
  const waiting = orders.filter((o) => o.status === "received");
  return (
    <div className="scroll page">
      <div className="page-head">
        <h1>All orders</h1>
      </div>
      {list.isPending && <div className="note">Loading…</div>}
      {list.error && !list.data && <div className="note">Could not load your orders. Check your internet.</div>}
      {list.data && orders.length > 0 && (
        <div className="stats">
          <div className="stat">
            <span className="stat-n">{orders.length}</span>
            <span className="muted">orders</span>
          </div>
          <div className="stat">
            <span className="stat-n">{waiting.length}</span>
            <span className="muted">waiting for a dealer</span>
          </div>
          <div className="stat">
            <span className="stat-n">{rupees(waiting.reduce((t, o) => t + Number(o.total), 0))}</span>
            <span className="muted">in waiting orders</span>
          </div>
        </div>
      )}
      {list.data && <OrderList orders={orders} showDealer empty="No orders yet. Open a dealer to see their price list and order." />}
    </div>
  );
}

/** The overview's last few orders, across all dealers (same data as All orders). */
export function RecentOrders() {
  const list = useQuery({ queryKey: ["orders", "all"], queryFn: () => api<{ orders: ShopOrder[] }>(`/orders`), refetchInterval: 20_000 });
  if (list.isPending) return <div className="note">Loading…</div>;
  if (!list.data) return <div className="note">Could not load your orders. Check your internet.</div>;
  return <OrderList orders={list.data.orders.slice(0, 5)} showDealer empty="No orders yet. Open a dealer's price list to place your first order." />;
}

const EVENT: Record<ShopOrderDetail["timeline"][number]["event"], string> = {
  placed: "You placed the order",
  changed: "You changed the order",
  accepted: "The dealer accepted it",
  rejected: "The dealer could not accept it",
  cancelled: "Cancelled",
};

export function OrderDetail({ dealerId, id }: { dealerId: string; id: string }) {
  const cart = useCart();
  const q = useQuery({ queryKey: ["order", dealerId, id], queryFn: () => api<ShopOrderDetail>(`/dealers/${dealerId}/orders/${id}`), refetchInterval: 20_000 });
  const o = q.data;
  return (
    <div className="scroll page">
      <button className="link back-link" onClick={() => back(`/d/${dealerId}/orders`)}>
        <Icon name="back" size={16} /> Orders
      </button>
      {q.isPending && <div className="note">Loading…</div>}
      {q.error && !o && <div className="note">Could not load this order.</div>}
      {o && (
        <div className="order-detail">
          <div className="panel">
            <div className="order-detail-head">
              <div>
                <h2>{o.order_number}</h2>
                <span className="muted">{o.dealer.name}</span>
              </div>
              <StatusBadge s={o.status} />
            </div>
            {o.reason && <p className="reason">Reason: {o.reason}</p>}
            <ul className="lines">
              {o.lines.map((l) => (
                <li key={l.line_no}>
                  <span className="line-name">
                    {l.name}
                    <span className="muted">
                      {Number(l.quantity)} {unit(l.unit)}
                      {l.unit !== l.base_unit ? ` (${Number(l.base_quantity)} ${unit(l.base_unit)})` : ""} × {rupees(l.rate)}/{unit(l.base_unit)}
                    </span>
                  </span>
                  <span className="line-amount">{rupees(l.amount)}</span>
                </li>
              ))}
              <li className="total">
                <span>Total</span>
                <span className="line-amount">{rupees(o.total)}</span>
              </li>
            </ul>
            <p className="hint">An order copy, not a tax invoice. The dealer's bill may differ (schemes, taxes).</p>
          </div>
          <div className="panel order-side">
            <h2 className="panel-title">What happened</h2>
            <ol className="timeline">
              {o.timeline.map((t, i) => (
                <li key={i} className={t.event}>
                  <span>{EVENT[t.event]}</span>
                  <span className="muted">
                    {fullFmt.format(new Date(t.at))}
                    {t.total ? ` · ${rupees(t.total)}` : ""}
                  </span>
                </li>
              ))}
              {o.status === "received" && (
                <li className="next">
                  <span>Waiting for {o.dealer.name} to accept</span>
                  <span className="muted">You can still add or change items in the chat until then.</span>
                </li>
              )}
            </ol>
            <div className="detail-actions">
              <button
                className="btn"
                onClick={() => {
                  // Today's prices apply; nothing is ordered until it is sent and confirmed with YES.
                  if (cart.items(dealerId).length && !window.confirm("Replace the items already in your cart with this order's items?")) return;
                  cart.replace(
                    dealerId,
                    o.lines.map((l) => ({ sku: l.sku, unit: l.unit, qty: Number(l.quantity) })),
                  );
                  go(`/d/${dealerId}/prices?cart=1`);
                }}
              >
                <Icon name="repeat" size={18} /> Order again
              </button>
              <button className="btn" onClick={() => go(`/d/${dealerId}/chat?text=${encodeURIComponent(`About order ${o.order_number}: `)}`)}>
                <Icon name="chat" size={18} /> Ask about this order
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
