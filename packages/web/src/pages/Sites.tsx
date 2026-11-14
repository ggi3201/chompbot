import { useMemo, useState } from "react";
import { useCrud } from "../hooks/useCrud";
import FormModal from "../components/FormModal";
import CodeEditor from "../components/CodeEditor";
import { PageHeader, Button, FilterPill, Input, Switch } from "../components/ui";
import { apiFetch } from "../lib/api";
import { formatDate, formatTimeAgo } from "../lib/format";
import { Check, ChevronRight, Copy, GitBranch, Lock, Plus, Search, X } from "lucide-react";

type SiteGitInfo =
  | { tracked: false }
  | {
      tracked: true;
      remoteUrl: string | null;
      branch: string;
      dirty: boolean;
      ahead: number;
      behind: number;
      lastCommit: { sha: string; subject: string; date: string } | null;
    };

interface Site {
  id: string;
  slug: string;
  title: string;
  description: string;
  htmlContent: string;
  status: string;
  source: "db" | "git";
  password: string | null;
  url: string | null;
  repoUrl: string | null;
  repoBranch: string;
  lastCommitSha: string | null;
  sourceUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  git?: SiteGitInfo;
}

const isLive = (s: Site) => s.status === "published";
const EMPTY_FORM = { title: "", slug: "", description: "", htmlContent: "", password: "" };
const meta = "font-mono text-xs text-text-muted tabular-nums";

function displayUrl(site: Site): string {
  return site.url ? site.url.replace(/^https?:\/\//, "") : `/${site.slug}`;
}

function gitSummary(git: SiteGitInfo | undefined): string | null {
  if (!git?.tracked) return null;
  const bits = [git.remoteUrl ? git.remoteUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "") : "local only", git.branch];
  if (git.dirty) bits.push("uncommitted changes");
  if (git.ahead) bits.push(`${git.ahead} ahead`);
  if (git.behind) bits.push(`${git.behind} behind`);
  if (!git.dirty && !git.ahead && !git.behind) bits.push("clean");
  return bits.join(" · ");
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text-secondary min-w-0 break-words">{children}</dd>
    </>
  );
}

