import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type AttentionReason, type ConversationDetail, type ConversationSummary, type OrderSummary, type ThreadItem } from "../api";
import { useCan, useMe } from "../auth";
import { fmtDayHeading, fmtFull, fmtPhone, fmtRelativeDay, fmtTime, initials, sameDay } from "../format";
import { Icon } from "../icons";
import { rupees, StatusBadge } from "./Orders";

type Filter = "ALL" | "ATTENTION" | "BOT" | "HUMAN";

/** Why the assistant flagged a chat for a person. */
export const ATTENTION_TEXT: Record<AttentionReason, string> = {
  question: "Asked a question",
  cancel_request: "Wants to cancel an order",
  handoff: "Asked for staff",
  missed_message: "Message arrived while offline",
};

export function ConversationsPage() {
  const { id } = useParams();
  return (
    <div className={`conv${id ? " has-selection" : ""}`}>
      <ConversationList selectedId={id} />
      <section className="thread-pane" style={{ minWidth: 0, height: "100%" }}>
        {id ? <Thread key={id} id={id} /> : <div className="empty" style={{ marginTop: 80 }}>Select a conversation to read it.</div>}
      </section>
    </div>
  );
}

function ConversationList({ selectedId }: { selectedId?: string }) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams({ limit: "50" });
  if (filter === "ATTENTION") params.set("attention", "1");
  else if (filter !== "ALL") params.set("owner_mode", filter);
  if (debounced) params.set("q", debounced);
  const list = useQuery({
    queryKey: ["conversations", filter, debounced],
    queryFn: () => api<{ items: ConversationSummary[]; next_cursor: string | null }>(`/v1/conversations?${params}`),
    refetchInterval: 8_000,
    placeholderData: keepPreviousData,
  });

  return (
    <div className="conv-list">
      <div className="conv-list-head">
        <h1>Conversations</h1>
        <label style={{ position: "relative", display: "block" }}>
          <span className="sr-only" style={{ position: "absolute", left: -9999 }}>Search</span>
          <input className="input" placeholder="Search shop, name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="seg" role="group" aria-label="Filter by who is replying">
          {(["ALL", "ATTENTION", "BOT", "HUMAN"] as Filter[]).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "ALL" ? "All" : f === "ATTENTION" ? "Needs reply" : f === "BOT" ? "Assistant" : "Staff"}
            </button>
          ))}
        </div>
      </div>
      <div className="conv-items">
        {list.isPending && <div className="empty">Loading…</div>}
        {list.error && <div className="empty">Could not load conversations.</div>}
        {list.data?.items.length === 0 && (
          <div className="empty">{debounced || filter !== "ALL" ? "No conversations match." : "No messages yet. They appear here when retailers write in the customer app or on WhatsApp."}</div>
        )}
        {list.data?.items.map((c) => (
          <Link key={c.id} to={`/conversations/${c.id}`} className={`conv-item${c.id === selectedId ? " active" : ""}`}>
            <span className="avatar" aria-hidden="true">{initials(c.retailer_name ?? c.profile_name, c.phone_e164)}</span>
            <span style={{ minWidth: 0 }}>
              <div className="conv-name">{c.retailer_name ?? c.profile_name ?? fmtPhone(c.phone_e164)}</div>
              <div className="conv-preview">
                {c.channel === "app" ? "App · " : ""}
                {c.last_direction === "outbound" ? "You: " : ""}
                {c.preview ?? "No messages"}
              </div>
            </span>
            <span className="conv-meta">
              <span>{fmtRelativeDay(c.activity_at)}</span>
              {c.needs_attention && (
                <span className="badge attention" title={ATTENTION_TEXT[c.needs_attention]}>
                  Needs reply
                </span>
              )}
              {c.owner_mode === "HUMAN" ? (
                <span className="badge human" title={c.assigned_user_name ? `Handled by ${c.assigned_user_name}` : "Handled by staff"}>
                  <Icon name="person" size={12} />
                  Staff
                </span>
              ) : (
                <span className="badge bot">
                  <Icon name="bot" size={12} />
                  Assistant
                </span>
              )}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  queued: "Queued",
  sending: "Sending",
  sent: "✓ Sent",
  delivered: "✓✓ Delivered",
  read: "✓✓ Read",
  failed: "Failed",
  blocked: "Not sent",
};

const POLICY_TEXT: Record<string, string> = {
  HUMAN_TAKEOVER: "staff had taken over",
  OUTSIDE_SERVICE_WINDOW: "over 24 h since the customer's last message",
  OPTED_OUT: "customer opted out",
};

const REVIEW_TEXT: Record<string, string> = {
  MEDIA_TOO_LARGE: "File too large to process",
  UNSUPPORTED_MESSAGE_TYPE: "Message type not supported",
};

function reviewText(code: string): string {
  if (REVIEW_TEXT[code]) return REVIEW_TEXT[code]!;
  if (code.startsWith("UNSUPPORTED_MEDIA_TYPE")) return `Unsupported file type (${code.split(":")[1] ?? "unknown"})`;
  if (code.startsWith("MEDIA_DOWNLOAD_FAILED")) return "Could not download the file from WhatsApp";
  return code;
}

function Bubble({ m }: { m: ThreadItem }) {
  const out = m.direction === "outbound";
  const blocked = m.status === "blocked";
  const originLabel = !out ? null : m.origin === "bot" ? "Assistant" : m.origin === "system" ? "System" : (m.sent_by_name ?? "Staff");
  return (
    <div className={`bubble ${out ? "out" : "in"}${blocked ? " blocked" : ""}`}>
      {originLabel && <div className="origin">{originLabel}</div>}
      {m.media_url && (m.media_mime_type ?? "").startsWith("audio/") && <audio controls preload="none" src={m.media_url} aria-label="Voice note" />}
      {m.media_url && (m.media_mime_type ?? "").startsWith("image/") && <img src={m.media_url} alt="Image from retailer" loading="lazy" />}
      {m.media_url && m.media_mime_type === "application/pdf" && (
        <a href={m.media_url} target="_blank" rel="noreferrer">
          Open PDF
        </a>
      )}
      {!m.media_url && !out && ["audio", "image", "document", "video"].includes(m.type) && !m.review_reason && (
        <span className="hint">{m.type === "audio" ? "Voice note" : m.type} · downloading…</span>
      )}
      {m.text && <div>{m.text}</div>}
      {!m.text && m.type === "unsupported" && <span className="hint">Unsupported message</span>}
      {m.review_reason && (
        <div className="review">
          <span className="badge bad">Needs review: {reviewText(m.review_reason)}</span>
        </div>
      )}
      <div className="meta">
        <span title={fmtFull(m.at)}>{fmtTime(m.at)}</span>
        {out && m.status && (
          <span className={`status ${m.status}`}>
            {STATUS_TEXT[m.status] ?? m.status}
            {blocked && m.policy_reason ? `: ${POLICY_TEXT[m.policy_reason] ?? m.policy_reason}` : ""}
            {m.status === "failed" && m.error?.message ? `: ${m.error.message}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const me = useMe();
  const canReply = useCan("conversations.reply");
  const qc = useQueryClient();
  const nav = useNavigate();
  const detail = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => api<ConversationDetail>(`/v1/conversations/${id}`),
    refetchInterval: 15_000,
  });
  const thread = useQuery({
    queryKey: ["thread", id],
    queryFn: () => api<{ items: ThreadItem[]; next_before: string | null }>(`/v1/conversations/${id}/messages?limit=100`),
    refetchInterval: 4_000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["thread", id] });
    qc.invalidateQueries({ queryKey: ["conversations"] });
  };
  const setDetail = (d: ConversationDetail) => {
    qc.setQueryData(["conversation", id], d);
    refresh();
  };
  const takeover = useMutation({ mutationFn: () => api<ConversationDetail>(`/v1/conversations/${id}/takeover`, { method: "POST", body: {} }), onSuccess: setDetail });
  const resume = useMutation({ mutationFn: () => api<ConversationDetail>(`/v1/conversations/${id}/resume`, { method: "POST", body: {} }), onSuccess: setDetail });
  const markDone = useMutation({ mutationFn: () => api<ConversationDetail>(`/v1/conversations/${id}/attention/clear`, { method: "POST", body: {} }), onSuccess: setDetail });

  // Keep the newest message in view when new ones arrive.
  const scroller = useRef<HTMLDivElement>(null);
  const lastId = thread.data?.items.at(-1)?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  if (detail.error) {
    return (
      <div className="empty" style={{ marginTop: 80 }}>
        {detail.error instanceof ApiError && detail.error.status === 404 ? "This conversation does not exist." : "Could not load the conversation."}
      </div>
    );
  }
  const d = detail.data;
  const items = thread.data?.items ?? [];
  const mine = d?.assigned_user_id === me.user.id;

  return (
    <div className="thread">
      <header className="thread-head">
        <button className="btn small back" onClick={() => nav("/conversations")} aria-label="Back to list">
          <Icon name="back" size={16} />
        </button>
        <span className="avatar" aria-hidden="true">{d ? initials(d.retailer_name ?? d.profile_name, d.phone_e164) : ""}</span>
        <div className="who">
          <div className="name">{d?.retailer_name ?? d?.profile_name ?? fmtPhone(d?.phone_e164) ?? "…"}</div>
          <div className="phone">
            {fmtPhone(d?.phone_e164)}
            {d?.channel === "app" ? " · in the customer app" : d?.channel_phone ? ` · to ${d.channel_phone}` : ""}
          </div>
        </div>
        <div className="thread-actions">
        {d &&
          (d.owner_mode === "HUMAN" ? (
            <span className="badge human">
              <Icon name="person" size={12} />
              {mine ? "You are handling this" : `Handled by ${d.assigned_user_name ?? "staff"}`}
            </span>
          ) : (
            <span className="badge bot">
              <Icon name="bot" size={12} />
              Assistant is replying
            </span>
          ))}
        {d && canReply && d.owner_mode === "BOT" && (
          <button className="btn primary small" onClick={() => takeover.mutate()} disabled={takeover.isPending}>
            Take over
          </button>
        )}
        {d && canReply && d.owner_mode === "HUMAN" && (
          <button className="btn small" onClick={() => resume.mutate()} disabled={resume.isPending}>
            Hand back to assistant
          </button>
        )}
        </div>
      </header>

      {d && (
        <div className="thread-banner">
          {d.needs_attention && (
            <div className="banner attention" role="status">
              <strong>Needs reply: {ATTENTION_TEXT[d.needs_attention]}</strong>
              <span>
                {d.needs_attention === "cancel_request"
                  ? "The retailer asked to cancel their order. Cancel it on the Orders page (they are told automatically), then mark this done."
                  : d.needs_attention === "missed_message"
                    ? "This message arrived while the WhatsApp bridge was offline, so the assistant did not answer it."
                    : d.needs_attention === "handoff"
                      ? "The assistant passed this chat to staff. Take over and reply."
                      : "The assistant told the retailer that the team will answer. Take over and reply."}{" "}
                Replying clears this.
              </span>
              {canReply && (
                <button className="btn small" onClick={() => markDone.mutate()} disabled={markDone.isPending}>
                  Mark done
                </button>
              )}
            </div>
          )}
          {d.draft && (
            <div className="banner info">
              <strong>Not yet confirmed by the retailer</strong>
              <span>
                {d.draft.lines.map((l) => `${l.qty} ${l.unit.toLowerCase()} ${l.name}`).join(" · ")} · total{" "}
                {rupees(d.draft.lines.reduce((t, l) => t + Number(l.amount), 0).toFixed(2))}. These items stay in their order when you hand the chat back.
              </span>
            </div>
          )}
          {d.messaging_mode === "FREE_FORM" && d.service_window_ends_at && (
            <div className="banner info">
              <strong>Free replies open</strong>
              <span>until {fmtFull(d.service_window_ends_at)} (24 h after the customer's last message).</span>
            </div>
          )}
          {d.messaging_mode === "TEMPLATE_ONLY" && (
            <div className="banner warn">
              <strong>Templates only</strong>
              <span>More than 24 h since the customer's last message. WhatsApp only allows approved templates until they write again.</span>
            </div>
          )}
          {d.messaging_mode === "NONE" && (
            <div className="banner bad">
              <strong>Opted out</strong>
              <span>This customer sent STOP. No messages can be sent until they send START.</span>
            </div>
          )}
        </div>
      )}

      <ThreadOrders id={id} />

      <div className="messages" ref={scroller} aria-live="polite">
        {thread.isPending && <div className="empty">Loading…</div>}
        {items.map((m, i) => (
          <div key={m.id} style={{ display: "contents" }}>
            {(i === 0 || !sameDay(items[i - 1]!.at, m.at)) && <div className="day">{fmtDayHeading(m.at)}</div>}
            <Bubble m={m} />
          </div>
        ))}
      </div>

      {d && <Composer detail={d} canReply={canReply} onSent={refresh} />}
    </div>
  );
}

/** The retailer's orders, above the chat: the latest one, and the rest on demand. Each opens in Orders. */
function ThreadOrders({ id }: { id: string }) {
  const canSee = useCan("orders.view");
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["conversation-orders", id],
    queryFn: () => api<{ orders: OrderSummary[] }>(`/v1/conversations/${id}/orders`),
    refetchInterval: 10_000,
    enabled: canSee,
  });
  const orders = q.data?.orders ?? [];
  if (!orders.length) return null;
  const shown = open ? orders : orders.slice(0, 1);
  return (
    <div className="thread-orders">
      <div className="thread-orders-head">
        <strong>
          {orders.length} order{orders.length === 1 ? "" : "s"}
        </strong>
        {orders.length > 1 && (
          <button className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Show latest only" : `Show all ${orders.length}`}
          </button>
        )}
      </div>
      <div className="thread-orders-list">
        {shown.map((o) => (
          <Link key={o.id} to={`/orders/${o.id}`} className="thread-order">
            <span className="thread-order-main">
              <strong>{o.order_number}</strong>
              <span className="cell-sub" title={fmtFull(o.confirmed_at ?? o.created_at)}>
                {fmtRelativeDay(o.confirmed_at ?? o.created_at)} · {o.line_count} item{o.line_count === 1 ? "" : "s"}
              </span>
            </span>
            <StatusBadge s={o.status} />
            <strong className="thread-order-total">{rupees(o.total)}</strong>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Composer({ detail, canReply, onSent }: { detail: ConversationDetail; canReply: boolean; onSent: () => void }) {
  const [text, setText] = useState("");
  // One idempotency key per draft: a retry after a network error cannot send twice.
  const keyRef = useRef<string>(crypto.randomUUID());
  const send = useMutation({
    mutationFn: (body: string) =>
      api(`/v1/conversations/${detail.id}/messages`, { method: "POST", body: { text: body }, headers: { "Idempotency-Key": keyRef.current } }),
    onSuccess: () => {
      setText("");
      keyRef.current = crypto.randomUUID();
      onSent();
    },
    onError: (err) => {
      // A refused message is recorded; start a fresh draft key for the next attempt.
      if (err instanceof ApiError && err.status === 422) {
        keyRef.current = crypto.randomUUID();
        onSent();
      }
    },
  });

  let blockedReason: string | null = null;
  if (!canReply) blockedReason = "Your role can read conversations but not reply.";
  else if (detail.owner_mode !== "HUMAN") blockedReason = "Take over the conversation to reply. The assistant stays silent while you handle it.";
  else if (detail.messaging_mode === "NONE") blockedReason = "The customer has opted out.";
  else if (detail.messaging_mode === "TEMPLATE_ONLY") blockedReason = "Free-form replies are not allowed outside the 24-hour window.";

  const box = useRef<HTMLTextAreaElement>(null);
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  useEffect(() => {
    if (!text && box.current) box.current.style.height = "";
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (t && !send.isPending && !blockedReason) send.mutate(t);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      {blockedReason ? (
        <div className="composer-note">{blockedReason}</div>
      ) : (
        <>
          <div className="composer-row">
            <label htmlFor="reply" style={{ position: "absolute", left: -9999 }}>
              Reply
            </label>
            <textarea id="reply" className="textarea" rows={1} placeholder="Type a reply. Enter to send, Shift+Enter for a new line." value={text} onChange={(e) => { setText(e.target.value); grow(e.currentTarget); }} onKeyDown={onKey} maxLength={4096} ref={box} />
            <button className="btn primary" onClick={submit} disabled={!text.trim() || send.isPending} aria-label="Send">
              <Icon name="send" size={18} />
              <span className="label">Send</span>
            </button>
          </div>
          {send.error && <div className="error-text">{send.error instanceof ApiError ? send.error.message : "Not sent: check your connection and press Send again."}</div>}
        </>
      )}
    </div>
  );
}
