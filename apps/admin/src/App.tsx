// Platform admin app (served at /admin/). The people who run this service add dealers
// (distributors), send each new dealer's owner a one-time invite link, and rename, suspend or
// reactivate dealers. The owner sets their own password from the link; the admin never sees it.
// Screens by URL hash:  #/  dealers   #/new  add a dealer   #/d/:id  one dealer
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, dashboardOrigin, errorText, type Admin, type DealerDetail, type DealerRow, type Invite } from "./api";

// ---------- small helpers ----------
function useHash(): string[] {
  const read = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return parts;
}
const go = (path: string) => (location.hash = "#" + path);
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const dateTime = (s: string | null) =>
  s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "Never";
const ROLE = { OWNER: "Owner", OPERATOR: "Operator", VIEWER: "Viewer" } as const;

function StatusBadge({ status }: { status: DealerRow["status"] }) {
  return <span className={`badge ${status === "active" ? "ok" : "bad"}`}>{status === "active" ? "Active" : "Suspended"}</span>;
}

// ---------- app ----------
export function App() {
  const qc = useQueryClient();
  // Checked once on load (and after sign-in/out), never on a timer: a re-check must not wipe the sign-in form.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ admin: Admin }>("/me"), retry: false, refetchOnWindowFocus: false, staleTime: Infinity });
  const signedOut = me.error instanceof ApiError && me.error.status === 401;
  if (me.isPending && me.errorUpdateCount === 0) return <div className="splash">Loading…</div>;
  if (!me.data || signedOut) {
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
    return <Login onDone={(d) => qc.setQueryData<{ admin: Admin }>(["me"], d)} />;
  }
  return <Shell admin={me.data.admin} />;
}

