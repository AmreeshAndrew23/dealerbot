import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type OrderDetail, type OrderStatus, type OrderSummary } from "../api";
import { useCan } from "../auth";
import { fmtFull, fmtPhone, fmtRelativeDay } from "../format";
import { Icon } from "../icons";

const STATUS: Record<OrderStatus, { label: string; tone: string }> = {
  READY_FOR_REVIEW: { label: "To review", tone: "human" },
  APPROVED: { label: "Approved · waiting for Tally", tone: "bot" },
  EXPORTING: { label: "Sending to Tally", tone: "bot" },
  EXPORTED: { label: "Created in Tally", tone: "ok" },
  EXPORT_UNCERTAIN: { label: "Checking Tally", tone: "human" },
  EXPORT_FAILED: { label: "Tally rejected", tone: "bad" },
  REJECTED: { label: "Rejected", tone: "bad" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  EXPIRED: { label: "Expired", tone: "neutral" },
};

const TABS = [
  { key: "review", label: "To review", statuses: ["READY_FOR_REVIEW"] },
  { key: "approved", label: "Approved", statuses: ["APPROVED", "EXPORTING", "EXPORT_UNCERTAIN", "EXPORT_FAILED", "EXPORTED"] },
  { key: "closed", label: "Rejected / cancelled", statuses: ["REJECTED", "CANCELLED", "EXPIRED"] },
  { key: "all", label: "All", statuses: [] as string[] },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const UNIT: Record<string, string> = { CASE: "case", BOX: "box", PCS: "pcs", BUNDLE: "bundle", DOZEN: "dozen" };
const unit = (u: string) => UNIT[u] ?? u.toLowerCase();
const num = (s: string) => String(Number(s));
export const rupees = (v: string) => "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ACTION_TEXT: Record<string, string> = {
  "order.confirmed_by_retailer": "Retailer confirmed on chat",
  "order.changed_by_retailer": "Retailer changed the order on chat (new version)",
  "order.approved": "Approved",
  "order.rejected": "Rejected",
  "order.cancelled": "Cancelled",
};

export function StatusBadge({ s }: { s: OrderStatus }) {
  const st = STATUS[s] ?? { label: s, tone: "neutral" };
  return <span className={`badge ${st.tone}`}>{st.label}</span>;
}

export function OrdersPage() {
  const { id } = useParams();
  const [tab, setTab] = useState<TabKey>("review");
  const statuses = TABS.find((t) => t.key === tab)!.statuses;
  const params = new URLSearchParams({ limit: "100" });
  if (statuses.length) params.set("status", statuses.join(","));
  const list = useQuery({
    queryKey: ["orders", tab],
    queryFn: () => api<{ orders: OrderSummary[]; counts: Record<string, number>; next_cursor: string | null }>(`/v1/orders?${params}`),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
  const counts = list.data?.counts ?? {};
  const countOf = (t: (typeof TABS)[number]) => (t.statuses.length ? t.statuses.reduce((n, s) => n + (counts[s] ?? 0), 0) : Object.values(counts).reduce((a, b) => a + b, 0));
  const orders = list.data?.orders ?? [];

  return (
    <div className={`wb${id ? " has-selection" : ""}`}>
      <div className="wb-list">
        <div className="wb-list-head">
          <h1>Orders</h1>
          <div className="tabs" role="tablist" aria-label="Order queue">
            {TABS.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label}
                <span className="count">{countOf(t)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="wb-items">
          {list.isPending && <div className="empty">Loading…</div>}
          {list.error && <div className="empty">Could not load orders.</div>}
          {list.data && orders.length === 0 && (
            <div className="empty">{tab === "review" ? "Nothing to review. New orders appear here when retailers confirm on chat." : "No orders here."}</div>
          )}
          {orders.map((o) => (
            <Link key={o.id} to={`/orders/${o.id}`} className={`wb-item${o.id === id ? " active" : ""}`}>
              <div className="wb-item-top">
                <strong>{o.order_number}</strong>
                <span className="cell-sub" title={fmtFull(o.confirmed_at ?? o.created_at)}>
                  {fmtRelativeDay(o.confirmed_at ?? o.created_at)}
                </span>
              </div>
              <div className="wb-item-shop">{o.retailer_name}</div>
              <div className="wb-item-bottom">
                <StatusBadge s={o.status} />
                <span className="wb-item-total">
                  {rupees(o.total)} <span className="cell-sub">· {o.line_count} item{o.line_count === 1 ? "" : "s"}</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
      <section className="wb-detail">{id ? <OrderReview key={id} id={id} /> : <div className="empty" style={{ marginTop: 80 }}>Select an order to review it.</div>}</section>
    </div>
  );
}

// ---- one order ---------------------------------------------------------------------------------

type Pending = { kind: "reject" | "cancel" } | null;

const REASONS = {
  reject: ["Out of stock", "Not our area", "Price has changed, please order again", "Duplicate order"],
  cancel: ["Cancelled as you asked", "Out of stock", "Entered by mistake"],
};

function OrderReview({ id }: { id: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const canDecide = useCan("orders.approve");
  const q = useQuery({ queryKey: ["order", id], queryFn: () => api<OrderDetail>(`/v1/orders/${id}`), refetchInterval: 10_000 });
  const o = q.data;
  const [acked, setAcked] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // One Idempotency-Key per decision attempt: a retry after a network error reuses it.
  const key = useRef<string | null>(null);
  const keyFor = () => (key.current ??= crypto.randomUUID());
  useEffect(() => {
    setAcked([]);
    setPending(null);
    setReason("");
    key.current = null;
  }, [id]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["order", id] });
    void qc.invalidateQueries({ queryKey: ["orders"] });
  };
  const onError = (e: Error) => {
    if (e instanceof ApiError && e.code === "ORDER_VERSION_CONFLICT") {
      key.current = null;
      refresh();
    }
  };
  const approve = useMutation({
    mutationFn: () =>
      api<{ export_reference: string }>(`/v1/orders/${id}/approve`, {
        method: "POST",
        headers: { "Idempotency-Key": keyFor(), "If-Match": String(o!.lock_version) },
        body: { version: o!.current_version, summary_hash: o!.summary_hash, acknowledged_warnings: acked },
      }),
    onSuccess: (r) => {
      key.current = null;
      setNotice(`Approved. Queued for Tally as ${r.export_reference}.`);
      refresh();
    },
    onError,
  });
  const decide = useMutation({
    mutationFn: (kind: "reject" | "cancel") =>
      api(`/v1/orders/${id}/${kind}`, { method: "POST", headers: { "Idempotency-Key": keyFor(), "If-Match": String(o!.lock_version) }, body: { reason } }),
    onSuccess: (_r, kind) => {
      key.current = null;
      setPending(null);
      setReason("");
      setNotice(kind === "reject" ? "Order rejected." : "Order cancelled.");
      refresh();
    },
    onError,
  });

  if (q.isPending) return <div className="empty">Loading…</div>;
  if (q.error || !o) return <div className="empty">Could not load this order.</div>;

  const blockers = o.checks.filter((c) => c.severity === "blocker");
  const warnings = o.checks.filter((c) => c.severity === "warning");
  const infos = o.checks.filter((c) => c.severity === "info");
  const canApprove = canDecide && o.allowed.includes("approve");
  const ready = blockers.length === 0 && warnings.every((w) => acked.includes(w.code));
  const err = approve.error ?? decide.error;
  const pieces = o.lines.reduce((n, l) => n + Number(l.base_quantity), 0);

  return (
    <div className="review-pane">
      <div className="review-head">
        <button className="btn small back" onClick={() => nav("/orders")} aria-label="Back to orders">
          <Icon name="back" size={18} />
        </button>
        <div className="who">
          <div className="title">
            {o.order_number} <StatusBadge s={o.status} />
          </div>
          <div className="cell-sub">
            {o.retailer_name}
            {o.contact_phone ? ` · ${fmtPhone(o.contact_phone)}` : ""} · {o.channel === "terminal" ? "terminal test" : o.channel === "whatsapp_test" ? "WhatsApp test" : o.channel === "app" ? "customer app" : "WhatsApp"} · v{o.current_version}
          </div>
        </div>
      </div>

      <div className="review-body">
        {notice && (
          <div className="banner info" role="status">
            {notice}
          </div>
        )}
        {o.status === "APPROVED" && o.export_job && (
          <div className="banner info">
            <div>
              <strong>Waiting for Tally.</strong> Approved by {o.review.reviewed_by_name ?? "staff"}
              {o.review.reviewed_at ? ` on ${fmtFull(o.review.reviewed_at)}` : ""}. Tally reference <code>{o.export_job.external_reference}</code>, export{" "}
              {o.export_job.state.toLowerCase()}. It is created in Tally once the connector is installed.
            </div>
          </div>
        )}
        {(o.status === "REJECTED" || o.status === "CANCELLED") && (
          <div className="banner bad">
            <div>
              <strong>{o.status === "REJECTED" ? "Rejected" : "Cancelled"}</strong> by {o.review.reviewed_by_name ?? "staff"}
              {o.review.reviewed_at ? ` on ${fmtFull(o.review.reviewed_at)}` : ""}. Reason: {o.review.status_reason}
            </div>
          </div>
        )}

        {o.status === "READY_FOR_REVIEW" && (
          <div className="card card-pad checks">
            <h2>Checks before approval</h2>
            {blockers.length === 0 && warnings.length === 0 && <p className="check ok">✓ Products, packs and prices match today's catalogue.</p>}
            {blockers.map((c, i) => (
              <p key={`b${i}`} className="check bad">
                ✕ {c.line_no ? <strong>Line {c.line_no}: </strong> : null}
                {c.message}
              </p>
            ))}
            {blockers.length === 0 && warnings.length > 0 && <p className="check ok">✓ Products, packs and prices match today's catalogue.</p>}
            {warnings.map((c) => (
              <label key={c.code} className="check warn">
                <input
                  type="checkbox"
                  checked={acked.includes(c.code)}
                  disabled={!canApprove}
                  onChange={(e) => setAcked(e.target.checked ? [...acked, c.code] : acked.filter((x) => x !== c.code))}
                />
                <span>
                  {c.message} <span className="cell-sub">(tick to confirm you checked)</span>
                </span>
              </label>
            ))}
            {infos.map((c) => (
              <p key={c.code} className="check info">
                ℹ {c.message}
              </p>
            ))}
            {blockers.some((b) => b.code === "PRICE_CHANGED") && (
              <p className="hint">A price changed after the retailer confirmed, so they must agree to the new total. Reject with "Price needs checking" and ask them to order again.</p>
            )}
          </div>
        )}

        <div className="card">
          <table className="table stack bill-lines">
            <colgroup>
              <col style={{ width: "6%" }} />
              <col />
              <col style={{ width: "22%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "17%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>Product</th>
                <th>Quantity</th>
                <th className="num">Rate</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.line_no} className={blockers.some((b) => b.line_no === l.line_no) ? "row-flag" : undefined}>
                  <td className="cell-sub">{l.line_no}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{l.name}</div>
                    <div className="cell-sub">{l.sku_code}</div>
                  </td>
                  <td>
                    {num(l.quantity)} {unit(l.unit)}
                    {l.unit !== l.base_unit && (
                      <div className="cell-sub">
                        {num(l.base_quantity)} {unit(l.base_unit)}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    <span className="stack-label">Rate </span>
                    {rupees(l.unit_price)}/{unit(l.base_unit)}
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    <span className="stack-label">Amount </span>
                    {rupees(l.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="bill-total">
            <span className="cell-sub">
              {o.lines.length} item{o.lines.length === 1 ? "" : "s"} · {pieces} pieces
            </span>
            <strong>Total {rupees(o.total)}</strong>
          </div>
        </div>

        {o.confirmation?.evidence && (
          <p className="hint">
            Retailer confirmed with “{o.confirmation.evidence}” on {fmtFull(o.confirmation.confirmed_at)}.
          </p>
        )}

        <div className="card card-pad">
          <h2 className="section-title">History</h2>
          <ol className="timeline">
            {o.history.map((h, i) => (
              <li key={i}>
                <span className="when">{fmtFull(h.at)}</span>
                <span>
                  <strong>{ACTION_TEXT[h.action] ?? h.action}</strong>
                  {h.by ? ` · ${h.by}` : ""}
                  {typeof h.details.reason === "string" ? ` · “${h.details.reason}”` : ""}
                  {typeof h.details.export_reference === "string" ? ` · ${h.details.export_reference}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {canDecide && o.allowed.length > 0 && (
        <div className="review-actions">
          {err && <p className="error-text">{err instanceof ApiError ? errorText(err) : "Could not save. Try again."}</p>}
          {pending ? (
            <div className="decide">
              <div className="chips">
                {REASONS[pending.kind].map((r) => (
                  <button key={r} type="button" className={`chip${reason === r ? " on" : ""}`} onClick={() => setReason(r)}>
                    {r}
                  </button>
                ))}
              </div>
              <textarea className="textarea" rows={2} placeholder={`Reason to ${pending.kind} (shown in the order history)`} value={reason} onChange={(e) => setReason(e.target.value)} />
              <span className="hint">The retailer is told this order was {pending.kind === "reject" ? "not accepted" : "cancelled"} and sees this reason, so write it for them.</span>
              <div className="row-actions">
                <button className="btn" onClick={() => setPending(null)}>
                  Back
                </button>
                <button className="btn danger" disabled={reason.trim().length < 3 || decide.isPending} onClick={() => decide.mutate(pending.kind)}>
                  {pending.kind === "reject" ? "Reject order" : "Cancel order"}
                </button>
              </div>
            </div>
          ) : (
            <div className="row-actions">
              {o.allowed.includes("reject") && (
                <button className="btn danger" onClick={() => setPending({ kind: "reject" })}>
                  Reject
                </button>
              )}
              {o.allowed.includes("cancel") && o.status === "APPROVED" && (
                <button className="btn danger" onClick={() => setPending({ kind: "cancel" })}>
                  Cancel order
                </button>
              )}
              {canApprove && (
                <button className="btn primary" disabled={!ready || approve.isPending} onClick={() => approve.mutate()} title={ready ? "" : "Resolve the checks above first"}>
                  {approve.isPending ? "Approving…" : `Approve ${rupees(o.total)}`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function errorText(e: ApiError): string {
  if (e.code === "ORDER_VERSION_CONFLICT") return "This order was changed by someone else. It has been reloaded; check it and try again.";
  if (e.code === "VALIDATION_FAILED") return "This order can't be approved: " + ((e.details.blockers as Array<{ message: string }>) ?? []).map((b) => b.message).join(" ");
  return e.message;
}
