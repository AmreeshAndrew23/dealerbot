// The customer app. A shop owner signs in with their phone number and a dealer's access code, and
// can add more dealers (distributors) with their codes. For each dealer: chat (with the order
// assistant or the dealer's staff), the dealer's price list with a cart, and orders. Across dealers:
// all orders, and the account. Laid out as a web app: a top bar, the dealers in a sidebar and the
// open screen beside it (on a narrow window the sidebar folds into the overview). Screens are
// addressed by the URL hash, so the browser's back button and reloads work:
//   #/                 overview         #/d/:dealer/chat         chat with one dealer
//   #/orders           all orders       #/d/:dealer/prices       that dealer's price list (+ cart)
//   #/account          account          #/d/:dealer/orders[/:id] that dealer's orders
//   #/add              add a dealer
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ApiError, type Me } from "./api";
import { CartProvider } from "./cart";
import { Icon, go, useRoute, useWide, type IconName } from "./ui";
import { AddDealer, DealerSidebar, Overview } from "./screens/Dealers";
import { DealerScreen } from "./screens/Dealer";
import { AllOrders } from "./screens/Orders";
import { Account } from "./screens/Account";

export function App() {
  const qc = useQueryClient();
  // Signed out, nothing re-checks on a timer or on coming back to the tab: each re-check used to
  // swap the sign-in form for "Loading…" and wipe what was typed into it.
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/me"),
    retry: false,
    refetchInterval: (q) => (q.state.data ? 15_000 : false),
    refetchOnWindowFocus: (q) => !!q.state.data,
  });
  const signedOut = me.error instanceof ApiError && me.error.status === 401;
  // Only the very first check shows the splash; later ones keep the current screen mounted.
  if (me.isPending && me.data === undefined && me.errorUpdateCount === 0) return <div className="splash">Loading…</div>;
  if (signedOut || !me.data || me.data.dealers.length === 0) {
    if (me.error && !signedOut) {
      return (
        <div className="splash">
          <p>Could not reach the server.</p>
          <button className="btn primary" onClick={() => me.refetch()}>
            Try again
          </button>
        </div>
      );
    }
    return <Login onDone={(m) => (qc.setQueryData<Me>(["me"], m), go("/", true))} />;
  }
  return (
    <CartProvider>
      <Shell me={me.data} />
    </CartProvider>
  );
}

function Login({ onDone }: { onDone: (me: Me) => void }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const login = useMutation({ mutationFn: () => api<Me>("/login", { method: "POST", body: { phone, code } }), onSuccess: onDone });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <div className="login">
      <section className="login-hero" aria-hidden="true">
        <span className="logo">
          <Icon name="store" size={22} />
        </span>
        <h2>All your distributors in one place</h2>
        <ul>
          <li>See each dealer's price list, your rates and margins</li>
          <li>Order from the price list or by chat, in English, Tamil or Tanglish</li>
          <li>Follow every order until the dealer accepts it</li>
        </ul>
      </section>
      <form className="card" onSubmit={submit}>
        <span className="logo" aria-hidden="true">
          <Icon name="store" size={22} />
        </span>
        <h1>Order from your dealers</h1>
        <p className="sub">Sign in with your shop's phone number and the access code a dealer sent you. You can add your other dealers after signing in.</p>
        <div className="field">
          <label htmlFor="phone">Phone number</label>
          <input id="phone" className="input" inputMode="tel" autoComplete="tel" required placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <span className="hint">Outside India, start with the country code (+1…).</span>
        </div>
        <div className="field">
          <label htmlFor="code">Access code</label>
          <input id="code" className="input code" inputMode="numeric" autoComplete="one-time-code" required maxLength={6} placeholder="6 digits" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        </div>
        {login.error && (
          <p className="error-text" role="alert">
            {login.error instanceof ApiError ? login.error.message : "Could not reach the server. Check your internet and try again."}
          </p>
        )}
        <button className="btn primary wide" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Shell({ me }: { me: Me }) {
  const wide = useWide();
  const { parts, query } = useRoute();
  const [section = "", dealerId, tab, sub] = parts;
  const dealer = section === "d" ? me.dealers.find((d) => d.id === dealerId) : undefined;
  if (section === "d" && !dealer) {
    // A dealer that was removed (or a stale link): back to the overview.
    queueMicrotask(() => go("/", true));
    return null;
  }
  const page = section === "orders" || section === "account" || section === "add" ? section : section === "d" ? "dealer" : "home";
  const unread = me.dealers.reduce((n, d) => n + d.unread, 0);
  const nav: Array<{ id: string; path: string; icon: IconName; label: string; badge?: number }> = [
    { id: "home", path: "/", icon: "home", label: "Overview", badge: wide ? 0 : unread },
    { id: "orders", path: "/orders", icon: "orders", label: "All orders" },
    { id: "account", path: "/account", icon: "user", label: "Account" },
  ];
  const t = tab === "prices" || tab === "orders" ? tab : "chat";
  return (
    <div className="web">
      <header className="topbar">
        <button className="brand" onClick={() => go("/")}>
          <span className="logo" aria-hidden="true">
            <Icon name="store" size={18} />
          </span>
          <span className="brand-name">Order portal</span>
        </button>
        <nav className="topnav" aria-label="Sections">
          {nav.map((x) => (
            <button key={x.id} aria-current={page === x.id ? "page" : undefined} onClick={() => go(x.path)}>
              <Icon name={x.icon} size={18} />
              <span>{x.label}</span>
              {!!x.badge && <span className="dot-count inline">{x.badge > 99 ? "99+" : x.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="me-chip">
          <strong>{me.dealers[0]!.shop_name}</strong>
          <span>{me.phone}</span>
        </div>
      </header>
      <div className="web-body">
        {wide && (
          <aside className="sidebar" aria-label="Your dealers">
            <DealerSidebar me={me} current={dealer?.id} />
          </aside>
        )}
        <main className="main">
          {dealer && <DealerScreen me={me} dealer={dealer} tab={t} orderId={t === "orders" ? sub : undefined} query={query} />}
          {page === "home" && <Overview me={me} />}
          {page === "orders" && <AllOrders />}
          {page === "account" && <Account me={me} />}
          {page === "add" && <AddDealer />}
        </main>
      </div>
    </div>
  );
}
