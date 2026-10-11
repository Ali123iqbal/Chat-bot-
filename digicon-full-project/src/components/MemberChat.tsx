"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import "./MemberChat.css";

export interface ReplyRow { title: string; subtitle: string; detail?: string }
export interface ChatReply {
  kind: "answer" | "clarify" | "no_match" | "unknown" | "error";
  text: string;
  rows?: ReplyRow[];
  note?: string;
  suggestions?: string[];
}
interface Status {
  memberCount: number;
  lastSuccessfulRefresh: string | null;
  lastRefreshError: { at: string; summary: string[] } | null;
}
type Item =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; reply: ChatReply }
  | { id: number; role: "problem"; kind: "error" | "timeout" | "auth" | "expired"; text: string; retry?: string };

export interface MemberChatProps {
  /** Base path of the chat API. */
  apiBase?: string;
  /** Called before each request; return the auth headers your sign-in uses. */
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Called when the server says the user is not authorized. */
  onUnauthorized?: () => void;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Starter questions shown when the conversation is empty. */
  starters?: string[];
}

type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

const MAX_CHARS = 500;
const DEFAULT_STARTERS = [
  "How many members are in each department?",
  "Which HR members have no classes on Monday, second slot?",
  "Who can stay until 5 pm?",
  "Is Ahmed in DIGICON?",
];

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function MemberChat({
  apiBase = "/api",
  getAuthHeaders,
  onUnauthorized,
  timeoutMs = 15_000,
  starters = DEFAULT_STARTERS,
}: MemberChatProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusProblem, setStatusProblem] = useState(false);
  const conversationId = useRef<string | null>(null);
  const nextId = useRef(1);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const uid = useId();

  const headers = useCallback(async () => ({ "content-type": "application/json", ...(await getAuthHeaders?.()) }), [getAuthHeaders]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/status`, { headers: await headers(), cache: "no-store" });
        if (res.status === 401) { onUnauthorized?.(); return; }
        if (!res.ok) throw new Error();
        const s = (await res.json()) as Status;
        if (alive) { setStatus(s); setStatusProblem(false); }
      } catch {
        if (alive) setStatusProblem(true);
      }
    })();
    return () => { alive = false; };
  }, [apiBase, headers, onUnauthorized]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  const add = (i: NewItem) => {
    const item = { ...i, id: nextId.current++ } as Item;
    setItems((prev) => [...prev, item]);
  };

  const send = useCallback(
    async (raw: string, isRetry = false) => {
      const message = raw.trim();
      if (!message || busy || message.length > MAX_CHARS) return;
      if (!isRetry) add({ role: "user", text: message });
      setInput("");
      setBusy(true);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${apiBase}/chat`, {
          method: "POST",
          headers: await headers(),
          body: JSON.stringify({ message, conversationId: conversationId.current ?? undefined }),
          signal: ctrl.signal,
        });
        if (res.status === 401) {
          onUnauthorized?.();
          add({ role: "problem", kind: "auth", text: "You're not authorized to use this chat. Sign in again, then retry." });
        } else if (res.status === 404) {
          conversationId.current = null;
          add({ role: "problem", kind: "expired", text: "This conversation expired, so earlier context is gone. Retry to ask it as a new question.", retry: message });
        } else if (res.status === 429) {
          add({ role: "problem", kind: "error", text: "Too many questions in a short time. Wait a minute, then retry.", retry: message });
        } else if (res.status === 503) {
          add({ role: "problem", kind: "error", text: "The member data isn't available right now. Retry shortly, or contact the data maintainer if it continues.", retry: message });
        } else if (!res.ok) {
          add({ role: "problem", kind: "error", text: "Something went wrong on the server. Retry in a moment.", retry: message });
        } else {
          const data = (await res.json()) as { conversationId: string; reply: ChatReply };
          conversationId.current = data.conversationId;
          add({ role: "assistant", reply: data.reply });
        }
      } catch (e) {
        const timedOut = e instanceof DOMException && e.name === "AbortError";
        add({
          role: "problem",
          kind: timedOut ? "timeout" : "error",
          text: timedOut ? "The request took too long. Retry, or try a narrower question." : "Couldn't reach the server. Check your connection, then retry.",
          retry: message,
        });
      } finally {
        clearTimeout(timer);
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiBase, busy, headers, onUnauthorized, timeoutMs],
  );

  const clear = useCallback(async () => {
    const id = conversationId.current;
    conversationId.current = null;
    setItems([]);
    setInput("");
    inputRef.current?.focus();
    if (id) {
      try { await fetch(`${apiBase}/chat?conversationId=${encodeURIComponent(id)}`, { method: "DELETE", headers: await headers() }); } catch { /* local context is already cleared */ }
    }
  }, [apiBase, headers]);

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void send(input); };
  const lastAssistantId = [...items].reverse().find((i) => i.role === "assistant")?.id;

  return (
    <section className="dmc" aria-labelledby={`${uid}-title`}>
      <header className="dmc-head">
        <div>
          <h2 id={`${uid}-title`} className="dmc-title">Member lookup</h2>
          <p className="dmc-status" data-testid="dataset-status">
            {statusProblem && "Dataset status unavailable."}
            {!statusProblem && !status && "Checking dataset…"}
            {status && (
              <>
                {status.memberCount} accepted members
                {status.lastSuccessfulRefresh ? ` · refreshed ${fmtDate(status.lastSuccessfulRefresh)}` : " · never refreshed"}
              </>
            )}
          </p>
          {status?.lastRefreshError && (
            <p className="dmc-warn" role="status">
              The latest refresh failed on {fmtDate(status.lastRefreshError.at)}. Answers use the previous valid data.
            </p>
          )}
        </div>
        <button type="button" className="dmc-btn dmc-btn-quiet" onClick={clear} disabled={items.length === 0 && !input}>
          Clear conversation
        </button>
      </header>

      <div className="dmc-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation">
        {items.length === 0 && !busy && (
          <div className="dmc-empty">
            <p className="dmc-empty-title">Ask about accepted members.</p>
            <p className="dmc-empty-sub">Departments, class schedules, commutes and who can stay late. I only answer from the member records.</p>
            <ul className="dmc-chips" aria-label="Example questions">
              {starters.map((s) => (
                <li key={s}>
                  <button type="button" className="dmc-chip" onClick={() => void send(s)}>{s}</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {items.map((it) => {
          if (it.role === "user") {
            return <div key={it.id} className="dmc-msg dmc-user"><span className="dmc-sr">You: </span>{it.text}</div>;
          }
          if (it.role === "problem") {
            return (
              <div key={it.id} className={`dmc-msg dmc-problem dmc-${it.kind}`} role="alert">
                <p>{it.text}</p>
                {it.retry && (
                  <button type="button" className="dmc-btn dmc-btn-small" disabled={busy} onClick={() => void send(it.retry!, true)}>Retry</button>
                )}
              </div>
            );
          }
          const r = it.reply;
          return (
            <div key={it.id} className={`dmc-msg dmc-bot dmc-k-${r.kind}`}>
              <span className="dmc-sr">Assistant: </span>
              <p className="dmc-text">{r.text}</p>
              {r.rows && r.rows.length > 0 && (
                <ul className="dmc-rows">
                  {r.rows.map((row, i) => (
                    <li key={`${row.title}-${row.subtitle}-${i}`} className="dmc-row">
                      <span className="dmc-row-title">{row.title}</span>
                      <span className="dmc-row-sub">{row.subtitle}</span>
                      {row.detail && <span className="dmc-row-detail">{row.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {r.note && <p className="dmc-note">{r.note}</p>}
              {r.suggestions && it.id === lastAssistantId && (
                <ul className="dmc-chips" aria-label="Suggested questions">
                  {r.suggestions.map((s) => (
                    <li key={s}><button type="button" className="dmc-chip" disabled={busy} onClick={() => void send(s)}>{s}</button></li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        {busy && (
          <div className="dmc-msg dmc-bot dmc-loading" role="status">
            <span className="dmc-dots" aria-hidden="true"><i /><i /><i /></span>
            Searching member records…
          </div>
        )}
      </div>

      <form className="dmc-form" onSubmit={onSubmit}>
        <label htmlFor={`${uid}-input`} className="dmc-sr">Ask a question about members</label>
        <textarea
          id={`${uid}-input`}
          ref={inputRef}
          className="dmc-input"
          rows={2}
          value={input}
          maxLength={MAX_CHARS}
          placeholder="e.g. Who in Marketing can stay until 6 pm?"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); }
          }}
          aria-describedby={`${uid}-hint`}
        />
        <div className="dmc-form-row">
          <span id={`${uid}-hint`} className="dmc-hint">
            Enter to send, Shift+Enter for a new line{input.length > MAX_CHARS - 80 ? ` · ${MAX_CHARS - input.length} characters left` : ""}
          </span>
          <button type="submit" className="dmc-btn" disabled={busy || !input.trim()} aria-busy={busy}>Ask</button>
        </div>
      </form>
    </section>
  );
}

export default MemberChat;
