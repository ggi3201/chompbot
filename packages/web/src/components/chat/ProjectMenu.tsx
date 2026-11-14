import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, FolderDown, FolderGit2, Loader2, Search } from "lucide-react";
import type { RemoteRepo } from "@chomp/shared";
import { cloneProject, useProjects, useRemoteRepos } from "../../hooks/useProjects";
import { formatTimeAgo } from "../../lib/format";
import { isTouch } from "../../hooks/useIsMobile";

const projectName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const OPTION = "flex items-baseline gap-3 w-full min-w-0 text-left px-2.5 py-1.5 rounded-md border-none transition-colors";

function SearchField({ value, onChange, onKeyDown, placeholder, before }: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  placeholder: string;
  before?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 h-10 shrink-0 border-b border-border text-text-muted">
      {before}
      <Search size={14} strokeWidth={1.5} className="shrink-0" />
      <input
        autoFocus={!isTouch}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] text-text-primary placeholder:text-text-muted"
      />
    </div>
  );
}

/**
 * Where the chat's agents run: a git repo under ~/code on the host, or none for
 * a plain chat. It is picked before the first message and then fixed, since a
 * native CLI session stays in the directory it started in. A GitHub repo that
 * is not on the host yet can be cloned from here. By default the chat works in
 * its own git worktree, so parallel chats never edit the same checkout.
 */
