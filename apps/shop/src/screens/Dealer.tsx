// One dealer: its name on top with the Chat, Price list and Orders tabs, and the open tab below.
import type { Dealer, Me } from "../api";
import { useCart } from "../cart";
import { Icon, go, initials, useWide, type IconName } from "../ui";
import { ChatView } from "./Chat";
import { PriceList } from "./PriceList";
import { DealerOrders, OrderDetail } from "./Orders";

type Tab = "chat" | "prices" | "orders";

export function DealerScreen({ me, dealer, tab, orderId, query }: { me: Me; dealer: Dealer; tab: Tab; orderId?: string; query: URLSearchParams }) {
  const wide = useWide();
  const cart = useCart();
  const inCart = cart.items(dealer.id).reduce((n, i) => n + (i.qty > 0 ? 1 : 0), 0);
  const tabs: Array<{ id: Tab; icon: IconName; label: string; badge?: number }> = [
    { id: "chat", icon: "chat", label: "Chat", badge: dealer.unread },
    { id: "prices", icon: "list", label: "Price list", badge: inCart },
    { id: "orders", icon: "orders", label: "Orders", badge: dealer.waiting_orders },
  ];
  return (
    <div className="dealer-screen">
      <header className="dealer-head">
        {!wide && (
          <button className="btn ghost" aria-label="All dealers" onClick={() => go("/")}>
            <Icon name="back" />
          </button>
        )}
        <span className="avatar" aria-hidden="true">
          {initials(dealer.name)}
        </span>
        <div className="who">
          <h1>{dealer.name}</h1>
          <div className="muted">
            As {dealer.shop_name}
            {dealer.with_staff ? " · staff are replying" : ""}
            {me.dealers.length > 1 && !wide ? ` · 1 of ${me.dealers.length} dealers` : ""}
          </div>
        </div>
        <nav className="seg" aria-label={`${dealer.name} sections`}>
          {tabs.map((x) => (
            <button key={x.id} aria-current={tab === x.id ? "page" : undefined} onClick={() => go(`/d/${dealer.id}/${x.id}`, true)}>
              <Icon name={x.icon} size={18} />
              <span>{x.label}</span>
              {!!x.badge && <span className="dot-count inline">{x.badge > 99 ? "99+" : x.badge}</span>}
            </button>
          ))}
        </nav>
      </header>
      <div className="dealer-body">
        {tab === "chat" && <ChatView dealer={dealer} prefill={query.get("text") ?? ""} />}
        {tab === "prices" && <PriceList dealer={dealer} openCart={query.get("cart") === "1"} />}
        {tab === "orders" && (orderId ? <OrderDetail dealerId={dealer.id} id={orderId} /> : <DealerOrders dealer={dealer} />)}
      </div>
    </div>
  );
}
