import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Code, Eye, FileText, Folder, MessageSquarePlus, Pencil, RotateCw, Search, X } from "lucide-react";
import Prism from "prismjs";
// Grammars for the editor; Prism's core already has markup, css and javascript. jsx and typescript come before tsx.
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-swift";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { SyntaxHighlighter } from "../../lib/syntax-highlighter";
import { apiFetch } from "../../lib/api";
import { fileLanguage, isImageFile, isMarkdownFile } from "../../lib/file-types";
import { formatFileSize } from "../../lib/attachments";
import Markdown from "../Markdown";
import CodeEditor from "../CodeEditor";
import { Button, ChoicePills, IconButton } from "../ui";

void Prism;
/** Highlighting a huge file locks the page up, so past this it shows as plain text. */
const MAX_HIGHLIGHT = 200_000;

/** Whose files: a chat's folder, a project not yet in a chat (read-only), or the whole server's home folder. */
export type FileSource = { conversation: string } | { project: string } | { scope: "server" };
type Source = FileSource;
interface Entry { name: string; path: string; type: "dir" | "file"; size?: number }
interface FileData { path: string; size: number; mtimeMs: number; writable: boolean; kind: "text" | "binary" | "large"; content?: string }

const params = (source: Source, path: string, extra: Record<string, string> = {}) => new URLSearchParams({ ...source, path, ...extra }).toString();
interface SearchHit { path: string; line?: number; text?: string }
type Selection = { path: string; line?: number };
type SearchMode = "text" | "names";
const SEARCH_MODES = [{ id: "text", label: "Text" }, { id: "names", label: "Names" }];

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

