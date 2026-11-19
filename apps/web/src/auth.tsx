import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";
import { api, ApiError, type Me } from "./api";

const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside RequireAuth");
  return me;
}

export function useCan(permission: string): boolean {
  return useMe().permissions.includes(permission);
}

export function meQuery() {
  return { queryKey: ["me"], queryFn: () => api<Me>("/v1/auth/me"), staleTime: 60_000 };
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const q = useQuery(meQuery());
  if (q.isPending) return <div className="empty">Loading…</div>;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 401) {
      return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    }
    return <div className="empty">Could not reach the server. {q.error.message}</div>;
  }
  return <MeContext.Provider value={q.data}>{children}</MeContext.Provider>;
}
