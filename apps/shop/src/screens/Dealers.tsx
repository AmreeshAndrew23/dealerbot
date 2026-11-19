// The dealers this phone is linked to: the sidebar list, the overview page (totals, a card per
// dealer, recent orders) and adding a dealer with its access code.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ApiError, type Dealer, type Me } from "../api";
import { Icon, go, initials, plain, shortWhen } from "../ui";
import { RecentOrders } from "./Orders";

const preview = (d: Dealer) => {
  const last = d.last_message;
  if (!last) return "No messages yet";
  return `${last.from === "me" ? "You: " : last.from === "staff" ? "Staff: " : ""}${plain(last.text)}`;
};

export function DealerSidebar({ me, current }: { me: Me; current?: string }) {
  const [q, setQ] = useState("");
  const shown = me.dealers.filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="side-head">
        <h2>My dealers</h2>
        <button className="btn small" onClick={() => go("/add")}>
          <Icon name="plus" size={16} /> Add
        </button>
      </div>
      {me.dealers.length > 5 && (
        <div className="search side-search">
          <Icon name="search" size={16} />
          <label htmlFor="dq" className="sr-only">
            Find a dealer
          </label>
          <input id="dq" className="input" type="search" placeholder="Find a dealer" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <ul className="side-list">
        {shown.map((d) => (
          <li key={d.id}>
            <button className={`side-dealer${current === d.id ? " on" : ""}`} aria-current={current === d.id ? "page" : undefined} onClick={() => go(`/d/${d.id}/chat`)}>
              <span className="avatar small" aria-hidden="true">
                {initials(d.name)}
              </span>
              <span className="dealer-main">
                <span className="dealer-row">
                  <strong className="dealer-name">{d.name}</strong>
                  {d.last_message && <span className={`when${d.unread ? " fresh" : ""}`}>{shortWhen(d.last_message.at)}</span>}
                </span>
                <span className="dealer-row">
                  <span className="preview">{preview(d)}</span>
                  {d.unread > 0 && (
                    <span className="unread" aria-label={`${d.unread} unread`}>
                      {d.unread}
                    </span>
                  )}
                </span>
                {(d.waiting_orders > 0 || d.with_staff) && (
                  <span className="dealer-tags">
                    {d.waiting_orders > 0 && <span className="badge wait">{d.waiting_orders} waiting</span>}
                    {d.with_staff && <span className="badge neutral">Staff replying</span>}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Overview({ me }: { me: Me }) {
  const unread = me.dealers.reduce((n, d) => n + d.unread, 0);
  const waiting = me.dealers.reduce((n, d) => n + d.waiting_orders, 0);
  return (
    <div className="scroll page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">{me.dealers[0]!.shop_name}</p>
        </div>
        <button className="btn primary" onClick={() => go("/add")}>
          <Icon name="plus" size={18} /> Add a dealer
        </button>
      </div>

      <div className="stats">
        <div className="stat">
          <span className="stat-n">{me.dealers.length}</span>
          <span className="muted">dealer{me.dealers.length === 1 ? "" : "s"}</span>
        </div>
        <button className="stat clickable" disabled={!unread} onClick={() => go(`/d/${me.dealers.find((d) => d.unread)?.id}/chat`)}>
          <span className="stat-n">{unread}</span>
          <span className="muted">unread message{unread === 1 ? "" : "s"}</span>
        </button>
        <button className="stat clickable" onClick={() => go("/orders")}>
          <span className="stat-n">{waiting}</span>
          <span className="muted">order{waiting === 1 ? "" : "s"} waiting for a dealer</span>
        </button>
      </div>

      <h2 className="section-title">Your dealers</h2>
      <ul className="dealer-cards">
        {me.dealers.map((d) => (
          <li key={d.id} className="dealer-card">
            <button className="dealer-card-head" onClick={() => go(`/d/${d.id}/chat`)}>
              <span className="avatar" aria-hidden="true">
                {initials(d.name)}
              </span>
              <span className="dealer-main">
                <span className="dealer-row">
                  <strong className="dealer-name">{d.name}</strong>
                  {d.unread > 0 && <span className="unread">{d.unread}</span>}
                </span>
                <span className="muted">As {d.shop_name}</span>
              </span>
            </button>
            <p className="preview card-preview">
              {d.last_message ? (
                <>
                  <span className="when">{shortWhen(d.last_message.at)}</span> {preview(d)}
                </>
              ) : (
                "No messages yet. Open the price list to place your first order."
              )}
            </p>
            {(d.waiting_orders > 0 || d.with_staff) && (
              <span className="dealer-tags">
                {d.waiting_orders > 0 && (
                  <span className="badge wait">
                    {d.waiting_orders} order{d.waiting_orders === 1 ? "" : "s"} waiting
                  </span>
                )}
                {d.with_staff && <span className="badge neutral">Staff are replying</span>}
              </span>
            )}
            <div className="card-actions">
              <button className="btn small" onClick={() => go(`/d/${d.id}/chat`)}>
                <Icon name="chat" size={16} /> Chat
              </button>
              <button className="btn small" onClick={() => go(`/d/${d.id}/prices`)}>
                <Icon name="list" size={16} /> Price list
              </button>
              <button className="btn small" onClick={() => go(`/d/${d.id}/orders`)}>
                <Icon name="orders" size={16} /> Orders
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="hint">Buy from another distributor too? Ask them for an access code for this phone number and add them here.</p>

      <div className="section-row">
        <h2 className="section-title">Recent orders</h2>
        <button className="link" onClick={() => go("/orders")}>
          All orders <Icon name="chevron" size={16} />
        </button>
      </div>
      <RecentOrders />
    </div>
  );
}

export function AddDealer() {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const add = useMutation({
    mutationFn: () => api<Me>("/dealers", { method: "POST", body: { code } }),
    onSuccess: (me) => {
      qc.setQueryData<Me>(["me"], me);
      go(`/d/${me.added}/prices`, true);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <div className="scroll page">
      <div className="page-head">
        <h1>Add a dealer</h1>
      </div>
      <form className="panel narrow" onSubmit={submit}>
        <p>Enter the access code your other distributor sent you. It must be for the same phone number you signed in with.</p>
        <div className="field">
          <label htmlFor="code">Access code</label>
          <input id="code" className="input code" inputMode="numeric" autoComplete="one-time-code" required maxLength={6} placeholder="6 digits" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
        </div>
        {add.error && (
          <p className="error-text" role="alert">
            {add.error instanceof ApiError
              ? add.error.status === 401
                ? "That code is not correct, or the dealer has not added this phone number. Ask them to check."
                : add.error.message
              : "Could not reach the server. Check your internet and try again."}
          </p>
        )}
        <button className="btn primary wide" disabled={add.isPending || code.length < 4}>
          {add.isPending ? "Adding…" : "Add dealer"}
        </button>
      </form>
    </div>
  );
}