/** A GET under /api/files, refetched when `version` changes. */
function useFilesApi<T>(endpoint: "list" | "read" | "search", source: Source, path: string | null, version: number, extra?: Record<string, string>) {
  const query = path === null ? null : params(source, path, extra);
  const key = query === null ? null : `${endpoint}?${query}#${version}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    if (key === null || query === null) return;
    let cancelled = false;
    apiFetch(`/files/${endpoint}?${query}`)
      .then((res) => readJson<T>(res))
      .then((data) => !cancelled && setState({ key, data }), (err: Error) => !cancelled && setState({ key, error: err.message }));
    return () => {
      cancelled = true;
    };
    // `key` covers the source, path and version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state?.key === key ? state : null;
}

/** An object URL for an image file, revoked when it changes. Images need the login header, which <img src> cannot send. */
function useImageUrl(source: Source, path: string, version: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const query = params(source, path);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    apiFetch(`/files/raw?${query}`)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [query, version]);
  return url;
}

const ROW = "flex items-center gap-1.5 w-full min-w-0 h-7 pr-2 border-none bg-transparent text-left text-[13px] cursor-pointer rounded-sm transition-colors hover:bg-raised";

function Listing({ source, path, depth, version, selected, onSelect }: { source: Source; path: string; depth: number; version: number; selected: string | null; onSelect: (path: string) => void }) {
  const listing = useFilesApi<{ entries: Entry[] }>("list", source, path, version);
  const indent = { paddingLeft: 8 + depth * 14 };
  if (!listing) return <p className="m-0 h-7 flex items-center text-xs text-text-muted" style={indent}>Loading…</p>;
  if (listing.error) return <p className="m-0 py-1 text-xs text-error" style={indent}>{listing.error}</p>;
  return (
    <>
      {listing.data!.entries.map((entry) =>
        entry.type === "dir" ? (
          <DirRow key={entry.path} entry={entry} source={source} depth={depth} version={version} selected={selected} onSelect={onSelect} />
        ) : (
          <button
            key={entry.path}
            type="button"
            onClick={() => onSelect(entry.path)}
            style={indent}
            className={`${ROW} ${selected === entry.path ? "bg-raised text-text-primary" : "text-text-secondary"}`}
            title={entry.path}
          >
            <FileText size={14} strokeWidth={1.5} className="shrink-0 text-text-muted ml-[18px]" />
            <span className="truncate">{entry.name}</span>
          </button>
        ),
      )}
    </>
  );
}

function DirRow({ entry, source, depth, version, selected, onSelect }: { entry: Entry; source: Source; depth: number; version: number; selected: string | null; onSelect: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} style={{ paddingLeft: 8 + depth * 14 }} className={`${ROW} text-text-secondary`} title={entry.path}>
        <Chevron size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
        <Folder size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
        <span className="truncate">{entry.name}</span>
      </button>
      {open && <Listing source={source} path={entry.path} depth={depth + 1} version={version} selected={selected} onSelect={onSelect} />}
    </>
  );
}

function SearchResults({ source, query, mode, version, selected, onSelect }: { source: Source; query: string; mode: SearchMode; version: number; selected: Selection | null; onSelect: (selection: Selection) => void }) {
  const search = useFilesApi<{ hits: SearchHit[]; truncated: boolean }>("search", source, "", version, { q: query, mode });
  if (!search) return <p className="m-0 p-2 text-xs text-text-muted">Searching…</p>;
  if (search.error) return <p className="m-0 p-2 text-xs text-error">{search.error}</p>;
  const { hits, truncated } = search.data!;
  if (hits.length === 0) return <p className="m-0 p-2 text-xs text-text-muted">Nothing found.</p>;
  const byFile = new Map<string, SearchHit[]>();
  for (const hit of hits) byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), hit]);
  return (
    <div className="flex flex-col">
      {[...byFile].map(([path, fileHits]) => (
        <div key={path} className="flex flex-col">
          <button type="button" onClick={() => onSelect({ path })} title={path} className={`${ROW} pl-2 ${selected?.path === path ? "text-text-primary" : "text-text-secondary"}`}>
            <FileText size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
            <span className="truncate">{path}</span>
          </button>
          {fileHits.filter((hit) => hit.line).map((hit) => (
            <button
              key={hit.line}
              type="button"
              onClick={() => onSelect({ path, line: hit.line })}
              className={`flex items-baseline gap-2 w-full min-w-0 py-0.5 pl-7 pr-2 border-none bg-transparent text-left cursor-pointer rounded-sm transition-colors hover:bg-raised ${selected?.path === path && selected.line === hit.line ? "bg-raised" : ""}`}
            >
              <span className="shrink-0 font-mono text-[11px] text-text-muted">{hit.line}</span>
              <span className="truncate font-mono text-xs text-text-secondary">{hit.text?.trim()}</span>
            </button>
          ))}
        </div>
      ))}
      {truncated && <p className="m-0 p-2 text-xs text-text-muted">Showing the first {hits.length}. Narrow the search for the rest.</p>}
    </div>
  );
}

function FileView({ source, path, line, version, onReload, onAddToChat, onBack }: { source: Source; path: string; line?: number; version: number; onReload: () => void; onAddToChat: (path: string) => void; onBack?: () => void }) {
  const file = useFilesApi<FileData>("read", source, path, version);
  const [draft, setDraft] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMtime, setSavedMtime] = useState<number | null>(null);
  const image = isImageFile(path);
  const imageUrl = useImageUrl(source, path, version);
  const data = file?.data;
  const language = fileLanguage(path);

  // A search hit opens the file at its line: scroll it into view once the highlighted text is on screen.
  useEffect(() => {
    if (line && data?.kind === "text") document.getElementById(`files-line-${line}`)?.scrollIntoView({ block: "center" });
  }, [line, data]);

  const save = async () => {
    if (!data?.writable || draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch("/files/write", {
        method: "PUT",
        body: JSON.stringify({ ...source, path, content: draft, baseMtimeMs: savedMtime ?? data.mtimeMs }),
      });
      const result = await readJson<{ mtimeMs: number }>(res);
      setSavedMtime(result.mtimeMs);
      setDraft(null);
      onReload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const content = data?.content ?? "";
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 h-10 px-2 border-b border-border shrink-0">
        {onBack && <IconButton label="Back to files" onClick={onBack}><ArrowLeft size={14} strokeWidth={1.5} /></IconButton>}
        <span className="flex-1 min-w-0 px-1 font-mono text-xs text-text-muted truncate" title={path}>{path}</span>
        {data && <span className="hidden md:inline font-mono text-xs text-text-muted shrink-0">{formatFileSize(data.size)}</span>}
        <IconButton label="Add to chat" onClick={() => onAddToChat(path)}><MessageSquarePlus size={14} strokeWidth={1.5} /></IconButton>
        {data?.kind === "text" && isMarkdownFile(path) && draft === null && (
          <IconButton label={rendered ? "Show source" : "Show rendered"} onClick={() => setRendered((v) => !v)}>
            {rendered ? <Code size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
          </IconButton>
        )}
        {data?.kind === "text" && data.writable && draft === null && (
          <IconButton label="Edit" onClick={() => setDraft(content)}><Pencil size={14} strokeWidth={1.5} /></IconButton>
        )}
        <IconButton label="Reload" onClick={onReload}><RotateCw size={14} strokeWidth={1.5} /></IconButton>
      </div>
      {draft !== null && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <Button variant="primary" size="sm" disabled={saving || draft === content} onClick={save}>{saving ? "Saving…" : "Save"}</Button>
          <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setSaveError(null); }}>Cancel</Button>
          {saveError && <span role="alert" className="text-xs text-error truncate">{saveError}</span>}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        {!file && !image && <p className="m-0 p-4 text-[13px] text-text-muted">Loading…</p>}
        {file?.error && <p className="m-0 p-4 text-[13px] text-error">{file.error}</p>}
        {image && (imageUrl ? <img src={imageUrl} alt={path} className="block max-w-full m-4 rounded-md border border-border bg-[repeating-conic-gradient(#2a2a2c_0_25%,#1f1f21_0_50%)] bg-[length:16px_16px]" /> : null)}
        {!image && data && data.kind !== "text" && (
          <p className="m-0 p-4 text-[13px] text-text-muted">{data.kind === "large" ? `Too large to show here (${formatFileSize(data.size)}).` : `A binary file (${formatFileSize(data.size)}).`} Add it to the chat to have the agent look at it.</p>
        )}
        {data?.kind === "text" && draft !== null && (
          <div className="p-2"><CodeEditor value={draft} onChange={setDraft} language={language ?? "text"} minHeight="60vh" /></div>
        )}
        {data?.kind === "text" && draft === null && isMarkdownFile(path) && rendered && <div className="p-4 max-w-3xl"><Markdown>{content}</Markdown></div>}
        {data?.kind === "text" && draft === null && !(isMarkdownFile(path) && rendered) && (
          content.length > MAX_HIGHLIGHT ? (
            <pre className="m-0 p-4 font-mono text-xs text-text-secondary whitespace-pre">{content}</pre>
          ) : (
            <SyntaxHighlighter
              style={oneDark}
              language={language ?? "text"}
              showLineNumbers
              wrapLines
              lineProps={(n: number) => (n === line ? { id: `files-line-${n}`, className: "bg-accent/15" } : { id: `files-line-${n}` })}
              PreTag="div"
              customStyle={{ margin: 0, minHeight: "100%", background: "transparent", fontSize: "12.5px" }}
              lineNumberStyle={{ color: "var(--color-text-muted)", minWidth: "2.5em" }}
              // The theme paints the inner <code> too, which shows as a box behind every line.
              codeTagProps={{ style: { background: "transparent" } }}
            >
              {content}
            </SyntaxHighlighter>
          )
        )}
      </div>
    </div>
  );
}

/**
 * Files as a tree, and the selected one shown highlighted, rendered (images, Markdown) or in an editor. In a chat
 * it is the chat's project, relative to the folder its agents work in; on the Server page it is the home folder,
 * by absolute path. Either way "Add to chat" hands the agent a path it can open as written.
 */
export default function FilesPanel({ source, title, titleHint, readOnly = false, layout, isMobile, onAddToChat, onClose }: {
  source: FileSource;
  title: string;
  titleHint?: string;
  readOnly?: boolean;
  /** A column beside the chat, or a whole page. */
  layout: "panel" | "page";
  isMobile: boolean;
  onAddToChat: (path: string) => void;
  onClose?: () => void;
}) {
  const [selected, setSelected] = useState<Selection | null>(null);
  const [version, setVersion] = useState(0);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState<{ query: string; mode: SearchMode } | null>(null);
  const [mode, setMode] = useState<SearchMode>("text");
  const reload = () => setVersion((v) => v + 1);
  const runSearch = (nextMode = mode) => setSearch(draft.trim() ? { query: draft.trim(), mode: nextMode } : null);

  const tree = (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 h-10 px-2 border-b border-border shrink-0">
        <span className="flex-1 min-w-0 px-1 text-[13px] text-text-primary truncate" title={titleHint}>{title}</span>
        {readOnly && <span className="font-mono text-xs text-text-muted" title="Files become editable once the chat has started and has its own folder">read-only</span>}
        <IconButton label="Refresh files" onClick={reload}><RotateCw size={14} strokeWidth={1.5} /></IconButton>
        {onClose && <IconButton label="Close files" onClick={onClose}><X size={14} strokeWidth={1.5} /></IconButton>}
      </div>
      <div className="flex flex-col gap-1.5 px-2 py-2 border-b border-border shrink-0">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
        className="flex items-center gap-1.5 h-8 px-2 rounded-md bg-raised"
      >
          <Search size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (!e.target.value) setSearch(null);
            }}
            placeholder="Search files"
            aria-label="Search files"
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] text-text-primary placeholder:text-text-muted"
          />
          {search && <IconButton label="Clear search" type="button" onClick={() => { setDraft(""); setSearch(null); }}><X size={14} strokeWidth={1.5} /></IconButton>}
      </form>
      <ChoicePills options={SEARCH_MODES} value={mode} onChange={(id) => { const next = id as SearchMode; setMode(next); if (search) runSearch(next); }} />
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-1 px-1">
        {search
          ? <SearchResults source={source} query={search.query} mode={search.mode} version={version} selected={selected} onSelect={setSelected} />
          : <Listing source={source} path="" depth={0} version={version} selected={selected?.path ?? null} onSelect={(path) => setSelected({ path })} />}
      </div>
    </div>
  );
  const view = selected && <FileView key={selected.path} source={source} path={selected.path} line={selected.line} version={version} onReload={reload} onAddToChat={onAddToChat} onBack={isMobile ? () => setSelected(null) : undefined} />;
  const empty = <p className="m-0 p-4 text-[13px] text-text-muted">Pick a file to view it.</p>;

  if (isMobile) {
    const shell = layout === "panel" ? "fixed inset-x-0 bottom-0 top-[var(--chrome-top)] z-30" : "h-full";
    return <div className={`${shell} bg-surface flex flex-col`}>{view || tree}</div>;
  }
  if (layout === "page") {
    return (
      <div className="h-full flex bg-surface">
        <div className="w-72 shrink-0 border-r border-border">{tree}</div>
        <div className="flex-1 min-w-0">{view || empty}</div>
      </div>
    );
  }
  return (
    <aside className="w-[55%] min-w-[420px] max-w-[1100px] shrink-0 h-full border-l border-border bg-surface flex">
      <div className="w-52 shrink-0 border-r border-border">{tree}</div>
      <div className="flex-1 min-w-0">{view || empty}</div>
    </aside>
  );
}
