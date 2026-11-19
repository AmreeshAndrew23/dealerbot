// The shop's account: its phone number, the dealers on this phone (each with the shop's details as
// that dealer has them), adding or removing a dealer, and signing out.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Me } from "../api";
import { Icon, go, initials } from "../ui";

const fmtPhone = (p: string) => (p.startsWith("+91") && p.length === 13 ? `+91 ${p.slice(3, 8)} ${p.slice(8)}` : p);

export function Account({ me }: { me: Me }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api<Me>(`/dealers/${id}`, { method: "DELETE" }),
    onSuccess: (next) => {
      if (next.signed_out || !next.dealers.length) {
        qc.clear();
        void qc.invalidateQueries({ queryKey: ["me"] });
      } else qc.setQueryData<Me>(["me"], next);
    },
  });
  const logout = useMutation({
    mutationFn: () => api("/logout", { method: "POST", body: {} }),
    onSettled: () => {
      qc.clear();
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
  return (
    <div className="scroll page">
      <div className="page-head">
        <h1>Account</h1>
      </div>
      <div className="account-grid">
        <section className="panel">
          <h2 className="panel-title">This phone</h2>
          <p className="big">{fmtPhone(me.phone)}</p>
          <p className="hint">Your shop's name, address and number are kept by each dealer. To change them, ask that dealer.</p>
        </section>

        <section className="panel">
          <h2 className="panel-title">Dealers on this phone</h2>
          <ul className="account-dealers">
            {me.dealers.map((d) => (
              <li key={d.id}>
                <span className="avatar small" aria-hidden="true">
                  {initials(d.name)}
                </span>
                <span className="dealer-main">
                  <strong>{d.name}</strong>
                  <span className="muted">
                    As {d.shop_name}
                    {d.contact_name ? ` (${d.contact_name})` : ""}
                  </span>
                </span>
                <button
                  className="btn small"
                  disabled={remove.isPending}
                  onClick={() => {
                    const last = me.dealers.length === 1;
                    const msg = last
                      ? `Remove ${d.name}? It is your only dealer here, so this phone will be signed out. Your orders stay with the dealer.`
                      : `Remove ${d.name} from this phone? Your orders stay with the dealer. To add them again you need a new access code from them.`;
                    if (window.confirm(msg)) remove.mutate(d.id);
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <button className="btn wide" onClick={() => go("/add")}>
            <Icon name="plus" /> Add a dealer
          </button>
        </section>
      </div>

      <div className="account-grid">
        <section className="panel">
          <h2 className="panel-title">Help</h2>
          <ul className="help">
            <li>Order by typing in the chat (English, Tamil or Tanglish) or from the price list.</li>
            <li>An order is placed only when you reply YES to the order summary.</li>
            <li>Until the dealer accepts it, you can add, change or remove items in the chat.</li>
            <li>Type STAFF in a chat to talk to a person at that dealer.</li>
          </ul>
        </section>
        <section className="panel">
          <h2 className="panel-title">Sign out</h2>
          <p className="hint">Signs this browser out of every dealer. Use it on a shared computer.</p>
          <button
            className="btn wide danger"
            disabled={logout.isPending}
            onClick={() => {
              if (window.confirm("Sign out of this phone? You will need an access code to sign in again.")) logout.mutate();
            }}
          >
            <Icon name="logout" /> Sign out
          </button>
        </section>
      </div>
    </div>
  );
}