export default function ProjectMenu({
  projectPath,
  locked,
  onChange,
  worktree,
  onWorktreeChange,
}: {
  projectPath: string | undefined;
  locked: boolean;
  onChange: (projectPath: string | undefined) => void;
  worktree: boolean;
  onWorktreeChange: (worktree: boolean) => void;
}) {
  const { projects, refresh } = useProjects();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"local" | "github">("local");
  const [query, setQuery] = useState("");
  const [cloning, setCloning] = useState<{ nameWithOwner: string; progress: string } | null>(null);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const remote = useRemoteRepos(open);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointer);
    return () => document.removeEventListener("pointerdown", handlePointer);
  }, [open]);

  if (locked) {
    // A plain chat has nothing to show, and a narrow row has no room for what the info panel already shows.
    if (!projectPath) return null;
    return (
      <div className="hidden @[36rem]:flex min-w-0" title={`Project: ${projectPath}. Set when the chat started.`}>
        <span className="flex items-center gap-1.5 h-7 px-2 min-w-0 max-w-[10rem] text-[13px] text-text-secondary">
          <FolderGit2 size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
          <span className="truncate">{projectName(projectPath)}</span>
        </span>
      </div>
    );
  }

  function pick(path: string | undefined) {
    onChange(path);
    setOpen(false);
  }

  function toggle() {
    setOpen((v) => !v);
    setView("local");
    setQuery("");
    setCloneError(null);
  }

  async function clone(repo: RemoteRepo) {
    if (cloning) return;
    setCloning({ nameWithOwner: repo.nameWithOwner, progress: "Starting" });
    setCloneError(null);
    try {
      const project = await cloneProject(repo.nameWithOwner, (progress) => setCloning({ nameWithOwner: repo.nameWithOwner, progress }));
      await refresh();
      pick(project.path);
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloning(null);
    }
  }

  const search = query.trim().toLowerCase();
  // "None" is a choice, not a repo: it only shows while nothing is typed.
  const options: Array<{ path: string | undefined; name: string; note: string }> = search
    ? projects.filter((p) => p.name.toLowerCase().includes(search)).map((p) => ({ path: p.path, name: p.name, note: "" }))
    : [{ path: undefined, name: "None", note: "plain chat" }, ...projects.map((p) => ({ path: p.path, name: p.name, note: "" }))];
  const remoteMatches = (remote?.repos ?? []).filter((r) => r.nameWithOwner.toLowerCase().includes(search));

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (view === "local" && options[0]) pick(options[0].path);
      if (view === "github" && remoteMatches[0]) void clone(remoteMatches[0]);
    }
  }

  return (
    <div ref={rootRef} className="shrink-0 @[36rem]:shrink min-w-0 flex">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={[cloning && `Cloning ${cloning.nameWithOwner}`, projectPath && `Project: ${projectPath}${worktree ? ", in its own worktree" : ", in the main checkout"}`].find(Boolean) || "Project: the repo the agents work in"}
        className={`flex items-center gap-1.5 h-7 px-2 min-w-0 max-w-[10rem] rounded-md border-none text-[13px] cursor-pointer transition-colors ${
          open ? "bg-raised text-text-primary" : "bg-transparent text-text-secondary hover:bg-raised hover:text-text-primary"
        }`}
      >
        {cloning ? (
          <Loader2 size={14} strokeWidth={1.5} className="shrink-0 animate-spin text-text-primary" />
        ) : (
          <FolderGit2 size={14} strokeWidth={1.5} className={`shrink-0 ${projectPath ? "text-text-primary" : "text-text-muted"}`} />
        )}
        {/* On a narrow row the icon alone says it; its color says whether a project is set. */}
        <span className="hidden @[36rem]:inline truncate">{projectPath ? projectName(projectPath) : "No project"}</span>
        <ChevronDown size={14} strokeWidth={1.5} className="hidden @[36rem]:block shrink-0 text-text-muted" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 z-30 w-full max-w-[360px] max-h-[min(420px,60vh)] rounded-lg border border-border bg-glass shadow-modal flex flex-col">
          {view === "local" ? (
            <>
              <SearchField key="local" value={query} onChange={setQuery} onKeyDown={handleKeyDown} placeholder="Search projects" />
              <div role="listbox" aria-label="Choose a project" className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-1 flex flex-col">
                {options.length === 0 && <p className="m-0 px-2.5 py-1.5 text-[13px] text-text-muted">No project matches.</p>}
                {options.map((option, index) => {
                  const selected = option.path === projectPath;
                  // Enter picks the first match, so it shows as the one under the cursor.
                  const next = !!search && index === 0;
                  return (
                    <button
                      key={option.path ?? "none"}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => pick(option.path)}
                      className={`${OPTION} cursor-pointer ${selected || next ? "bg-raised" : "bg-transparent hover:bg-raised"}`}
                    >
                      <span className="shrink-0 text-[13px] text-text-primary">{option.name}</span>
                      <span className="flex-1 min-w-0 truncate font-mono text-xs text-text-muted">{option.note}</span>
                      <span className="w-3.5 shrink-0 flex self-center text-accent-ink">{selected && <Check size={14} strokeWidth={1.5} />}</span>
                    </button>
                  );
                })}
              </div>
              {projectPath && (
                <label className={`${OPTION} shrink-0 items-center gap-2 border-t border-border rounded-none px-3.5 py-2 cursor-pointer hover:bg-raised`}>
                  <input
                    type="checkbox"
                    checked={worktree}
                    onChange={(e) => onWorktreeChange(e.target.checked)}
                    className="shrink-0 cursor-pointer"
                  />
                  <span className="shrink-0 text-[13px] text-text-primary">Own worktree</span>
                  <span className="flex-1 min-w-0 truncate text-xs text-text-muted">{worktree ? "main checkout stays untouched" : "works in the main checkout"}</span>
                </label>
              )}
              <div className="shrink-0 border-t border-border p-1">
                {remote?.unavailable ? (
                  <p className="m-0 px-2.5 py-1.5 text-xs text-text-muted">{remote.unavailable}</p>
                ) : (
                  <button
                    type="button"
                    onClick={() => setView("github")}
                    className={`${OPTION} items-center gap-2 cursor-pointer bg-transparent hover:bg-raised text-[13px] text-text-secondary hover:text-text-primary`}
                  >
                    {cloning ? <Loader2 size={14} strokeWidth={1.5} className="shrink-0 animate-spin" /> : <FolderDown size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />}
                    <span className="truncate">{cloning ? `Cloning ${cloning.nameWithOwner}` : "Clone from GitHub…"}</span>
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              {/* Its own key: a new input, so autoFocus takes the focus back from the button that opened it. */}
              <SearchField
                key="github"
                value={query}
                onChange={setQuery}
                onKeyDown={handleKeyDown}
                placeholder="Search GitHub repos"
                before={
                  <button
                    type="button"
                    onClick={() => setView("local")}
                    aria-label="Back to projects"
                    className="-ml-1.5 shrink-0 flex items-center justify-center w-6 h-6 rounded-md border-none bg-transparent text-text-muted cursor-pointer hover:bg-raised hover:text-text-primary"
                  >
                    <ChevronLeft size={14} strokeWidth={1.5} />
                  </button>
                }
              />
              <div role="listbox" aria-label="Clone a GitHub repo" className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-1 flex flex-col">
                {cloneError && <p className="m-0 px-2.5 py-1.5 text-xs text-error">{cloneError}</p>}
                {remote === null && <p className="m-0 px-2.5 py-1.5 text-[13px] text-text-muted">Loading repos…</p>}
                {remote?.unavailable && <p className="m-0 px-2.5 py-1.5 text-xs text-text-muted">{remote.unavailable}</p>}
                {remote && !remote.unavailable && remoteMatches.length === 0 && (
                  <p className="m-0 px-2.5 py-1.5 text-[13px] text-text-muted">{search ? "No repo matches." : "Every repo is cloned already."}</p>
                )}
                {remoteMatches.map((repo, index) => {
                  const [owner, name] = repo.nameWithOwner.split("/");
                  const busy = cloning?.nameWithOwner === repo.nameWithOwner;
                  const next = !!search && index === 0 && !cloning;
                  return (
                    <button
                      key={repo.nameWithOwner}
                      type="button"
                      role="option"
                      aria-selected={busy}
                      disabled={!!cloning}
                      onClick={() => void clone(repo)}
                      title={`Clone ${repo.nameWithOwner} into ~/code/${name}`}
                      className={`${OPTION} flex-col items-stretch gap-0.5 ${busy || next ? "bg-raised" : "bg-transparent"} ${
                        cloning ? `cursor-default ${busy ? "" : "opacity-40"}` : "cursor-pointer hover:bg-raised"
                      }`}
                    >
                      <span className="flex items-baseline gap-2 min-w-0">
                        <span className="min-w-0 truncate text-[13px] text-text-primary">{name}</span>
                        <span className="shrink-0 font-mono text-xs text-text-muted">{owner}</span>
                        <span className="ml-auto shrink-0 font-mono text-xs text-text-muted">{formatTimeAgo(repo.pushedAt)}</span>
                      </span>
                      {busy ? (
                        <span className="flex items-center gap-1.5 min-w-0 text-xs text-text-secondary">
                          <Loader2 size={12} strokeWidth={1.5} className="shrink-0 animate-spin" />
                          <span className="truncate font-mono">{cloning.progress}</span>
                        </span>
                      ) : (
                        repo.description && <span className="truncate text-xs text-text-muted">{repo.description}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