function Login({ onDone }: { onDone: (d: { admin: Admin }) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({ mutationFn: () => api<{ admin: Admin }>("/login", { method: "POST", body: { email, password } }), onSuccess: onDone });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Dealer admin</h1>
        <p className="muted">For the people who run this service. Dealer staff sign in on the staff dashboard instead.</p>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {login.error && (
          <p className="error-text" role="alert">
            {errorText(login.error)}
          </p>
        )}
        <button className="btn primary wide" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Shell({ admin }: { admin: Admin }) {
  const qc = useQueryClient();
  const [section, id] = useHash();
  const logout = useMutation({
    mutationFn: () => api("/logout", { method: "POST" }),
    onSettled: () => {
      go("/");
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      void qc.resetQueries({ queryKey: ["me"] });
    },
  });
  const list = useQuery({ queryKey: ["dealers"], queryFn: () => api<{ dealers: DealerRow[] }>("/dealers") });
  // Signed out elsewhere (session expired): back to sign-in.
  useEffect(() => {
    if (list.error instanceof ApiError && list.error.status === 401) void qc.invalidateQueries({ queryKey: ["me"] });
  }, [list.error, qc]);

  return (
    <div className="web">
      <header className="topbar">
        <button className="brand" onClick={() => go("/")}>
          Dealer admin
        </button>
        <span className="grow" />
        <span className="who">{admin.display_name}</span>
        <button className="btn ghost-light small" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Sign out
        </button>
      </header>
      <div className="split">
        <section className="list-pane">
          <DealerList rows={list.data?.dealers} loading={list.isPending} error={list.error} current={section === "d" ? id : undefined} />
        </section>
        <section className={`detail-pane ${section === "new" || section === "d" ? "open" : ""}`}>
          {section === "new" ? <AddDealer /> : section === "d" && id ? <DealerPanel key={id} id={id} /> : <Empty />}
        </section>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <h2>Pick a dealer</h2>
      <p className="muted">Choose a dealer on the left to rename, suspend or reactivate it, or to send its owner a new invite link.</p>
      <button className="btn primary" onClick={() => go("/new")}>
        Add a dealer
      </button>
    </div>
  );
}

// ---------- dealer list ----------
function DealerList({ rows, loading, error, current }: { rows?: DealerRow[]; loading: boolean; error: unknown; current?: string }) {
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"all" | "active" | "suspended">("all");
  const shown = useMemo(
    () => (rows ?? []).filter((r) => (show === "all" || r.status === show) && (r.name + " " + r.owners.join(" ")).toLowerCase().includes(q.trim().toLowerCase())),
    [rows, q, show],
  );
  const suspended = (rows ?? []).filter((r) => r.status === "suspended").length;
  return (
    <>
      <div className="pane-head">
        <div>
          <h1>Dealers</h1>
          <p className="muted">
            {rows ? `${rows.length} dealer${rows.length === 1 ? "" : "s"}${suspended ? ` · ${suspended} suspended` : ""}` : " "}
          </p>
        </div>
        <button className="btn primary" onClick={() => go("/new")}>
          + Add dealer
        </button>
      </div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Search name or owner email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search dealers" />
        <select className="input" value={show} onChange={(e) => setShow(e.target.value as typeof show)} aria-label="Show">
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>
      {loading && <p className="note">Loading…</p>}
      {!!error && !(error instanceof ApiError && error.status === 401) && <p className="error-text">{errorText(error)}</p>}
      {rows && !shown.length && <p className="note">{rows.length ? "No dealer matches." : "No dealers yet. Add the first one."}</p>}
      {!!shown.length && (
        <table className="table">
          <thead>
            <tr>
              <th>Dealer</th>
              <th>Owner</th>
              <th className="num">Staff</th>
              <th className="num">Shops</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.id}
                className={`clickable ${r.id === current ? "on" : ""}`}
                tabIndex={0}
                onClick={() => go(`/d/${r.id}`)}
                onKeyDown={(e) => e.key === "Enter" && go(`/d/${r.id}`)}
              >
                <td>
                  <strong>{r.name}</strong>
                  <div className="muted small">Added {date(r.created_at)}</div>
                </td>
                <td>
                  {r.owners.length ? r.owners.join(", ") : r.pending_owner ? <span className="warn-text">Invited: {r.pending_owner}</span> : <span className="bad-text">No owner</span>}
                </td>
                <td className="num">{r.staff}</td>
                <td className="num">{r.retailers}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---------- add a dealer ----------
function AddDealer() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const add = useMutation({
    mutationFn: () => api<{ dealer: { id: string; name: string }; invite: Invite }>("/dealers", { method: "POST", body: { name, owner_email: email } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dealers"] }),
  });
  if (add.data) {
    return (
      <div className="panel-body">
        <PaneTitle title={`${add.data.dealer.name} added`} />
        <InviteLink invite={add.data.invite} dealerName={add.data.dealer.name} />
        <div className="actions">
          <button className="btn primary" onClick={() => go(`/d/${add.data.dealer.id}`)}>
            Open dealer
          </button>
          <button
            className="btn"
            onClick={() => {
              add.reset();
              setName("");
              setEmail("");
            }}
          >
            Add another
          </button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="panel-body"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <PaneTitle title="Add a dealer" />
      <p className="muted">
        You'll get a one-time link for the dealer's owner. They open it, choose their own password, and can then add their staff, products and shops.
      </p>
      <div className="field">
        <label htmlFor="dn">Dealer name</label>
        <input id="dn" className="input" required minLength={2} maxLength={100} placeholder="e.g. Sri Murugan Agencies" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="de">Owner's email</label>
        <input id="de" className="input" type="email" required placeholder="owner@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <span className="hint">They sign in to the staff dashboard with this email.</span>
      </div>
      {add.error && (
        <p className="error-text" role="alert">
          {errorText(add.error)}
        </p>
      )}
      <div className="actions">
        <button className="btn primary" disabled={add.isPending}>
          {add.isPending ? "Adding…" : "Add dealer"}
        </button>
        <button type="button" className="btn" onClick={() => go("/")}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function PaneTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pane-title">
      <button className="btn ghost back" aria-label="Back to dealers" onClick={() => go("/")}>
        ←
      </button>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** The one-time link, shown once: only its hash is stored, so it cannot be shown again later. */
function InviteLink({ invite, dealerName }: { invite: Invite; dealerName: string }) {
  const link = dashboardOrigin + invite.accept_path;
  const [copied, setCopied] = useState(false);
  const message = `You're invited to run ${dealerName} on the order assistant. Open this link to set your password (works once, until ${date(invite.expires_at)}):\n${link}`;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the link is selectable below */
    }
  };
  return (
    <div className="invite-box">
      <p>
        Send this link to <strong>{invite.email}</strong>. It works once and expires on <strong>{date(invite.expires_at)}</strong>.
      </p>
      <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
      <div className="actions">
        <button className="btn primary" type="button" onClick={() => copy(link)}>
          {copied ? "Copied" : "Copy link"}
        </button>
        <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
          Send on WhatsApp
        </a>
      </div>
      <p className="warn-text small">Copy it now: for safety it can't be shown again. If it's lost, make a new link below.</p>
    </div>
  );
}

// ---------- one dealer ----------
function DealerPanel({ id }: { id: string }) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ["dealer", id], queryFn: () => api<DealerDetail>(`/dealers/${id}`) });
  const refresh = (next?: DealerDetail) => {
    if (next) qc.setQueryData(["dealer", id], next);
    else void qc.invalidateQueries({ queryKey: ["dealer", id] });
    void qc.invalidateQueries({ queryKey: ["dealers"] });
  };
  if (d.isPending) return <p className="note">Loading…</p>;
  if (d.error) return <p className="error-text">{errorText(d.error)}</p>;
  const x = d.data;
  return (
    <div className="panel-body">
      <PaneTitle title={x.name}>
        <StatusBadge status={x.status} />
      </PaneTitle>
      <div className="stats">
        <div className="stat">
          <span>Shops</span>
          <strong>{x.retailers}</strong>
        </div>
        <div className="stat">
          <span>Products</span>
          <strong>{x.products}</strong>
        </div>
        <div className="stat">
          <span>Orders</span>
          <strong>{x.orders}</strong>
        </div>
        <div className="stat">
          <span>Added</span>
          <strong className="small-strong">{date(x.created_at)}</strong>
        </div>
      </div>
      <Rename dealer={x} onDone={refresh} />
      <Suspend dealer={x} onDone={refresh} />
      <Staff dealer={x} onChange={() => refresh()} />
    </div>
  );
}

function Rename({ dealer, onDone }: { dealer: DealerDetail; onDone: (d: DealerDetail) => void }) {
  const [name, setName] = useState(dealer.name);
  useEffect(() => setName(dealer.name), [dealer.name]);
  const save = useMutation({ mutationFn: () => api<DealerDetail>(`/dealers/${dealer.id}`, { method: "PATCH", body: { name } }), onSuccess: onDone });
  return (
    <section className="block">
      <h3>Name</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <input className="input" required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} aria-label="Dealer name" />
        <button className="btn" disabled={save.isPending || name.trim() === dealer.name || name.trim().length < 2}>
          {save.isPending ? "Saving…" : "Rename"}
        </button>
      </form>
      {save.error && <p className="error-text">{errorText(save.error)}</p>}
    </section>
  );
}

function Suspend({ dealer, onDone }: { dealer: DealerDetail; onDone: (d: DealerDetail) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const change = useMutation({
    mutationFn: (status: "active" | "suspended") => api<DealerDetail>(`/dealers/${dealer.id}`, { method: "PATCH", body: { status, reason: reason || undefined } }),
    onSuccess: (d) => {
      setConfirming(false);
      setReason("");
      onDone(d);
    },
  });
  if (dealer.status === "suspended") {
    return (
      <section className="block suspended">
        <h3>Suspended</h3>
        <p>
          Since {dateTime(dealer.suspended_at)}
          {dealer.suspended_reason ? ` · ${dealer.suspended_reason}` : ""}. Staff can't sign in and shops can't use the order app. Nothing has been deleted.
        </p>
        <button className="btn primary" disabled={change.isPending} onClick={() => change.mutate("active")}>
          {change.isPending ? "Reactivating…" : "Reactivate dealer"}
        </button>
        {change.error && <p className="error-text">{errorText(change.error)}</p>}
      </section>
    );
  }
  return (
    <section className="block">
      <h3>Suspend</h3>
      {!confirming ? (
        <>
          <p className="muted">Stops the dealer's staff signing in and its shops ordering. Nothing is deleted; you can reactivate any time.</p>
          <button className="btn danger" onClick={() => setConfirming(true)}>
            Suspend dealer…
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate("suspended");
          }}
        >
          <div className="field">
            <label htmlFor="reason">Reason (only admins see it)</label>
            <input id="reason" className="input" maxLength={300} placeholder="e.g. payment overdue" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <p className="warn-text">
            {dealer.name}'s staff will be signed out now and {dealer.retailers} shop{dealer.retailers === 1 ? "" : "s"} will lose access until you reactivate.
          </p>
          <div className="actions">
            <button className="btn danger-solid" disabled={change.isPending}>
              {change.isPending ? "Suspending…" : `Suspend ${dealer.name}`}
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
          {change.error && <p className="error-text">{errorText(change.error)}</p>}
        </form>
      )}
    </section>
  );
}

function Staff({ dealer, onChange }: { dealer: DealerDetail; onChange: () => void }) {
  const [email, setEmail] = useState("");
  const invite = useMutation({
    mutationFn: () => api<Invite>(`/dealers/${dealer.id}/invitations`, { method: "POST", body: { email } }),
    onSuccess: () => {
      setEmail("");
      onChange();
    },
  });
  const revoke = useMutation({ mutationFn: (inv: string) => api(`/dealers/${dealer.id}/invitations/${inv}`, { method: "DELETE" }), onSuccess: onChange });
  const owners = dealer.staff.filter((s) => s.active && s.role === "OWNER");
  return (
    <section className="block">
      <h3>Staff</h3>
      {!owners.length && <p className="bad-text">No owner has signed in yet{dealer.invitations.length ? " — the invite below is waiting." : ". Send an owner invite below."}</p>}
      {!!dealer.staff.length && (
        <table className="table compact">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {dealer.staff.map((s) => (
              <tr key={s.id} className={s.active ? "" : "off"}>
                <td>
                  {s.display_name}
                  <div className="muted small">{s.email}</div>
                </td>
                <td>{s.active ? ROLE[s.role] : "Removed"}</td>
                <td>{dateTime(s.last_seen_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">The owner adds and removes other staff from the staff dashboard.</p>

      {!!dealer.invitations.length && (
        <>
          <h4>Waiting invites</h4>
          <ul className="invites">
            {dealer.invitations.map((i) => (
              <li key={i.id}>
                <span>
                  {i.email} · {ROLE[i.role]} · expires {date(i.expires_at)}
                </span>
                <button className="btn small danger" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {invite.data ? (
        <>
          <h4>New owner invite</h4>
          <InviteLink invite={invite.data} dealerName={dealer.name} />
          <button className="btn small" onClick={() => invite.reset()}>
            Done
          </button>
        </>
      ) : (
        <form
          className="invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <h4>Invite an owner</h4>
          <p className="muted small">For a lost or expired link, or a second owner. A new link replaces any unused one for that email.</p>
          <div className="row">
            <input className="input" type="email" required placeholder="owner@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Owner email" />
            <button className="btn" disabled={invite.isPending}>
              {invite.isPending ? "Making link…" : "Make invite link"}
            </button>
          </div>
          {invite.error && <p className="error-text">{errorText(invite.error)}</p>}
        </form>
      )}
      {revoke.error && <p className="error-text">{errorText(revoke.error)}</p>}
    </section>
  );
}
