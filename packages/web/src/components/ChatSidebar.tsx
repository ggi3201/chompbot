import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../lib/api";
import { getToken } from "../lib/api";
import { Search, SquarePen, X, Pin, MoreHorizontal, Tag, Download, Trash2, FolderGit2, Loader2, Pencil, Sparkles } from "lucide-react";
import { IconButton } from "./ui";
import { formatTimeAgo } from "../lib/format";

interface Conversation {
  id: string;
  title: string | null;
  ccSessionId?: string | null;
  codexSessionId?: string | null;
  pinnedAgent?: string | null;
  /** The repo the chat's agents run in, if it has one. */
  projectPath?: string | null;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** True when an agent session is live for this conversation (server-provided). */
  running?: boolean;
  /** True when its agent waits on an answer or an approval (server-provided). */
  needsInput?: boolean;
  /** True when a reply came after the user last had the chat on screen, on any device (server-provided). */
  unread?: boolean;
}

interface SearchResult {
  conversationId: string;
  conversationTitle: string | null;
  updatedAt: string;
  messageId: string | null;
  role: string | null;
  snippet: string;
}

async function downloadExport(conversationId: string, format: "markdown" | "json") {
  const token = getToken();
  const res = await fetch(`/api/conversations/${conversationId}/export?format=${format}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return;
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const filenameMatch = disposition.match(/filename="(.+)"/);
  const filename = filenameMatch?.[1] || `chomp-export.${format === "json" ? "json" : "md"}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function FilterChip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`h-6 px-2 flex items-center gap-1 rounded-md border-none text-xs cursor-pointer transition-colors ${
        on ? "bg-raised text-text-primary" : "bg-transparent text-text-muted hover:text-text-secondary"
      }`}
    >
      {children}
    </button>
  );
}

/** "9m", "3h", "2d", "12 Oct": short enough to sit at the end of a row. */
function shortTimeAgo(iso: string): string {
  const full = formatTimeAgo(iso);
  return full === "just now" ? "now" : full.replace(" ago", "");
}

const projectName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The repo a chat's agents run in, as a line under its title. A plain chat has none. */
function ProjectLine({ path }: { path?: string | null }) {
  if (!path) return null;
  return (
    <span title={`Project: ${path}`} className="flex items-center gap-1 min-w-0 font-mono text-xs leading-4 text-text-muted">
      <FolderGit2 size={12} strokeWidth={1.5} className="shrink-0" />
      <span className="truncate">{projectName(path)}</span>
    </span>
  );
}

// Everything on the first line sits in an h-5 box, so a row with a project line under its title keeps that line aligned.
const ROW = "group flex items-start gap-2 px-2.5 py-2.5 md:py-2 rounded-md cursor-pointer transition-colors";
const LINE = "h-5 flex items-center shrink-0";
const ROW_ACTIVE = "bg-raised";
const ROW_IDLE = "bg-transparent hover:bg-white/4";
const MENU_ITEM = "w-full text-left px-3 h-8 rounded-md text-[13px] text-text-secondary hover:bg-white/6 hover:text-text-primary cursor-pointer bg-transparent border-none flex items-center gap-2";
const MENU_HEIGHT = 300; // estimated max height of the action menu

interface ChatSidebarProps {
  conversations: Conversation[];
  activeId?: string;
  /** Conversation IDs with unseen activity since the user last viewed them. */
  unreadIds?: Set<string>;
  hideProactive: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onToggleHideProactive: (hide: boolean) => void;
  onSelect: (id: string) => void;
  /** Warm the messages of a chat the pointer is about to click. */
  onPrefetch?: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, data: Partial<Pick<Conversation, "title" | "tags" | "pinned" | "pinnedAgent">>) => void;
  onLoadMore: () => void;
  isOverlay?: boolean;
  onClose?: () => void;
}

interface ActionMenuState {
  id: string;
  /** Fixed pixel coords for the portal dropdown: under the ⋯ button (right) or at the pointer (left). */
  top: number;
  right?: number;
  left?: number;
  /** True when there's not enough space below — dropdown opens upward */
  openUpward: boolean;
}


