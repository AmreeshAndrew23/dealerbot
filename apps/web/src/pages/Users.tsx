import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Invitation, type Member, type Role } from "../api";
import { useMe } from "../auth";
import { fmtFull, fmtRelativeDay } from "../format";

const ROLES: Array<{ value: Role; label: string; help: string }> = [
  { value: "OWNER", label: "Owner", help: "Everything, including users and settings" },
  { value: "OPERATOR", label: "Operator", help: "Review, approve and reply" },
  { value: "VIEWER", label: "Viewer", help: "Read only" },
];

export function UsersPage() {
  const me = useMe();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ["users"], queryFn: () => api<{ users: Member[]; invitations: Invitation[] }>("/v1/users") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });

  const update = useMutation({
    mutationFn: (v: { id: string; role?: Role; active?: boolean }) => api(`/v1/users/${v.id}`, { method: "PATCH", body: { role: v.role, active: v.active } }),
    onSettled: refresh,
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/v1/users/invitations/${id}`, { method: "DELETE" }), onSettled: refresh });

  return (
    <div className="page">
      <h1>Users</h1>
      <p className="sub">People who can use the dashboard for {me.tenant?.name}.</p>

      <InviteForm onInvited={refresh} />

      {update.error && (
        <p className="error-text" role="alert">
          {update.error instanceof ApiError ? update.error.message : "Could not save the change."}
        </p>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <table className="table stack">
          <colgroup>
            <col style={{ width: "38%" }} />
            <col style={{ width: "20%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "24%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Last active</th>
              <th style={{ textAlign: "right" }}>Access</th>
            </tr>
          </thead>
          <tbody>
            {data.isPending && (
              <tr>
                <td colSpan={4}>Loading…</td>
              </tr>
            )}
            {data.data?.users.map((u) => {
              const self = u.id === me.user.id;
              return (
                <tr key={u.id} style={u.active ? undefined : { opacity: 0.6 }}>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {u.display_name}
                      {self ? " (you)" : ""}
                    </div>
                    <div className="cell-sub">{u.email}</div>
                  </td>
                  <td>
                    <label style={{ position: "absolute", left: -9999 }} htmlFor={`role-${u.id}`}>
                      Role for {u.display_name}
                    </label>
                    <select
                      id={`role-${u.id}`}
                      className="select"
                      value={u.role}
                      disabled={!u.active || update.isPending}
                      onChange={(e) => update.mutate({ id: u.id, role: e.target.value as Role })}
                    >
                      {ROLES.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="cell-sub">{u.last_seen_at ? <span title={fmtFull(u.last_seen_at)}>{fmtRelativeDay(u.last_seen_at)}</span> : "Never"}</td>
                  <td>
                    <div className="row-actions">
                      {u.active ? <span className="badge ok">Active</span> : <span className="badge neutral">Removed</span>}
                      {!self &&
                        (u.active ? (
                          <button className="btn small danger" disabled={update.isPending} onClick={() => update.mutate({ id: u.id, active: false })}>
                            Remove
                          </button>
                        ) : (
                          <button className="btn small" disabled={update.isPending} onClick={() => update.mutate({ id: u.id, active: true })}>
                            Restore
                          </button>
                        ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.data && data.data.invitations.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, margin: "24px 0 8px" }}>Pending invitations</h2>
          <div className="card">
            <table className="table stack">
              <tbody>
                {data.data.invitations.map((i) => (
                  <tr key={i.id}>
                    <td style={{ width: "50%" }}>{i.email}</td>
                    <td>{ROLES.find((r) => r.value === i.role)?.label}</td>
                    <td className="cell-sub">Expires {fmtFull(i.expires_at)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn small danger" onClick={() => revoke.mutate(i.id)}>
                          Revoke
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function InviteForm({ onInvited }: { onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("OPERATOR");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const invite = useMutation({
    mutationFn: () => api<{ accept_path: string }>("/v1/users/invitations", { method: "POST", body: { email, role } }),
    onSuccess: (r) => {
      setLink(window.location.origin + r.accept_path);
      setEmail("");
      setCopied(false);
      onInvited();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };
  return (
    <form className="card card-pad" onSubmit={submit}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ flex: "2 1 220px", margin: 0 }}>
          <label htmlFor="inv-email">Invite by email</label>
          <input id="inv-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@distributor.in" />
        </div>
        <div className="field" style={{ flex: "1 1 160px", margin: 0 }}>
          <label htmlFor="inv-role">Role</label>
          <select id="inv-role" className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}: {r.help}
              </option>
            ))}
          </select>
        </div>
        <button className="btn primary" disabled={invite.isPending}>
          Create invitation
        </button>
      </div>
      {invite.error && <p className="error-text">{invite.error instanceof ApiError ? invite.error.message : "Could not create the invitation."}</p>}
      {link && (
        <>
          <div className="copybox">
            <input className="input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" />
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(link).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <p className="hint">Send this link to the person (for example on WhatsApp). It works once and expires in 7 days. It is not shown again.</p>
        </>
      )}
    </form>
  );
}
