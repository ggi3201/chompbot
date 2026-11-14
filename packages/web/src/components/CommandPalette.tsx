import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { CornerDownLeft, MessageCircle, Search, SquarePen, Sparkles, type LucideIcon } from "lucide-react";
import { apiFetch } from "../lib/api";
import { formatTimeAgo } from "../lib/format";
import { navItems } from "./Sidebar";

interface Item {
  id: string;
  label: string;
  hint?: string;
  /** Server-escaped HTML with <mark> around the hit. */
  snippetHtml?: string;
  icon: LucideIcon;
  run: () => void;
}

interface Convo { id: string; title: string | null; updatedAt: string }
interface Hit { conversationId: string; conversationTitle: string | null; updatedAt: string; snippet: string }

const has = (text: string, q: string) => text.toLowerCase().includes(q.toLowerCase());

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<Convo[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    apiFetch("/conversations?limit=6&hideProactive=true")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Convo[]) => setRecent(rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))))
      .catch(() => {});
  }, [open]);

  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) { setHits([]); return; }
    let stale = false;
    const t = setTimeout(() => {
      apiFetch(`/conversations/search?q=${encodeURIComponent(q)}&limit=8&hideProactive=true`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Hit[]) => { if (!stale) setHits(rows); })
        .catch(() => {});
    }, 150);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);

  const go = (to: string) => () => { onClose(); navigate(to); };
  // A fresh /chat mount is already a new chat; an open chat page is told by event (see Chat.tsx).
  const newChat = (prompt?: string) => () => {
    onClose();
    if (pathname.startsWith("/chat")) window.dispatchEvent(new CustomEvent("chomp:new-chat", { detail: prompt }));
    else navigate(prompt ? `/chat?prompt=${encodeURIComponent(prompt)}` : "/chat");
  };

  const sections = useMemo(() => {
    const actions: Item[] = [
      ...(q ? [{ id: "ask", label: `Ask Chomp: "${q}"`, icon: Sparkles, run: newChat(q) }] : []),
      { id: "new", label: "New chat", icon: SquarePen, run: newChat() },
    ].filter((a) => a.id === "ask" || !q || has(a.label, q));
    const pages: Item[] = navItems
      .filter((n) => !q || has(n.label, q) || has(n.to, q))
      .map((n) => ({ id: n.to, label: n.label, hint: n.to, icon: n.icon, run: go(n.to) }));
    const seen = new Set<string>();
    const chats: Item[] = (q.length >= 2
      ? hits.map((h) => ({ id: h.conversationId, title: h.conversationTitle, updatedAt: h.updatedAt, snippet: h.snippet }))
      : recent.filter((c) => !q || has(c.title ?? "", q)).map((c) => ({ ...c, snippet: "" }))
    )
      .filter((c) => !seen.has(c.id) && seen.add(c.id))
      .map((c) => ({
        id: `chat:${c.id}`,
        label: c.title || "Untitled chat",
        hint: formatTimeAgo(c.updatedAt),
        snippetHtml: c.snippet || undefined,
        icon: MessageCircle,
        run: go(`/chat/${c.id}`),
      }));
    // Typed: a page name wins Enter over "Ask Chomp". Empty: recent chats before the full page list.
    return (q
      ? [{ title: "Pages", items: pages }, { title: "Actions", items: actions }, { title: "Chats", items: chats }]
      : [{ title: "Actions", items: actions }, { title: "Recent chats", items: chats }, { title: "Go to", items: pages }]
    ).filter((s) => s.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, hits, recent, pathname]);

  const flat = sections.flatMap((s) => s.items);
  const current = Math.min(active, Math.max(flat.length - 1, 0));

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setActive((current + 1) % Math.max(flat.length, 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setActive((current - 1 + flat.length) % Math.max(flat.length, 1));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      flat[current]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  let idx = -1;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={onClose}
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command menu"
            className="relative w-full max-w-[600px] overflow-hidden rounded-xl border border-glass-border bg-glass/95 backdrop-blur-xl shadow-[0_24px_80px_-12px_rgba(0,0,0,0.75),inset_0_1px_0_rgba(255,255,255,0.06)]"
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ type: "spring", duration: 0.25, bounce: 0.15 }}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={onKeyDown}
          >
            <div className="flex items-center gap-3 px-4 h-14 border-b border-border">
              <Search size={18} strokeWidth={1.5} className="shrink-0 text-text-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search, jump, or ask Chomp…"
                role="combobox"
                aria-expanded="true"
                aria-controls="cmdk-list"
                aria-activedescendant={flat[current] ? `cmdk-${current}` : undefined}
                className="flex-1 min-w-0 bg-transparent border-none outline-none text-[15px] text-text-primary placeholder:text-text-muted"
              />
              <kbd className="hidden sm:block text-[11px] text-text-muted border border-border rounded px-1.5 py-0.5">esc</kbd>
            </div>

            <div ref={listRef} id="cmdk-list" role="listbox" className="max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain p-2">
              {sections.map((s) => (
                <div key={s.title} className="mb-1 last:mb-0">
                  <div className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-text-muted">{s.title}</div>
                  {s.items.map((item) => {
                    idx += 1;
                    const i = idx;
                    const on = i === current;
                    const Icon = item.icon;
                    return (
                      <div
                        key={item.id}
                        id={`cmdk-${i}`}
                        data-idx={i}
                        role="option"
                        aria-selected={on}
                        onMouseMove={() => active !== i && setActive(i)}
                        onClick={item.run}
                        className={`relative flex items-center gap-3 px-2.5 py-2 rounded-lg cursor-pointer transition-colors duration-75 ${on ? "bg-raised text-text-primary" : "text-text-secondary"}`}
                      >
                        {on && <motion.span layoutId="cmdk-bar" className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" transition={{ type: "spring", duration: 0.2, bounce: 0 }} />}
                        <Icon size={16} strokeWidth={1.5} className={`shrink-0 ${on ? "text-accent" : "text-text-muted"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-sm">{item.label}</div>
                          {item.snippetHtml && (
                            <div
                              className="truncate text-xs text-text-muted [&_mark]:bg-transparent [&_mark]:text-accent-ink"
                              dangerouslySetInnerHTML={{ __html: item.snippetHtml }}
                            />
                          )}
                        </div>
                        {item.hint && <span className="shrink-0 text-xs text-text-muted">{item.hint}</span>}
                        {on && <CornerDownLeft size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />}
                      </div>
                    );
                  })}
                </div>
              ))}
              {flat.length === 0 && <div className="px-3 py-8 text-center text-sm text-text-muted">Nothing found.</div>}
            </div>

            <div className="hidden sm:flex items-center gap-4 px-4 h-9 border-t border-border text-[11px] text-text-muted">
              <span><kbd className="font-sans">↑↓</kbd> move</span>
              <span><kbd className="font-sans">↵</kbd> open</span>
              <span className="ml-auto"><kbd className="font-sans">⌘K</kbd> toggle</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
