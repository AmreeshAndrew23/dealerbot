// Fetch wrapper and types for the customer app routes (/v1/app). Errors follow the API's error envelope.

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
  const res = await fetch(`/v1/app${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: the server is unreachable behind the proxy */
  }
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? "HTTP_" + res.status, e.message ?? "Something went wrong. Please try again.");
  }
  return json as T;
}

/** A dealer (distributor) this phone is linked to, as the home screen shows it. */
export interface Dealer {
  id: string;
  name: string;
  /** The shop's name in this dealer's records. */
  shop_name: string;
  contact_name: string | null;
  unread: number;
  last_message: { from: "me" | "assistant" | "staff"; text: string; at: string } | null;
  /** Orders this dealer has not accepted yet. */
  waiting_orders: number;
  with_staff: boolean;
}

export interface Me {
  phone: string;
  dealers: Dealer[];
  signed_out?: boolean;
  added?: string;
}

export interface ChatMessage {
  id: string;
  from: "me" | "assistant" | "staff";
  text: string;
  at: string;
}

export interface Chat {
  items: ChatMessage[];
  /** A person at the dealer is handling the chat (the assistant is silent). */
  with_staff: boolean;
  /** The assistant showed an order summary and waits for YES. */
  awaiting_confirmation: boolean;
}

export interface CatalogueItem {
  sku: string;
  name: string;
  category: string;
  mrp: string;
  /** The shop's rate per base unit. */
  rate: string;
  base_unit: string;
  /** Largest first; price = rate x per. */
  packs: Array<{ unit: string; per: number; price: string }>;
  in_stock: boolean;
}

export interface Catalogue {
  dealer: { id: string; name: string };
  items: CatalogueItem[];
  updated_at: string | null;
}

export type ShopOrderStatus = "received" | "accepted" | "rejected" | "cancelled";

export interface ShopOrder {
  id: string;
  dealer: { id: string; name: string };
  order_number: string;
  status: ShopOrderStatus;
  reason: string | null;
  total: string;
  line_count: number;
  /** The shop changed it after placing it (before the dealer accepted). */
  updated: boolean;
  placed_at: string;
}

export interface ShopOrderDetail extends Omit<ShopOrder, "line_count"> {
  timeline: Array<{ at: string; event: "placed" | "changed" | "accepted" | "rejected" | "cancelled"; total?: string }>;
  lines: Array<{ line_no: number; sku: string; name: string; unit: string; quantity: string; base_unit: string; base_quantity: string; rate: string; amount: string }>;
}

export interface CartItem {
  sku: string;
  unit: string;
  qty: number;
}