interface SiteRowProps {
  site: Site;
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggleLive: (live: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onQr: () => void;
  onTrack: () => void;
  onUntrack: () => void;
}

function SiteRow({ site, open, busy, onOpen, onToggleLive, onEdit, onDelete, onQr, onTrack, onUntrack }: SiteRowProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const live = site.status === "published";
  const git = site.git;
  const when = live && site.publishedAt ? `Live ${formatTimeAgo(site.publishedAt)}` : `Edited ${formatTimeAgo(site.updatedAt)}`;

  async function copyUrl() {
    if (!site.url) return;
    try {
      await navigator.clipboard.writeText(site.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard needs a secure context; the link is still selectable
    }
  }

  return (
    <div className={`border-b border-border last:border-b-0 ${open ? "bg-white/2" : ""}`}>
      <div className="flex items-center gap-3 pl-4 pr-2">
        <Switch on={live} disabled={busy} label={`${live ? "Unpublish" : "Publish"} ${site.title}`} onChange={onToggleLive} />
        <button
          type="button"
          onClick={onOpen}
          aria-expanded={open}
          className="flex-1 min-w-0 flex items-center gap-3 py-3 pr-2 text-left cursor-pointer"
        >
          <div className="min-w-0 flex-1">
            <p className={`text-sm line-clamp-2 sm:line-clamp-1 ${live ? "text-text-primary" : "text-text-secondary"}`}>{site.title}</p>
            {!open && <p className="mt-0.5 font-mono text-xs text-text-muted truncate">{displayUrl(site)}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0 text-text-muted">
            {site.password && <span role="img" aria-label="Password protected" title="Password protected"><Lock size={14} strokeWidth={1.5} /></span>}
            {git?.tracked && <span role="img" aria-label="Tracked in git" title="Tracked in git"><GitBranch size={14} strokeWidth={1.5} /></span>}
            <span className="hidden sm:inline text-xs">{when}</span>
          </div>
          <ChevronRight size={16} strokeWidth={1.5} className={`shrink-0 text-text-muted transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        </button>
      </div>

      {open && (
        <div className="pl-[64px] pr-4 pb-4 flex flex-col gap-4">
          <dl className="grid grid-cols-[72px_1fr] gap-x-4 gap-y-1.5 text-[13px] leading-relaxed">
            <Fact label="Address">
              {site.url ? (
                <span className="inline-flex items-center gap-2 max-w-full">
                  <a href={site.url} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-text-secondary underline decoration-white/24 underline-offset-2 hover:text-text-primary hover:decoration-white/60 break-all">
                    {displayUrl(site)}
                  </a>
                  <button type="button" onClick={copyUrl} aria-label="Copy address" className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md text-text-muted hover:text-text-primary hover:bg-white/4 cursor-pointer">
                    {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
                  </button>
                </span>
              ) : (
                <span className="text-text-muted">Not published. Slug <span className="font-mono text-xs">/{site.slug}</span></span>
              )}
            </Fact>
            <Fact label="Access">{site.password ? "Password protected" : "Public"}</Fact>
            {site.description && <Fact label="About">{site.description}</Fact>}
            <Fact label="Source">
              {site.source === "git" ? (
                <>Git repo{site.repoUrl ? <>, <a href={site.repoUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-white/24 underline-offset-2 hover:text-text-primary">{site.repoUrl.replace(/^https?:\/\/github\.com\//, "")}</a></> : null}</>
              ) : (
                "Stored in Chomp"
              )}
            </Fact>
            {gitSummary(git) && <Fact label="Git"><span className="font-mono text-xs">{gitSummary(git)}</span></Fact>}
            {git?.tracked && git.lastCommit && (
              <Fact label="Last commit">
                <span className="font-mono text-xs">{git.lastCommit.sha.slice(0, 7)}</span> {git.lastCommit.subject}
                <span className={`ml-2 ${meta}`}>{formatTimeAgo(git.lastCommit.date)}</span>
              </Fact>
            )}
            <Fact label="Updated"><span className={meta}>{formatDate(site.updatedAt)}</span></Fact>
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onEdit}>Edit</Button>
            {site.url && <Button size="sm" variant="outline" onClick={() => window.open(site.url!, "_blank", "noopener")}>Open</Button>}
            {site.url && <Button size="sm" variant="outline" onClick={onQr}>QR code</Button>}
            {git?.tracked ? (
              <Button size="sm" variant="outline" onClick={onUntrack}>Untrack git</Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onTrack}>Track in git</Button>
            )}
            <div className="ml-auto flex gap-2">
              {confirmDelete ? (
                <>
                  <Button size="sm" variant="danger" onClick={() => { setConfirmDelete(false); onDelete(); }}>Delete site</Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)}>Delete</Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Sites() {
  const { items, loading, error, create, update, remove, refresh, setError } = useCrud<Site>("/sites");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Site | null>(null);
  const [qrModal, setQrModal] = useState<Site | null>(null);
  const [gitModal, setGitModal] = useState<Site | null>(null);
  const [gitForm, setGitForm] = useState({ repoName: "", private: true, inviteCollaborator: "" });
  const [form, setForm] = useState(EMPTY_FORM);
  const [htmlView, setHtmlView] = useState<"code" | "preview">("code");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "live" | "draft">("all");

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setHtmlView("code");
    setShowForm(true);
  }

  function openEdit(site: Site) {
    setEditing(site);
    setForm({
      title: site.title,
      slug: site.slug,
      description: site.description,
      htmlContent: site.htmlContent,
      password: site.password ?? "",
    });
    setHtmlView("code");
    setShowForm(true);
  }

  async function handleSubmit() {
    if (!form.title || !form.htmlContent) {
      setError("Title and HTML content are required");
      return;
    }
    const body = {
      title: form.title,
      slug: form.slug || undefined,
      description: form.description,
      htmlContent: form.htmlContent,
      password: form.password || null,
    };
    try {
      if (editing) await update(editing.id, body);
      else await create(body);
      setShowForm(false);
    } catch {
      setError("Failed to save site");
    }
  }

  async function post(path: string, body: unknown, failure: string): Promise<boolean> {
    try {
      const res = await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? failure);
        return false;
      }
      return true;
    } catch {
      setError(failure);
      return false;
    }
  }

  async function setLive(site: Site, live: boolean) {
    setBusyId(site.id);
    const ok = await post(`/sites/${site.id}/${live ? "publish" : "unpublish"}`, {}, live ? "Publish failed" : "Unpublish failed");
    if (ok) await refresh();
    setBusyId(null);
  }

  function openGitModal(site: Site) {
    setGitModal(site);
    setGitForm({ repoName: site.slug, private: true, inviteCollaborator: "" });
  }

  async function handleTrackGit() {
    if (!gitModal) return;
    const ok = await post(
      `/sites/${gitModal.id}/git/track`,
      { repoName: gitForm.repoName || undefined, private: gitForm.private, inviteCollaborator: gitForm.inviteCollaborator || null },
      "Git tracking failed",
    );
    if (!ok) return;
    setGitModal(null);
    refresh();
  }

  async function handleUntrackGit(site: Site) {
    if (await post(`/sites/${site.id}/git/untrack`, { deleteRemote: false }, "Git untrack failed")) refresh();
  }

  const q = query.trim().toLowerCase();
  const counts = { all: items.length, live: items.filter(isLive).length, draft: items.filter((s) => !isLive(s)).length };
  const matches = useMemo(
    () =>
      items
        .filter((s) => !q || `${s.title} ${s.slug} ${s.description}`.toLowerCase().includes(q))
        .filter((s) => filter === "all" || (filter === "live" ? isLive(s) : !isLive(s)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [items, q, filter],
  );
  const live = matches.filter(isLive);
  const drafts = matches.filter((s) => !isLive(s));

  function rowFor(site: Site) {
    return (
      <SiteRow
        key={site.id}
        site={site}
        open={openId === site.id}
        busy={busyId === site.id}
        onOpen={() => setOpenId(openId === site.id ? null : site.id)}
        onToggleLive={(on) => setLive(site, on)}
        onEdit={() => openEdit(site)}
        onDelete={() => { setOpenId(null); remove(site.id); }}
        onQr={() => setQrModal(site)}
        onTrack={() => openGitModal(site)}
        onUntrack={() => handleUntrackGit(site)}
      />
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 flex flex-col gap-4">
      <PageHeader
        title="Sites"
        action={
          <Button onClick={openCreate}>
            <Plus size={16} strokeWidth={1.5} />
            New site
          </Button>
        }
      />

      {error && (
        <div className="flex items-center justify-between gap-2 pl-3 pr-1 py-1 rounded-md border border-border bg-glass text-[13px] text-error">
          {error}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setError(null)}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-transparent border-none text-text-muted cursor-pointer transition-colors hover:bg-white/4 hover:text-text-primary"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <p className="text-[13px] text-text-muted py-8">Loading sites</p>
      ) : items.length === 0 ? (
        <div className="py-12 flex flex-col items-start gap-3">
          <p className="text-sm text-text-secondary">No sites yet.</p>
          <p className="text-[13px] text-text-muted max-w-md leading-relaxed">A site is a single HTML page Chomp serves under your configured preview domain. Paste the HTML, or ask an agent to build one and publish it.</p>
          <Button variant="primary" onClick={openCreate}>Create the first site</Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search size={16} strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <Input
                value={query}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                placeholder="Search sites"
                aria-label="Search sites"
                className="w-full pl-9 h-9"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {([["all", "All"], ["live", "Live"], ["draft", "Drafts"]] as const).map(([key, label]) => (
                <FilterPill key={key} active={filter === key} onClick={() => setFilter(key)}>
                  {label} <span className="font-mono tabular-nums text-text-muted">{counts[key]}</span>
                </FilterPill>
              ))}
            </div>
          </div>

          {matches.length === 0 && (
            <div className="py-10 flex flex-col items-start gap-2">
              <p className="text-sm text-text-secondary">No sites match.</p>
              <Button variant="outline" size="sm" onClick={() => { setQuery(""); setFilter("all"); }}>Clear search and filters</Button>
            </div>
          )}

          {live.length > 0 && (
            <section className="bg-glass rounded-lg border border-border overflow-hidden">
              <h3 className="px-4 h-9 flex items-center text-xs font-medium text-text-muted border-b border-border">
                Live <span className="ml-1.5 font-mono tabular-nums">{live.length}</span>
              </h3>
              {live.map(rowFor)}
            </section>
          )}

          {drafts.length > 0 && (
            <section className="bg-glass rounded-lg border border-border overflow-hidden">
              <h3 className="px-4 h-9 flex items-center text-xs font-medium text-text-muted border-b border-border">
                Drafts <span className="ml-1.5 font-mono tabular-nums">{drafts.length}</span>
              </h3>
              {drafts.map(rowFor)}
            </section>
          )}
        </>
      )}

      {/* Create/Edit modal */}
      <FormModal title={editing ? "Edit site" : "New site"} open={showForm} onClose={() => setShowForm(false)} onSubmit={handleSubmit} wide>
        <div className="flex flex-col gap-1">
          <label htmlFor="site-title" className="text-xs font-medium text-text-secondary">Title</label>
          <Input id="site-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="site-slug" className="text-xs font-medium text-text-secondary">
            Slug <span className="font-normal text-text-muted">(generated if empty)</span>
          </label>
          <Input id="site-slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="my-cool-site" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="site-description" className="text-xs font-medium text-text-secondary">Description</label>
          <Input id="site-description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional description" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="site-password" className="text-xs font-medium text-text-secondary">
            Password <span className="font-normal text-text-muted">(leave empty for public)</span>
          </label>
          <Input id="site-password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Optional password" />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="site-html" className="text-xs font-medium text-text-secondary">HTML content</label>
            <div className="flex gap-1.5">
              <FilterPill active={htmlView === "code"} onClick={() => setHtmlView("code")}>Code</FilterPill>
              <FilterPill active={htmlView === "preview"} onClick={() => setHtmlView("preview")}>Preview</FilterPill>
            </div>
          </div>
          {htmlView === "code" ? (
            <CodeEditor id="site-html" language="html" minHeight="260px" maxHeight="50dvh" value={form.htmlContent} onChange={(v) => setForm({ ...form, htmlContent: v })} placeholder="<!DOCTYPE html>" />
          ) : (
            // allow-scripts without allow-same-origin: the page runs, but cannot touch Chomp's token or storage.
            <iframe title="Site preview" sandbox="allow-scripts" srcDoc={form.htmlContent} className="w-full h-[50dvh] min-h-[260px] rounded-md border border-border bg-white" />
          )}
        </div>
      </FormModal>

      {/* QR Code modal */}
      {qrModal && qrModal.url && (
        <dialog
          ref={(el) => el?.showModal()}
          onClose={() => setQrModal(null)}
          className="border border-white/12 md:max-w-[400px] w-full md:w-[90vw] rounded-xl m-auto p-0 bg-glass text-text-primary shadow-modal"
        >
          <div className="flex flex-col items-center gap-4 p-6">
            <h3 className="m-0 text-[17px] font-medium text-text-primary">{qrModal.title}</h3>
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrModal.url)}&bgcolor=19191b&color=ededed`}
              alt="QR code"
              className="rounded-lg"
              width={250}
              height={250}
            />
            <a
              href={qrModal.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-text-secondary underline decoration-white/24 underline-offset-2 transition-colors hover:text-text-primary hover:decoration-white/60 break-all"
            >
              {qrModal.url}
            </a>
            <Button variant="outline" size="sm" onClick={() => setQrModal(null)}>Close</Button>
          </div>
        </dialog>
      )}

      {gitModal && (
        <dialog
          ref={(el) => el?.showModal()}
          onClose={() => setGitModal(null)}
          className="border border-white/12 md:max-w-[440px] w-full md:w-[90vw] rounded-xl m-auto p-0 bg-glass text-text-primary shadow-modal"
        >
          <div className="flex flex-col gap-4 p-6">
            <h3 className="m-0 text-[17px] font-medium text-text-primary">Track {gitModal.title}</h3>
            <div className="flex flex-col gap-1">
              <label htmlFor="git-repo" className="text-xs font-medium text-text-secondary">Repository name</label>
              <Input id="git-repo" value={gitForm.repoName} onChange={(e) => setGitForm({ ...gitForm, repoName: e.target.value })} />
            </div>
            <label className="inline-flex items-center gap-2 text-[13px] text-text-secondary">
              <input type="checkbox" className="accent-accent" checked={gitForm.private} onChange={(e) => setGitForm({ ...gitForm, private: e.target.checked })} />
              Private GitHub repository
            </label>
            <div className="flex flex-col gap-1">
              <label htmlFor="git-invite" className="text-xs font-medium text-text-secondary">Invite collaborator</label>
              <Input id="git-invite" value={gitForm.inviteCollaborator} onChange={(e) => setGitForm({ ...gitForm, inviteCollaborator: e.target.value })} placeholder="GitHub username (optional)" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setGitModal(null)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={handleTrackGit}>Track</Button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}
