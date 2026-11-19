// Fetch wrapper for the /v1 API. Errors follow the PRD envelope.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, any> = {},
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? "HTTP_" + res.status, e.message ?? "Request failed.", e.details ?? {});
  }
  return json as T;
}

// ---- Types returned by the API ------------------------------------------------------------

export type Role = "OWNER" | "OPERATOR" | "VIEWER";

export interface Me {
  user: { id: string; email: string; display_name: string };
  tenant: { id: string; name: string; timezone: string } | null;
  role: Role;
  permissions: string[];
  tenants: Array<{ id: string; name: string; role: Role }>;
}

/** Where the chat happens: our customer app, WhatsApp (Cloud API) or the WhatsApp test bridge. */
export type ChatChannel = "app" | "whatsapp_cloud" | "whatsapp_test";

export interface ConversationSummary {
  id: string;
  owner_mode: "BOT" | "HUMAN";
  assigned_user_name: string | null;
  last_inbound_at: string | null;
  phone_e164: string;
  profile_name: string | null;
  /** Shop name from the Retailers page, when the number belongs to one. */
  retailer_name: string | null;
  channel: ChatChannel;
  preview: string | null;
  last_direction: "inbound" | "outbound" | null;
  activity_at: string;
  window_open: boolean;
  /** Set when the assistant promised that a person would follow up. */
  needs_attention: AttentionReason | null;
  attention_at: string | null;
}

export type AttentionReason = "question" | "cancel_request" | "handoff" | "missed_message";

/** The retailer's unconfirmed items held by the assistant. */
export interface PendingDraft {
  status: string;
  lines: Array<{ name: string; qty: number; unit: string; base_qty: number; base_unit: string; amount: string }>;
}

export interface ConversationDetail {
  id: string;
  owner_mode: "BOT" | "HUMAN";
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  last_inbound_at: string | null;
  phone_e164: string;
  profile_name: string | null;
  retailer_name: string | null;
  channel: ChatChannel;
  channel_phone: string | null;
  opted_out: boolean;
  service_window_ends_at: string | null;
  messaging_mode: "FREE_FORM" | "TEMPLATE_ONLY" | "NONE";
  needs_attention: AttentionReason | null;
  attention_at: string | null;
  draft: PendingDraft | null;
}

export interface ThreadItem {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  text: string | null;
  at: string;
  status: "blocked" | "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | null;
  policy_result: "ALLOW" | "DENY" | null;
  policy_reason: string | null;
  error: { message?: string; code?: string } | null;
  origin: "bot" | "human" | "system" | null;
  sent_by_name: string | null;
  media_url: string | null;
  media_mime_type: string | null;
  declared_mime_type: string | null;
  review_reason: string | null;
}

export interface Member {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  active: boolean;
  last_seen_at: string | null;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: string;
  base_unit: string;
  /** Base pieces per unit, smallest first, e.g. { PCS: 1, BOX: 12, CASE: 144 }. */
  pack_units: Record<string, number>;
  /** Money is a string with 2 decimals, e.g. "8.60" (per base unit). */
  mrp: string;
  /** Our cost per base unit; staff only. null = not entered. */
  purchase_rate: string | null;
  dealer_price: string;
  aliases: string[];
  active: boolean;
  /** "manual" = maintained in the dashboard; "tally" = synced by the connector. */
  source: "manual" | "tally";
  /** Available to sell, in base units (e.g. pieces); null = stock not tracked (unlimited). */
  stock: string | null;
  created_at: string;
  updated_at: string;
}

export type ProductDraft = Omit<Product, "id" | "source" | "stock" | "created_at" | "updated_at">;

export interface StockMovement {
  at: string;
  kind: "SET" | "RECEIVE" | "ORDER" | "RELEASE" | "UNTRACK";
  quantity: string;
  balance_after: string | null;
  note: string | null;
  order_number: string | null;
  by: string | null;
}

export interface ImportResult {
  dry_run: boolean;
  applied: boolean;
  errors: Array<{ line: number; message: string }>;
  counts: { rows: number; create: number; update: number; unchanged: number; hide: number; skipped: number };
  items: Array<{
    line: number;
    sku: string;
    name: string;
    action: "create" | "update" | "unchanged";
    changes: Record<string, { from: unknown; to: unknown }>;
  }>;
  hide: Array<{ sku: string; name: string }>;
}

/** Learned from conversations, waiting for staff (only approved aliases are used for matching). */
export interface Learning {
  suggestions: Array<{ id: string; alias: string; sku_id: string; sku: string; product_name: string; times_seen: number; last_seen_at: string }>;
  unmatched: Array<{ id: string; example: string; times_seen: number; last_seen_at: string }>;
}

export type OrderStatus =
  | "READY_FOR_REVIEW" | "APPROVED" | "EXPORTING" | "EXPORTED" | "EXPORT_UNCERTAIN" | "EXPORT_FAILED" | "REJECTED" | "CANCELLED" | "EXPIRED";

export interface OrderSummary {
  id: string;
  order_number: string;
  status: OrderStatus;
  retailer_name: string;
  contact_phone: string | null;
  channel: "whatsapp" | "whatsapp_test" | "terminal" | "app";
  current_version: number;
  total: string;
  line_count: number;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderCheck {
  code: string;
  severity: "blocker" | "warning" | "info";
  message: string;
  line_no?: number;
}

export interface OrderDetail extends OrderSummary {
  lock_version: number;
  allowed: Array<"approve" | "reject" | "cancel">;
  checks: OrderCheck[];
  export_job: { state: string; external_reference: string; created_at: string } | null;
  review: { status_reason: string | null; reviewed_by_name: string | null; reviewed_at: string | null };
  history: Array<{ at: string; action: string; by: string | null; details: Record<string, unknown> }>;
  summary_hash: string;
  lines: Array<{ line_no: number; sku_code: string; name: string; unit: string; quantity: string; base_unit: string; base_quantity: string; unit_price: string; amount: string }>;
  confirmation: { channel: string; evidence: string | null; confirmed_at: string } | null;
}

export interface Retailer {
  id: string;
  shop_name: string;
  contact_name: string | null;
  phone: string;
  area: string | null;
  notes: string | null;
  active: boolean;
  /** Can sign in to the customer app (an access code exists). */
  app_access: boolean;
  app_code_set_at: string | null;
  orders: number;
  last_order_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RetailerDraft {
  shop_name: string;
  contact_name: string;
  phone: string;
  area: string;
  notes: string;
}

/** A number that messaged but is not a connected retailer. */
export interface UnknownSender {
  phone: string;
  profile_name: string | null;
  last_text: string | null;
  reason: "not_a_retailer" | "retailer_inactive";
  attempts: number;
  first_at: string;
  last_at: string;
  /** Set when the number belongs to a disconnected retailer. */
  shop_name: string | null;
}
