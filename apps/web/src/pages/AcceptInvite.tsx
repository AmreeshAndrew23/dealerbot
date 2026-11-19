import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, type Me, type Role } from "../api";

const ROLE_TEXT: Record<Role, string> = {
  OWNER: "Owner: full access including users and settings",
  OPERATOR: "Operator: review orders, approve, and reply to retailers",
  VIEWER: "Viewer: read-only access",
};

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const info = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<{ email: string; role: Role; tenant_name: string; existing_user: boolean }>(`/v1/auth/invitations/${encodeURIComponent(token)}`),
    enabled: token.length > 0,
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => api<Me>("/v1/auth/accept-invite", { method: "POST", body: { token, password, display_name: name || undefined } }),
    onSuccess: (me) => {
      qc.setQueryData(["me"], me);
      nav("/conversations", { replace: true });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    accept.mutate();
  };

  if (!token || info.error) {
    return (
      <div className="auth">
        <div className="card">
          <h1>Invitation not valid</h1>
          <p className="sub">This link has expired or was already used. Ask the owner to send a new invitation.</p>
        </div>
      </div>
    );
  }
  if (!info.data) return <div className="empty">Loading…</div>;
  const inv = info.data;
  return (
    <div className="auth">
      <form className="card" onSubmit={submit}>
        <h1>Join {inv.tenant_name}</h1>
        <p className="sub">
          {inv.email}
          <br />
          {ROLE_TEXT[inv.role]}
        </p>
        {!inv.existing_user && (
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input id="name" className="input" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </div>
        )}
        <div className="field">
          <label htmlFor="pw">{inv.existing_user ? "Your existing password" : "Choose a password"}</label>
          <input
            id="pw"
            className="input"
            type="password"
            required
            minLength={inv.existing_user ? 1 : 10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={inv.existing_user ? "current-password" : "new-password"}
          />
          {!inv.existing_user && <span className="hint">At least 10 characters.</span>}
        </div>
        {accept.error && (
          <p className="error-text" role="alert">
            {accept.error instanceof ApiError ? accept.error.message : "Could not reach the server."}
          </p>
        )}
        <button className="btn primary" style={{ width: "100%" }} disabled={accept.isPending}>
          {accept.isPending ? "Joining…" : "Join"}
        </button>
      </form>
    </div>
  );
}
