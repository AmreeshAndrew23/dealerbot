// Fetch wrapper for the /v1/admin API. Errors follow the PRD envelope.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/v1/admin${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    const field = e.details?.fields?.[0]?.message as string | undefined;
    throw new ApiError(res.status, e.code ?? "HTTP_" + res.status, field ?? e.message ?? "Request failed.");
  }
  return json as T;
}

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : "Could not reach the server. Check your internet and try again.");

/** The staff dashboard's address: same site when hosted; its own dev server locally. */
export const dashboardOrigin = import.meta.env.DEV ? "http://localhost:5180" : location.origin;

export type Role = "OWNER" | "OPERATOR" | "VIEWER";
export type DealerStatus = "active" | "suspended";

export interface Admin {
  id: string;
  email: string;
  display_name: string;
}

export interface DealerRow {
  id: string;
  name: string;
  status: DealerStatus;
  suspended_at: string | null;
  created_at: string;
  staff: number;
  retailers: number;
  owners: string[];
  /** Email of an unused owner invite, when the dealer has no owner yet (or another is invited). */
  pending_owner: string | null;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
  created_at?: string;
  /** Only in the response that created it: the one-time link path. */
  accept_path?: string;
}

export interface DealerDetail {
  id: string;
  name: string;
  status: DealerStatus;
  suspended_at: string | null;
  suspended_reason: string | null;
  created_at: string;
  retailers: number;
  products: number;
  orders: number;
  staff: Array<{ id: string; email: string; display_name: string; role: Role; active: boolean; last_seen_at: string | null }>;
  invitations: Invite[];
}
