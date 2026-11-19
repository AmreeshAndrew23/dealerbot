// The single outbound policy gate (PRD section 10). Pure function: every send in the system is
// decided here, and the result is stored on outbound_messages.policy_result / policy_reason.
import type { OutboundOrigin, OutboundPayload } from "@fmcg/contracts";

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PolicyInput {
  origin: OutboundOrigin;
  payload: OutboundPayload;
  ownerMode: "BOT" | "HUMAN";
  lastInboundAt: Date | null;
  optedOut: boolean;
  /** Confirmation of an opt-out request; the only message allowed to an opted-out contact. */
  isOptOutConfirmation?: boolean;
  now: Date;
}

export type PolicyDecision =
  | { result: "ALLOW"; reason: "IN_SERVICE_WINDOW" | "APPROVED_TEMPLATE" | "OPT_OUT_CONFIRMATION" }
  | { result: "DENY"; reason: "OPTED_OUT" | "HUMAN_TAKEOVER" | "OUTSIDE_SERVICE_WINDOW" };

export function evaluatePolicy(i: PolicyInput): PolicyDecision {
  if (i.optedOut) {
    return i.isOptOutConfirmation
      ? { result: "ALLOW", reason: "OPT_OUT_CONFIRMATION" }
      : { result: "DENY", reason: "OPTED_OUT" };
  }
  // While a person owns the conversation, the bot stays silent. System notices (e.g. "Sales Order
  // created") and the human's own replies are still allowed.
  if (i.ownerMode === "HUMAN" && i.origin === "bot") return { result: "DENY", reason: "HUMAN_TAKEOVER" };

  const inWindow = i.lastInboundAt !== null && i.now.getTime() - i.lastInboundAt.getTime() < SERVICE_WINDOW_MS;
  if (inWindow) return { result: "ALLOW", reason: "IN_SERVICE_WINDOW" };
  if (i.payload.kind === "template") return { result: "ALLOW", reason: "APPROVED_TEMPLATE" };
  return { result: "DENY", reason: "OUTSIDE_SERVICE_WINDOW" };
}