export default function ChatSidebar({
  conversations,
  activeId,
  unreadIds,
  hideProactive,
  hasMore,
  isLoadingMore,
  onToggleHideProactive,
  onSelect,
  onPrefetch,
  onNew,
  onDelete,
  onUpdate,
  onLoadMore,
  isOverlay,
  onClose,
}: ChatSidebarProps) {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Portal-based action menu — avoids overflow-auto clipping
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [pinnedFilter, setPinnedFilter] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [editingTagsId, setEditingTagsId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [allTags, setAllTags] = useState<string[]>([]);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The chat whose title Haiku is writing, or whose attempt just failed.
  const [retitle, setRetitle] = useState<{ id: string; failed?: boolean } | null>(null);

  // Fetch all unique tags for type-ahead
  useEffect(() => {
    apiFetch("/conversations/tags").then(async (res) => {
      if (res.ok) setAllTags(await res.json() as string[]);
    }).catch(() => {});
  }, []);

  // Close action menu on outside click or list scroll
  useEffect(() => {
    if (!actionMenu) return;
    const onDown = (e: MouseEvent) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setActionMenu(null);
      }
    };
    const onScroll = () => setActionMenu(null);
    document.addEventListener("mousedown", onDown);
    listRef.current?.addEventListener("scroll", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      listRef.current?.removeEventListener("scroll", onScroll);
    };
  }, [actionMenu]);

  function openActionMenu(e: React.MouseEvent<HTMLButtonElement>, id: string) {
    e.stopPropagation();
    if (actionMenu?.id === id) {
      setActionMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const openUpward = window.innerHeight - rect.bottom < MENU_HEIGHT;
    setActionMenu({
      id,
      top: openUpward ? rect.top : rect.bottom + 4,
      right: window.innerWidth - rect.right,
      openUpward,
    });
  }

  // Right-click opens the same menu at the pointer.
  function openContextMenu(e: React.MouseEvent, id: string) {
    e.preventDefault();
    const openUpward = window.innerHeight - e.clientY < MENU_HEIGHT;
    setActionMenu({ id, top: e.clientY, left: Math.min(e.clientX, window.innerWidth - 176), openUpward });
  }

  function finishRename(c: Conversation, value: string) {
    setRenamingId(null);
    const title = value.trim();
    if (title && title !== c.title) onUpdate(c.id, { title });
  }

  async function regenerateTitle(id: string) {
    setRetitle({ id });
    try {
      const res = await apiFetch(`/conversations/${id}/title`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      onUpdate(id, { title: ((await res.json()) as { title: string }).title });
      setRetitle(null);
    } catch {
      setRetitle({ id, failed: true });
      setTimeout(() => setRetitle((r) => (r?.id === id && r.failed ? null : r)), 3000);
    }
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    // An older query answering late must not overwrite results or hide the spinner of the current one.
    let stale = false;
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await apiFetch(`/conversations/search?q=${encodeURIComponent(query)}&limit=20&hideProactive=${hideProactive}`);
        if (res.ok && !stale) {
          const data = await res.json() as SearchResult[];
          if (!stale) setSearchResults(data);
        }
      } catch {
        if (!stale) setSearchResults([]);
      } finally {
        if (!stale) setSearching(false);
      }
    }, 150);

    return () => {
      stale = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [hideProactive, query]);

  const handleSelect = (id: string) => {
    onSelect(id);
    onClose?.();
  };

  const handleTogglePin = useCallback((e: React.MouseEvent, c: Conversation) => {
    e.stopPropagation();
    onUpdate(c.id, { pinned: !c.pinned });
    setActionMenu(null);
  }, [onUpdate]);

  const handleAddTag = useCallback((convId: string, tag: string) => {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv || !tag.trim()) return;
    const trimmed = tag.trim().toLowerCase();
    if (conv.tags.includes(trimmed)) return;
    onUpdate(convId, { tags: [...conv.tags, trimmed] });
    setTagInput("");
  }, [conversations, onUpdate]);

  const handleRemoveTag = useCallback((e: React.MouseEvent, convId: string, tag: string) => {
    e.stopPropagation();
    const conv = conversations.find((c) => c.id === convId);
    if (!conv) return;
    onUpdate(convId, { tags: conv.tags.filter((t) => t !== tag) });
  }, [conversations, onUpdate]);

  const handleExport = useCallback((id: string, format: "markdown" | "json") => {
    setActionMenu(null);
    downloadExport(id, format);
  }, []);

  const isSearchMode = query.trim().length > 0;

  // The projects of the loaded chats, most recently used first.
  const projectPaths = [...new Set(conversations.map((c) => c.projectPath).filter((p): p is string => !!p))];

  const filtered = conversations.filter((c) => {
    if (pinnedFilter && !c.pinned) return false;
    if (tagFilter && !c.tags.includes(tagFilter)) return false;
    if (projectFilter && c.projectPath !== projectFilter) return false;
    return true;
  });

  // Suggestions for tag input
  const tagSuggestions = tagInput.trim()
    ? allTags.filter((t) => t.includes(tagInput.trim().toLowerCase()) && !conversations.find((c) => c.id === editingTagsId)?.tags.includes(t))
    : [];

  // The active conversation's data — needed by the portal dropdown
  const actionConv = actionMenu ? conversations.find((c) => c.id === actionMenu.id) : null;

  // Portal dropdown rendered at document.body — never clipped by overflow-auto
  const dropdownPortal = actionMenu && actionConv && createPortal(
    <div
      ref={actionMenuRef}
      className="bg-glass border border-white/12 rounded-[10px] shadow-modal p-1 min-w-[160px]"
      style={{
        position: "fixed",
        zIndex: 9999,
        ...(actionMenu.left !== undefined ? { left: actionMenu.left } : { right: actionMenu.right }),
        ...(actionMenu.openUpward
          ? { bottom: window.innerHeight - actionMenu.top }
          : { top: actionMenu.top }),
      }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); setActionMenu(null); setRenamingId(actionConv.id); }}
        className={MENU_ITEM}
      >
        <Pencil size={14} strokeWidth={1.5} className="text-text-muted" />
        Rename
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); setActionMenu(null); regenerateTitle(actionConv.id); }}
        disabled={retitle?.id === actionConv.id && !retitle.failed}
        className={`${MENU_ITEM} disabled:opacity-50 disabled:cursor-default`}
      >
        <Sparkles size={14} strokeWidth={1.5} className="text-text-muted" />
        Regenerate title
      </button>
      <div className="border-t border-border my-1" />
      <button
        onClick={(e) => handleTogglePin(e, actionConv)}
        className={MENU_ITEM}
      >
        <Pin size={14} strokeWidth={1.5} className={actionConv.pinned ? "text-accent" : "text-text-muted"} />
        {actionConv.pinned ? "Unpin" : "Pin"}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setActionMenu(null);
          setEditingTagsId(actionConv.id);
          setTagInput("");
          setTimeout(() => tagInputRef.current?.focus(), 50);
        }}
        className={MENU_ITEM}
      >
        <Tag size={14} strokeWidth={1.5} className="text-text-muted" />
        Edit tags
      </button>
      <div className="border-t border-border my-1" />
      <button
        onClick={(e) => { e.stopPropagation(); handleExport(actionConv.id, "markdown"); }}
        className={MENU_ITEM}
      >
        <Download size={14} strokeWidth={1.5} className="text-text-muted" />
        Export Markdown
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); handleExport(actionConv.id, "json"); }}
        className={MENU_ITEM}
      >
        <Download size={14} strokeWidth={1.5} className="text-text-muted" />
        Export JSON
      </button>
      <div className="border-t border-border my-1" />
      <button
        onClick={(e) => {
          e.stopPropagation();
          setActionMenu(null);
          onDelete(actionConv.id);
        }}
        className="w-full text-left px-3 h-8 rounded-md text-[13px] text-error hover:bg-error/10 cursor-pointer bg-transparent border-none flex items-center gap-2"
      >
        <Trash2 size={14} strokeWidth={1.5} />
        Delete
      </button>
    </div>,
    document.body
  );

  const sidebar = (
    <div className={`${isOverlay ? "w-[280px]" : "w-[272px]"} border-r border-border flex flex-col h-full bg-surface`}>
      <div className="px-3 pt-3 pb-2 flex flex-col gap-2 border-b border-border">
        <div className="flex items-center gap-1">
          <label className="relative flex-1 min-w-0">
            <Search size={14} strokeWidth={1.5} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="w-full h-8 pl-8 pr-7 rounded-md bg-raised border border-transparent text-text-primary placeholder:text-text-muted text-[13px] outline-none transition-colors focus:border-white/14"
            />
            {searching && (
              <Loader2 size={14} strokeWidth={1.5} aria-label="Searching" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted animate-spin" />
            )}
            {query && !searching && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 flex text-text-muted hover:text-text-primary bg-transparent border-none cursor-pointer"
                aria-label="Clear search"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            )}
          </label>
          <IconButton label="New chat" onClick={() => { onNew(); onClose?.(); }} className="text-text-secondary">
            <SquarePen size={16} strokeWidth={1.5} />
          </IconButton>
        </div>
        {!isSearchMode && (
          <div className="flex items-center gap-0.5 flex-wrap">
            <FilterChip on={pinnedFilter} onClick={() => setPinnedFilter(!pinnedFilter)}>Pinned</FilterChip>
            <FilterChip
              on={!hideProactive}
              onClick={() => onToggleHideProactive(!hideProactive)}
              title={hideProactive ? "Show proactive, schedule and trigger runs" : "Hide proactive, schedule and trigger runs"}
            >
              Proactive
            </FilterChip>
            {projectPaths.map((path) => (
              <FilterChip key={path} on={projectFilter === path} onClick={() => setProjectFilter(projectFilter === path ? null : path)} title={`Only chats in ${path}`}>
                <FolderGit2 size={12} strokeWidth={1.5} className="shrink-0" />
                <span className="max-w-[7rem] truncate">{projectName(path)}</span>
              </FilterChip>
            ))}
            {allTags.map((t) => (
              <FilterChip key={t} on={tagFilter === t} onClick={() => setTagFilter(tagFilter === t ? null : t)}>{t}</FilterChip>
            ))}
            {(tagFilter || pinnedFilter || projectFilter) && (
              <button
                type="button"
                onClick={() => { setTagFilter(null); setPinnedFilter(false); setProjectFilter(null); }}
                aria-label="Clear filters"
                title="Clear filters"
                className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary cursor-pointer bg-transparent border-none"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            )}
          </div>
        )}
      </div>
      <div ref={listRef} className="flex-1 overflow-auto overscroll-contain p-2 flex flex-col gap-px">
        {isSearchMode ? (
          searchResults === null || (searching && searchResults.length === 0) ? (
            searching ? <p className="text-text-muted text-[13px] text-center mt-8" role="status">Searching…</p> : null
          ) : searchResults.length === 0 ? (
            <p className="text-text-muted text-[13px] text-center mt-8">No results</p>
          ) : (
            searchResults.map((r) => (
              <div
                key={r.conversationId}
                onClick={() => handleSelect(r.conversationId)}
                onPointerEnter={() => onPrefetch?.(r.conversationId)}
                className={`px-2.5 py-2 rounded-md cursor-pointer flex flex-col gap-0.5 transition-colors ${r.conversationId === activeId ? ROW_ACTIVE : ROW_IDLE}`}
              >
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className={`flex-1 min-w-0 truncate text-[13px] ${r.conversationId === activeId ? "text-text-primary" : "text-text-secondary"}`}>
                    {r.conversationTitle || "New conversation"}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-text-muted">{shortTimeAgo(r.updatedAt)}</span>
                </div>
                <ProjectLine path={conversations.find((c) => c.id === r.conversationId)?.projectPath} />
                {r.snippet && (
                  <div
                    className="text-xs text-text-muted line-clamp-2 leading-relaxed [&_mark]:bg-transparent [&_mark]:text-text-primary"
                    dangerouslySetInnerHTML={{ __html: r.snippet }}
                  />
                )}
              </div>
            ))
          )
        ) : (
          <>
            {filtered.map((c) => {
              const active = c.id === activeId;
              const unread = !c.running && !!unreadIds?.has(c.id);
              const needsYou = !!c.needsInput;
              const menuOpen = actionMenu?.id === c.id;
              return (
                <div key={c.id} data-chat-row onClick={() => handleSelect(c.id)} onContextMenu={(e) => openContextMenu(e, c.id)} onPointerEnter={() => onPrefetch?.(c.id)} className={`${ROW} ${active ? ROW_ACTIVE : ROW_IDLE}`}>
                  {needsYou ? (
                    <span title="Waiting for you" className={LINE}><span className="w-2 h-2 rounded-full bg-accent" /></span>
                  ) : c.running && <span title="Agent working" className={LINE}><Loader2 size={12} strokeWidth={1.5} aria-label="Agent working" className="text-text-muted animate-spin" /></span>}
                  {unread && <span title="New reply" className={LINE}><span className="w-2 h-2 rounded-full bg-text-primary" /></span>}
                  {c.pinned && <span className={LINE}><Pin size={12} strokeWidth={1.5} className="text-text-muted" aria-label="Pinned" /></span>}
                  <span className="flex-1 min-w-0 flex flex-col">
                    {renamingId === c.id ? (
                      // Uncontrolled, so Escape can put the old title back before the blur that commits.
                      <input
                        type="text"
                        defaultValue={c.title ?? ""}
                        aria-label="Chat title"
                        autoFocus
                        onFocus={(e) => e.currentTarget.select()}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => finishRename(c, e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          else if (e.key === "Escape") { e.currentTarget.value = c.title ?? ""; e.currentTarget.blur(); }
                        }}
                        className="-mx-1 px-1 h-5 rounded-sm bg-raised border border-white/14 text-text-primary text-[13px] leading-5 outline-none"
                      />
                    ) : (
                      <span className={`truncate text-[13px] leading-5 ${active || unread || needsYou ? "text-text-primary" : "text-text-secondary"} ${unread || needsYou ? "font-medium" : ""}`}>
                        {c.title || "New conversation"}
                      </span>
                    )}
                    <ProjectLine path={c.projectPath} />
                    {c.tags.length > 0 && (
                      <span className="mt-1 flex items-center gap-1 flex-wrap">
                        {c.tags.map((t) => (
                          <span key={t} className="font-mono text-xs leading-5 pl-1.5 pr-1 rounded-sm inline-flex items-center gap-0.5 bg-white/6 text-text-secondary">
                            {t}
                            <button
                              type="button"
                              // Keeps focus in the tag input, which closes on blur.
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => handleRemoveTag(e, c.id, t)}
                              className="text-inherit opacity-60 hover:opacity-100 bg-transparent border-none cursor-pointer p-0 flex"
                              aria-label={`Remove tag ${t}`}
                            >
                              <X size={12} strokeWidth={1.5} />
                            </button>
                          </span>
                        ))}
                      </span>
                    )}
                    {editingTagsId === c.id && (
                      <span className="relative mt-1.5 block" onClick={(e) => e.stopPropagation()}>
                        <input
                          ref={tagInputRef}
                          type="text"
                          value={tagInput}
                          onChange={(e) => setTagInput(e.target.value)}
                          onBlur={() => { setEditingTagsId(null); setTagInput(""); }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && tagInput.trim()) {
                              handleAddTag(c.id, tagInput);
                            } else if (e.key === "Escape") {
                              e.currentTarget.blur();
                            }
                          }}
                          placeholder="Add tag"
                          aria-label="Add tag"
                          className="w-full h-7 px-2 rounded-md bg-surface border border-white/10 text-text-primary placeholder:text-text-muted text-xs outline-none focus:border-white/20"
                          autoFocus
                        />
                        {tagSuggestions.length > 0 && (
                          <span className="absolute left-0 right-0 top-full mt-1 bg-glass border border-border rounded-md shadow-modal z-10 max-h-24 overflow-auto flex flex-col">
                            {tagSuggestions.slice(0, 5).map((s) => (
                              <button
                                key={s}
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => handleAddTag(c.id, s)}
                                className="w-full text-left px-2 py-1 text-xs text-text-secondary hover:bg-white/8 hover:text-text-primary cursor-pointer bg-transparent border-none"
                              >
                                {s}
                              </button>
                            ))}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  {/* With a mouse the time gives way to the menu on hover; on touch both stay. */}
                  {retitle?.id === c.id ? (
                    <span className={`${LINE} text-xs ${retitle.failed ? "text-error" : "text-text-muted"}`} role="status">
                      {retitle.failed ? "Failed" : <Loader2 size={12} strokeWidth={1.5} aria-label="Writing a title" className="animate-spin" />}
                    </span>
                  ) : (
                    <span className={`${LINE} font-mono text-xs text-text-muted ${menuOpen ? "[@media(hover:hover)]:hidden" : "[@media(hover:hover)]:group-hover:hidden"}`}>
                      {shortTimeAgo(c.updatedAt)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => openActionMenu(e, c.id)}
                    className={`shrink-0 -mr-1 -my-0.5 w-6 h-6 items-center justify-center rounded-sm border-none cursor-pointer transition-colors ${
                      menuOpen
                        ? "flex text-text-primary bg-white/10"
                        : "flex [@media(hover:hover)]:hidden [@media(hover:hover)]:group-hover:flex bg-transparent text-text-muted hover:text-text-primary hover:bg-white/8"
                    }`}
                    aria-label="More actions"
                    title="More actions"
                  >
                    <MoreHorizontal size={16} strokeWidth={1.5} />
                  </button>
                </div>
              );
            })}
            {filtered.length === 0 && conversations.length > 0 && (
              <p className="text-text-muted text-[13px] text-center mt-8">
                No matching conversations
              </p>
            )}
            {conversations.length === 0 && (
              <p className="text-text-muted text-[13px] text-center mt-8">
                No conversations yet
              </p>
            )}
            {hasMore && (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={isLoadingMore}
                className="mt-1 w-full h-8 rounded-md border-none bg-transparent px-2.5 text-left text-xs text-text-muted cursor-pointer transition-colors hover:bg-white/4 hover:text-text-primary disabled:opacity-50"
              >
                {isLoadingMore ? "Loading" : "Load older chats"}
              </button>
            )}
          </>
        )}
      </div>
      {dropdownPortal}
    </div>
  );

  if (isOverlay) {
    return (
      <>
        <div className="fixed inset-0 bg-black/50 z-20" onClick={onClose} />
        <div className="fixed inset-y-0 left-0 z-30" style={{ paddingTop: "calc(3rem + var(--safe-top))" }}>{sidebar}</div>
      </>
    );
  }

  return sidebar;
}

export type { Conversation };
