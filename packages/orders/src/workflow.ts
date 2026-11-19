// Order workflow (architecture 5.1) as a pure function: transition(state, event) -> next | error.
// Only server handlers change state, inside the order lock, and every change is audited.

export type OrderStatus =
  | "DRAFT"
  | "NEEDS_CLARIFICATION"
  | "AWAITING_RETAILER"
  | "READY_FOR_REVIEW"
  | "APPROVED"
  | "EXPORTING"
  | "EXPORTED"
  | "EXPORT_UNCERTAIN"
  | "EXPORT_FAILED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED";

export type OrderEvent = "approve" | "reject" | "cancel";

const PRE_SUBMISSION: OrderStatus[] = ["DRAFT", "NEEDS_CLARIFICATION", "AWAITING_RETAILER", "READY_FOR_REVIEW"];

const TABLE: Record<OrderEvent, { from: OrderStatus[]; to: OrderStatus }> = {
  approve: { from: ["READY_FOR_REVIEW"], to: "APPROVED" },
  // Architecture 12 item 10 (proposed): reject/cancel from any pre-submission state and EXPORT_FAILED.
  reject: { from: [...PRE_SUBMISSION, "EXPORT_FAILED"], to: "REJECTED" },
  // Cancelling an APPROVED order is only allowed while its export job is still QUEUED (checked by the caller).
  cancel: { from: [...PRE_SUBMISSION, "APPROVED", "EXPORT_FAILED"], to: "CANCELLED" },
};

export function transition(from: OrderStatus, event: OrderEvent): { ok: true; to: OrderStatus } | { ok: false; error: string } {
  const t = TABLE[event];
  if (!t.from.includes(from)) return { ok: false, error: `Cannot ${event} an order that is ${from.replace(/_/g, " ").toLowerCase()}.` };
  return { ok: true, to: t.to };
}

/** What staff can do now, for the dashboard buttons. */
export function allowedEvents(from: OrderStatus): OrderEvent[] {
  return (Object.keys(TABLE) as OrderEvent[]).filter((e) => TABLE[e].from.includes(from));
}
