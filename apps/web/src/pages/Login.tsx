import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, type Me } from "../api";
import { Icon } from "../icons";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const login = useMutation({
    mutationFn: () => api<Me>("/v1/auth/login", { method: "POST", body: { email, password } }),
    onSuccess: (me) => {
      qc.setQueryData(["me"], me);
      const next = params.get("next");
      nav(next && next.startsWith("/") && !next.startsWith("//") ? next : "/conversations", { replace: true });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <div className="auth">
      <form className="card" onSubmit={submit}>
        <span className="brand-mark" style={{ width: 36, height: 36, borderRadius: 9, display: "grid", placeItems: "center" }}>
          <Icon name="logo" />
        </span>
        <h1>Sign in</h1>
        <p className="sub">Order Assistant for distributor staff</p>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {login.error && (
          <p className="error-text" role="alert">
            {login.error instanceof ApiError ? login.error.message : "Could not reach the server."}
          </p>
        )}
        <button className="btn primary" style={{ width: "100%" }} disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
        <p className="hint" style={{ marginTop: 14 }}>
          New staff join through an invitation link from the owner.
        </p>
      </form>
    </div>
  );
}
