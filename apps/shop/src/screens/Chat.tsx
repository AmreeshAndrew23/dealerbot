// Chat with one dealer: the order assistant answers, or the dealer's staff when they take over.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Chat, type ChatMessage, type Dealer } from "../api";
import { Icon, dayHeading, dayKey, go, rich, timeFmt } from "../ui";

interface Pending {
  client_id: string;
  text: string;
  at: string;
  failed: boolean;
}

export function ChatView({ dealer, prefill }: { dealer: Dealer; prefill: string }) {
  const qc = useQueryClient();
  const key = ["chat", dealer.id];
  const chat = useQuery({ queryKey: key, queryFn: () => api<Chat>(`/dealers/${dealer.id}/messages`), refetchInterval: 4_000 });
  // Opening the chat reads the dealer's messages: refresh the unread counts when something new came.
  const newest = chat.data?.items.at(-1)?.id;
  useEffect(() => {
    if (newest) void qc.invalidateQueries({ queryKey: ["me"] });
  }, [newest, qc]);

  const [pending, setPending] = useState<Pending[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [text, setText] = useState(prefill);

  const deliver = async (p: Pending) => {
    setPending((list) => list.map((x) => (x.client_id === p.client_id ? { ...x, failed: false } : x)));
    setWaiting((n) => n + 1);
    try {
      // The same client_id on a retry is stored and answered once.
      await api(`/dealers/${dealer.id}/messages`, { method: "POST", body: { text: p.text, client_id: p.client_id } });
      await qc.invalidateQueries({ queryKey: key });
      setPending((list) => list.filter((x) => x.client_id !== p.client_id));
      void qc.invalidateQueries({ queryKey: ["orders"] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    } catch {
      setPending((list) => list.map((x) => (x.client_id === p.client_id ? { ...x, failed: true } : x)));
    } finally {
      setWaiting((n) => n - 1);
    }
  };
  const send = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    const p: Pending = { client_id: crypto.randomUUID(), text: t, at: new Date().toISOString(), failed: false };
    setPending((list) => [...list, p]);
    setText("");
    if (prefill) go(`/d/${dealer.id}/chat`, true);
    void deliver(p);
  };

  const box = useRef<HTMLTextAreaElement>(null);
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };
  useEffect(() => {
    if (!text && box.current) box.current.style.height = "";
    if (prefill && box.current) {
      box.current.focus();
      grow(box.current);
    }
  }, [text, prefill]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends on a computer; on a phone the Enter key makes a new line and the button sends.
    if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      send(text);
    }
  };

  const items = chat.data?.items ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const lastKey = `${items.at(-1)?.id ?? ""}:${pending.length}:${waiting}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastKey]);

  const withStaff = chat.data?.with_staff ?? false;
  const empty = chat.data && items.length === 0 && pending.length === 0;

  return (
    <>
      <div className="messages" ref={scroller} aria-live="polite">
        {chat.isPending && <div className="note">Loading…</div>}
        {chat.error && !chat.data && <div className="note">Could not load the chat. Check your internet.</div>}
        {empty && (
          <div className="welcome">
            <h2>Vanakkam{dealer.contact_name ? `, ${dealer.contact_name}` : ""} 🙏</h2>
            <p>
              Type your order the way you would say it, in English, Tamil or Tanglish. For example: <em>2 box Good Day, 1 case Marie Gold</em>. Or pick items from the price list.
            </p>
            <div className="chips">
              <button className="chip" onClick={() => send("Hi")}>
                Say hi
              </button>
              <button className="chip" onClick={() => go(`/d/${dealer.id}/prices`, true)}>
                Open the price list
              </button>
            </div>
          </div>
        )}
        {items.map((m, i) => (
          <Fragment key={m.id}>
            {(i === 0 || dayKey.format(new Date(items[i - 1]!.at)) !== dayKey.format(new Date(m.at))) && <div className="day">{dayHeading(m.at)}</div>}
            <Bubble m={m} dealer={dealer.name} />
          </Fragment>
        ))}
        {pending.map((p) => (
          <div key={p.client_id} className={`bubble me${p.failed ? " failed" : " sending"}`}>
            <div>{p.text}</div>
            <div className="meta">
              {p.failed ? (
                <button className="retry" onClick={() => void deliver(p)}>
                  Not sent. Tap to try again
                </button>
              ) : (
                "Sending…"
              )}
            </div>
          </div>
        ))}
        {waiting > 0 && !withStaff && (
          <div className="bubble them typing" aria-label="The assistant is typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      {withStaff && <div className="staff-note">A person at {dealer.name} is handling this chat and will reply here.</div>}
      {!withStaff && items.length > 0 && pending.length === 0 && (
        <div className="quick" role="group" aria-label="Quick replies">
          {/* YES only while the assistant's last message asks for it, so a stray tap orders nothing. */}
          {chat.data?.awaiting_confirmation && items.at(-1)?.from === "assistant" && (
            <button className="chip small strong" onClick={() => send("YES")}>
              YES, place the order
            </button>
          )}
          <button className="chip small" onClick={() => send("Where is my order?")}>
            Where is my order?
          </button>
          <button className="chip small" onClick={() => send("STAFF")}>
            Talk to staff
          </button>
        </div>
      )}
      <div className="composer">
        <label htmlFor="msg" className="sr-only">
          Message
        </label>
        <textarea
          id="msg"
          ref={box}
          className="input"
          rows={1}
          maxLength={2000}
          placeholder="Type your order or a question"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            grow(e.currentTarget);
          }}
          onKeyDown={onKey}
        />
        <button className="btn primary send" aria-label="Send" disabled={!text.trim()} onClick={() => send(text)}>
          <Icon name="send" />
        </button>
      </div>
    </>
  );
}

function Bubble({ m, dealer }: { m: ChatMessage; dealer: string }) {
  const mine = m.from === "me";
  return (
    <div className={`bubble ${mine ? "me" : "them"}`}>
      {m.from === "staff" && <div className="origin">{dealer} staff</div>}
      <div>{mine ? m.text : rich(m.text)}</div>
      <div className="meta">{timeFmt.format(new Date(m.at))}</div>
    </div>
  );
}
