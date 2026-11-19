import { useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Retailer, type RetailerDraft, type UnknownSender } from "../api";
import { fmtFull, fmtPhone } from "../format";
import { useMe } from "../auth";
import { Icon } from "../icons";

type Filter = "active" | "inactive" | "all";
type Panel = { kind: "add"; phone?: string; contact?: string } | { kind: "edit"; retailer: Retailer } | null;

/**
 * The shops this distributor serves and the phone number each orders from. Only an active number
 * listed here gets the price list and the order assistant; any other number is told it is not connected.
 * Editing a retailer also gives them access to the customer app (an access code, shown once).
 */
export function RetailersPage() {
  const me = useMe();
  const canEdit = me.permissions.includes("contacts.authorise");
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["retailers"], queryFn: () => api<{ retailers: Retailer[] }>("/v1/retailers") });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["retailers"] });
    qc.invalidateQueries({ queryKey: ["unknown-senders"] });
  };

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
    mutationFn: (r: Retailer) => api<Retailer>(`/v1/retailers/${r.id}`, { method: "PATCH", body: { active: !r.active } }),
    onSuccess: (r) => setNotice(r.active ? `${r.shop_name} is connected again.` : `${r.shop_name} is disconnected. ${fmtPhone(r.phone)} will be told it is not connected.`),
    onSettled: refresh,
  });

  const retailers = list.data?.retailers ?? [];
  const counts = { active: retailers.filter((r) => r.active).length, inactive: retailers.filter((r) => !r.active).length, all: retailers.length };
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const digits = q.replace(/\D/g, "");
    return retailers.filter((r) => {
      if (filter === "active" && !r.active) return false;
      if (filter === "inactive" && r.active) return false;
      if (digits.length >= 4 && r.phone.replace(/\D/g, "").includes(digits)) return true;
      const hay = [r.shop_name, r.contact_name ?? "", r.area ?? "", r.phone].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [retailers, q, filter]);

  return (
    <div className="page" ref={top}>
      <div className="page-head">
        <div>
          <h1>Retailers</h1>
          <p className="sub">
            Only these numbers get your price list and can order. To let a shop order in the customer app, open it here and create an access code.
          </p>
        </div>
        <div className="head-actions">
          {canEdit && (
            <button className="btn primary" onClick={() => open({ kind: "add" })}>
              <Icon name="plus" size={16} /> Add retailer
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div className="banner info" role="status" style={{ marginBottom: 12 }}>
          {notice}
        </div>
      )}
      {toggle.error && <p className="error-text">{toggle.error instanceof ApiError ? toggle.error.message : "Could not save the change."}</p>}

      {panel?.kind === "add" && (
        <RetailerForm
          key={panel.phone ?? "new"}
          prefill={{ phone: panel.phone, contact: panel.contact }}
          onClose={() => setPanel(null)}
          onSaved={(r) => {
            setPanel(null);
            setNotice(`${r.shop_name} added. ${fmtPhone(r.phone)} can now order on WhatsApp.`);
            refresh();
          }}
        />
      )}
      {panel?.kind === "edit" && (
        <RetailerForm
          key={panel.retailer.id}
          retailer={panel.retailer}
          onChanged={refresh}
          onClose={() => setPanel(null)}
          onSaved={(r) => {
            setPanel(null);
            setNotice(`${r.shop_name} saved.`);
            refresh();
          }}
        />
      )}

      <UnknownSenders canEdit={canEdit} onAdd={(u) => open({ kind: "add", phone: u.phone, contact: u.profile_name ?? undefined })} onNotice={setNotice} />

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input className="input" type="search" placeholder="Search shop, person, area or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search retailers" />
        </div>
        <div className="seg" role="group" aria-label="Show">
          {(["active", "inactive", "all"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "active" ? "Connected" : f === "inactive" ? "Disconnected" : "All"} {counts[f]}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <table className="table stack">
          <thead>
            <tr>
              <th>Shop</th>
              <th>WhatsApp number</th>
              <th>Area</th>
              <th className="num">Orders</th>
              <th>{canEdit ? <span className="sr-only">Actions</span> : null}</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={5} className="cell-sub">
                  Loading…
                </td>
              </tr>
            )}
            {list.error && (
              <tr>
                <td colSpan={5} className="error-text">
                  Could not load retailers.
                </td>
              </tr>
            )}
            {list.data && !shown.length && (
              <tr>
                <td colSpan={5}>
                  <div className="empty">
                    {retailers.length
                      ? "No retailer matches."
                      : canEdit
                        ? "No retailers yet. Add each shop with the WhatsApp number it orders from."
                        : "No retailers yet. An owner or operator can add them."}
                  </div>
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className={`${r.active ? "" : "row-hidden"}${canEdit ? " clickable" : ""}`} onClick={canEdit ? () => open({ kind: "edit", retailer: r }) : undefined}>
                <td>
                  <div style={{ fontWeight: 600 }}>
                    {r.shop_name} {!r.active && <span className="badge neutral">Disconnected</span>} {r.app_access && <span className="badge bot">App</span>}
                  </div>
                  {r.contact_name && <div className="cell-sub">{r.contact_name}</div>}
                  {r.notes && <div className="cell-sub">{r.notes}</div>}
                </td>
                <td>
                  <span className="stack-label">WhatsApp </span>
                  {fmtPhone(r.phone)}
                </td>
                <td>
                  <span className="stack-label">Area </span>
                  {r.area ?? <span className="cell-sub">-</span>}
                </td>
                <td className="num">
                  <span className="stack-label">Orders </span>
                  {r.orders}
                  {r.last_order_at && <div className="cell-sub">last {fmtFull(r.last_order_at)}</div>}
                </td>
                <td>
                  {canEdit && (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn small" onClick={() => open({ kind: "edit", retailer: r })}>
                        Edit
                      </button>
                      <button className={`btn small${r.active ? " danger" : ""}`} disabled={toggle.isPending} onClick={() => toggle.mutate(r)}>
                        {r.active ? "Disconnect" : "Connect"}
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

/** Customer app access for one retailer: create a code (shown once, with a message to pass on) or remove access. */
function AppAccess({ retailer, onChanged }: { retailer: Retailer; onChanged?: () => void }) {
  const me = useMe();
  const [access, setAccess] = useState({ on: retailer.app_access, at: retailer.app_code_set_at });
  const [issued, setIssued] = useState<{ code: string; app_url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api<{ code: string; app_url: string; retailer: Retailer }>(`/v1/retailers/${retailer.id}/app-code`, { method: "POST", body: {} }),
    onSuccess: (r) => {
      setIssued({ code: r.code, app_url: r.app_url });
      setAccess({ on: true, at: r.retailer.app_code_set_at });
      setCopied(false);
      onChanged?.();
    },
  });
  const remove = useMutation({
    mutationFn: () => api<Retailer>(`/v1/retailers/${retailer.id}/app-code`, { method: "DELETE" }),
    onSuccess: () => {
      setIssued(null);
      setAccess({ on: false, at: null });
      onChanged?.();
    },
  });
  const message = issued
    ? `Order from ${me.tenant?.name ?? "us"} in our app:\n${issued.app_url}\nPhone number: ${fmtPhone(retailer.phone)}\nAccess code: ${issued.code}`
    : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const err = create.error ?? remove.error;
  return (
    <div className="app-access">
      <div className="app-access-head">
        <div>
          <strong>Customer app</strong>
          <div className="hint">
            {access.on
              ? `Can sign in with ${fmtPhone(retailer.phone)} and the access code${access.at ? ` created ${fmtFull(access.at)}` : ""}.`
              : "No access yet. Create a code so this shop can chat and order in the app."}
            {!retailer.active && " This shop is disconnected, so it cannot sign in until you connect it again."}
          </div>
        </div>
        <div className="row-actions">
          <button type="button" className="btn small" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : access.on ? "Create new code" : "Create access code"}
          </button>
          {access.on && (
            <button type="button" className="btn small danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Remove access
            </button>
          )}
        </div>
      </div>
      {issued && (
        <div className="banner info app-access-code" role="status">
          <div>
            Access code <strong className="code">{issued.code}</strong>. It is shown only now: send it to the shop. A new code signs out phones that used the old one.
          </div>
          <textarea className="textarea" readOnly rows={4} value={message} aria-label="Message to send to the shop" onFocus={(e) => e.currentTarget.select()} />
          <div>
            <button type="button" className="btn small" onClick={copy}>
              {copied ? "Copied" : "Copy message"}
            </button>
          </div>
        </div>
      )}
      {err && <p className="error-text">{err instanceof ApiError ? err.message : "Could not change app access."}</p>}
    </div>
  );
}

function RetailerForm({
  retailer,
  prefill,
  onClose,
  onSaved,
  onChanged,
}: {
  retailer?: Retailer;
  prefill?: { phone?: string; contact?: string };
  onClose: () => void;
  onSaved: (r: Retailer) => void;
  onChanged?: () => void;
}) {
  const [shop, setShop] = useState(retailer?.shop_name ?? "");
  const [contact, setContact] = useState(retailer?.contact_name ?? prefill?.contact ?? "");
  const [phone, setPhone] = useState(retailer?.phone ?? prefill?.phone ?? "");
  const [area, setArea] = useState(retailer?.area ?? "");
  const [notes, setNotes] = useState(retailer?.notes ?? "");

  const save = useMutation({
    mutationFn: () => {
      const body: RetailerDraft = { shop_name: shop, contact_name: contact, phone, area, notes };
      return retailer
        ? api<Retailer>(`/v1/retailers/${retailer.id}`, { method: "PATCH", body })
        : api<Retailer>("/v1/retailers", { method: "POST", body: { ...body, active: true } });
    },
    onSuccess: onSaved,
  });

  const fieldErr = (f: string) => {
    const e = save.error;
    if (!(e instanceof ApiError)) return null;
    if (e.code === "PHONE_EXISTS" && f === "phone") return e.message;
    const hit = (e.details.fields as Array<{ path: string; message: string }> | undefined)?.find((x) => x.path.split(".")[0] === f);
    return hit ? hit.message : null;
  };
  const anyFieldErr = ["shop_name", "contact_name", "phone", "area", "notes"].some((f) => fieldErr(f));
  const Err = ({ f }: { f: string }) => {
    const m = fieldErr(f);
    return m ? <span className="error-text">{m}</span> : null;
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form className="card card-pad panel" onSubmit={submit} aria-label={retailer ? `Edit ${retailer.shop_name}` : "Add retailer"}>
      <div className="panel-head">
        <h2>{retailer ? `Edit ${retailer.shop_name}` : "Add retailer"}</h2>
        <button type="button" className="btn small" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="r-shop">Shop name</label>
          <input id="r-shop" className="input" required value={shop} onChange={(e) => setShop(e.target.value)} placeholder="Murugan Stores" />
          <span className="hint">Printed on the retailer's order copy.</span>
          <Err f="shop_name" />
        </div>
        <div className="field">
          <label htmlFor="r-phone">Phone number</label>
          <input id="r-phone" className="input" required inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" />
          <span className="hint">The number they order from (WhatsApp and app sign-in). 10-digit Indian mobile, or with country code (+1…).</span>
          <Err f="phone" />
        </div>
        <div className="field">
          <label htmlFor="r-contact">Contact person (optional)</label>
          <input id="r-contact" className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Murugan anna" />
          <span className="hint">The assistant greets them by this name.</span>
          <Err f="contact_name" />
        </div>
        <div className="field">
          <label htmlFor="r-area">Area / route (optional)</label>
          <input id="r-area" className="input" value={area} onChange={(e) => setArea(e.target.value)} placeholder="T Nagar" />
          <Err f="area" />
        </div>
        <div className="field span-2">
          <label htmlFor="r-notes">Notes (optional, staff only)</label>
          <input id="r-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Credit 7 days, delivery Tuesday" />
          <Err f="notes" />
        </div>
      </div>
      {retailer && <AppAccess retailer={retailer} onChanged={onChanged} />}
      {save.error && !anyFieldErr && <p className="error-text">{save.error instanceof ApiError ? save.error.message : "Could not save the retailer."}</p>}
      <div className="panel-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={save.isPending}>
          {save.isPending ? "Saving…" : retailer ? "Save" : "Add retailer"}
        </button>
      </div>
    </form>
  );
}

/** Numbers that messaged but are not connected: they only got "not connected", so staff may want to add them. */
function UnknownSenders({ canEdit, onAdd, onNotice }: { canEdit: boolean; onAdd: (u: UnknownSender) => void; onNotice: (m: string) => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["unknown-senders"], queryFn: () => api<{ senders: UnknownSender[] }>("/v1/retailers/unknown-senders"), refetchInterval: 30_000 });
  const dismiss = useMutation({
    mutationFn: (u: UnknownSender) => api(`/v1/retailers/unknown-senders/${encodeURIComponent(u.phone)}`, { method: "DELETE" }),
    onSuccess: (_r, u) => onNotice(`${fmtPhone(u.phone)} removed from the list.`),
    onSettled: () => qc.invalidateQueries({ queryKey: ["unknown-senders"] }),
  });
  const senders = list.data?.senders ?? [];
  if (!senders.length) return null;
  return (
    <section className="card" style={{ marginBottom: 16 }} aria-label="Numbers that tried to order">
      <div className="card-pad" style={{ paddingBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Tried to order ({senders.length})</h2>
        <p className="cell-sub" style={{ margin: "4px 0 0" }}>These numbers messaged but are not connected, so they only got "this number is not connected".</p>
      </div>
      <div className="unknown-list">
        {senders.map((u) => (
          <div className="unknown-row" key={u.phone}>
            <div className="who">
              <div style={{ fontWeight: 600 }}>
                {fmtPhone(u.phone)}
                {u.profile_name ? <span className="cell-sub"> · {u.profile_name}</span> : null}
              </div>
              {u.last_text && <div className="said">"{u.last_text}"</div>}
              <div className="cell-sub">
                {u.reason === "retailer_inactive" ? `Disconnected retailer ${u.shop_name ?? ""} · ` : ""}
                {u.attempts} message{u.attempts === 1 ? "" : "s"} · last {fmtFull(u.last_at)}
              </div>
            </div>
            {canEdit && (
              <div className="row-actions">
                {u.reason === "not_a_retailer" ? (
                  <button className="btn small primary" onClick={() => onAdd(u)}>
                    Add as retailer
                  </button>
                ) : (
                  <span className="cell-sub">Connect it from the Disconnected list below</span>
                )}
                <button className="btn small" disabled={dismiss.isPending} onClick={() => dismiss.mutate(u)}>
                  Dismiss
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
