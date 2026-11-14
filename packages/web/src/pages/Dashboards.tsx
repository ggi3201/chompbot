import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { LayoutGrid, Plus, Trash2, ChevronUp, ChevronDown, Minus, Pencil, RefreshCw, Settings as SettingsIcon, Loader2, Star } from "lucide-react";
import { apiFetch } from "../lib/api";
import { Button, PageHeader, Input, LiveDot, IconButton } from "../components/ui";
import FormModal from "../components/FormModal";
import CanvasRenderer from "../components/canvas/CanvasRenderer";
import RefresherEditorModal from "../components/RefresherEditorModal";
import type { CanvasBlock } from "../lib/canvas-parser";
import { formatTimeAgo } from "../lib/format";

interface DashboardSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  autoRefreshEnabled: boolean;
  widgetCount: number;
}

interface Widget {
  id: string;
  dashboardId: string;
  title: string;
  blocks: CanvasBlock[];
  sourceMessageId: string | null;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  refresherKind: string | null;
  refresherPayload: string | null;
  schemaJson: string | null;
  lastRefreshedAt: string | null;
  refreshIntervalMinutes: number | null;
  classifying: boolean;
  lastClassifyError: string | null;
  createdAt: string;
}

interface DashboardDetail extends DashboardSummary {
  widgets: Widget[];
}

const MAX_W = 3;

// The widget grid is `grid-cols-3`, one column per step of MAX_W.
const COLUMN_SPAN: Record<number, string> = {
  1: "col-span-1",
  2: "col-span-2",
  3: "col-span-3",
};

export default function Dashboards() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [active, setActive] = useState<DashboardDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingActive, setLoadingActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", description: "" });
  const [renameForm, setRenameForm] = useState({ name: "", description: "" });
  const [editingRefresher, setEditingRefresher] = useState<Widget | null>(null);
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [refreshNote, setRefreshNote] = useState<Record<string, string | null>>({});
  const pollTimerRef = useRef<number | null>(null);

  const slug = searchParams.get("slug");

  const loadDashboards = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await apiFetch("/dashboards");
      if (!res.ok) throw new Error("Failed to load dashboards");
      const data = (await res.json()) as DashboardSummary[];
      setDashboards(data);
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
      return [];
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadActive = useCallback(async (id: string) => {
    setLoadingActive(true);
    try {
      const res = await apiFetch(`/dashboards/${id}`);
      if (!res.ok) throw new Error("Failed to load dashboard");
      const data = (await res.json()) as DashboardDetail;
      setActive(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoadingActive(false);
    }
  }, []);

  // Initial list load.
  useEffect(() => {
    loadDashboards();
  }, [loadDashboards]);

  // Poll while any widget on the active dashboard is mid-classification.
  useEffect(() => {
    const anyClassifying = active?.widgets.some((w) => w.classifying) ?? false;
    if (!anyClassifying || !active) {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    if (pollTimerRef.current !== null) return;
    const id = active.id;
    pollTimerRef.current = window.setInterval(() => {
      loadActive(id);
    }, 3000);
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [active, loadActive]);

  // Pick an active dashboard once the list is known.
  useEffect(() => {
    if (loadingList) return;
    const target = slug
      ? dashboards.find((d) => d.slug === slug)
      : dashboards[0];
    if (!target) {
      setActive(null);
      return;
    }
    if (!slug) {
      setSearchParams({ slug: target.slug }, { replace: true });
      return;
    }
    if (active?.id !== target.id) {
      loadActive(target.id);
    }
  }, [slug, loadingList, dashboards, active?.id, loadActive, setSearchParams]);

  async function createDashboard() {
    if (!createForm.name.trim()) {
      setError("Name is required");
      return;
    }
    const res = await apiFetch("/dashboards", {
      method: "POST",
      body: JSON.stringify({ name: createForm.name.trim(), description: createForm.description.trim() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Create failed" }));
      setError(err.error ?? "Create failed");
      return;
    }
    const created = (await res.json()) as DashboardSummary;
    setShowCreate(false);
    setCreateForm({ name: "", description: "" });
    await loadDashboards();
    setSearchParams({ slug: created.slug }, { replace: true });
  }

  async function renameDashboard() {
    if (!active) return;
    const res = await apiFetch(`/dashboards/${active.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: renameForm.name.trim(), description: renameForm.description.trim() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Rename failed" }));
      setError(err.error ?? "Rename failed");
      return;
    }
    setShowRename(false);
    await loadDashboards();
    await loadActive(active.id);
  }

  async function toggleDashboardAutoRefresh() {
    if (!active) return;
    const next = !active.autoRefreshEnabled;
    const res = await apiFetch(`/dashboards/${active.id}`, {
      method: "PUT",
      body: JSON.stringify({ autoRefreshEnabled: next }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Toggle failed" }));
      setError(err.error ?? "Toggle failed");
      return;
    }
    setActive({ ...active, autoRefreshEnabled: next });
    await loadDashboards();
  }

  async function deleteDashboard() {
    if (!active) return;
    if (!confirm(`Delete board "${active.name}" and all its widgets?`)) return;
    const res = await apiFetch(`/dashboards/${active.id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      setError("Delete failed");
      return;
    }
    setActive(null);
    setSearchParams({}, { replace: true });
    await loadDashboards();
  }

  async function deleteWidget(widget: Widget) {
    if (!active) return;
    const res = await apiFetch(`/widgets/${widget.id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      setError("Delete failed");
      return;
    }
    await loadActive(active.id);
    await loadDashboards();
  }

  // Persist a layout change (ordering + width).
  async function persistLayout(rows: { id: string; x?: number; y?: number; w?: number; h?: number }[]) {
    if (!active) return;
    await apiFetch(`/dashboards/${active.id}/layout`, {
      method: "PATCH",
      body: JSON.stringify(rows),
    });
  }

  async function moveWidget(widget: Widget, direction: -1 | 1) {
    if (!active) return;
    const sorted = [...active.widgets].sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX);
    const idx = sorted.findIndex((w) => w.id === widget.id);
    const swapIdx = idx + direction;
    if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;
    const a = sorted[idx];
    const b = sorted[swapIdx];
    const updates = [
      { id: a.id, y: b.gridY, x: b.gridX },
      { id: b.id, y: a.gridY, x: a.gridX },
    ];
    setActive({
      ...active,
      widgets: active.widgets.map((w) => {
        if (w.id === a.id) return { ...w, gridY: b.gridY, gridX: b.gridX };
        if (w.id === b.id) return { ...w, gridY: a.gridY, gridX: a.gridX };
        return w;
      }),
    });
    await persistLayout(updates);
  }

  async function resizeWidget(widget: Widget, delta: -1 | 1) {
    const nextW = Math.max(1, Math.min(MAX_W, widget.gridW + delta));
    if (nextW === widget.gridW || !active) return;
    setActive({
      ...active,
      widgets: active.widgets.map((w) => (w.id === widget.id ? { ...w, gridW: nextW } : w)),
    });
    await persistLayout([{ id: widget.id, w: nextW }]);
  }

  async function refreshWidget(widget: Widget) {
    if (!active) return;
    setRefreshing((s) => ({ ...s, [widget.id]: true }));
    setRefreshNote((n) => ({ ...n, [widget.id]: null }));
    try {
      const res = await apiFetch(`/widgets/${widget.id}/refresh`, { method: "POST" });
      if (res.status === 422) {
        const err = await res.json().catch(() => ({ detail: "Schema mismatch" }));
        setRefreshNote((n) => ({ ...n, [widget.id]: err.detail ?? err.error ?? "Schema mismatch" }));
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Refresh failed" }));
        setRefreshNote((n) => ({ ...n, [widget.id]: err.error ?? "Refresh failed" }));
        return;
      }
      const updated = (await res.json()) as Widget;
      setActive({
        ...active,
        widgets: active.widgets.map((w) => (w.id === updated.id ? updated : w)),
      });
    } finally {
      setRefreshing((s) => ({ ...s, [widget.id]: false }));
    }
  }

  function openRefresherEditor(widget: Widget) {
    setEditingRefresher(widget);
  }

  async function reclassifyWidget(widget: Widget) {
    if (!active) return;
    await apiFetch(`/widgets/${widget.id}/classify`, { method: "POST" });
    await loadActive(active.id);
  }

  const sortedWidgets = useMemo(() => {
    if (!active) return [];
    return [...active.widgets].sort(
      (a, b) => a.gridY - b.gridY || a.gridX - b.gridX || a.createdAt.localeCompare(b.createdAt),
    );
  }, [active]);

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-hidden">
      <PageHeader
        title="Boards"
        action={
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setCreateForm({ name: "", description: "" });
              setShowCreate(true);
            }}
          >
            <Plus size={16} strokeWidth={1.5} /> New board
          </Button>
        }
      />

      {error && (
        <div className="text-error text-[13px] border border-error/25 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex-1 flex flex-col md:flex-row gap-6 min-h-0">
        {/* Mobile-only board picker — same URL param drives both this and the desktop list */}
        <div className="md:hidden flex items-center gap-2">
          {dashboards.length > 0 ? (
            <Input
              as="select"
              className="flex-1"
              value={active?.slug ?? ""}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v === "__new__") {
                  setCreateForm({ name: "", description: "" });
                  setShowCreate(true);
                  // Reset to active so the select doesn't stay on the sentinel.
                  (e.target as HTMLSelectElement).value = active?.slug ?? "";
                  return;
                }
                if (v) setSearchParams({ slug: v }, { replace: true });
              }}
            >
              {dashboards.map((d) => (
                <option key={d.id} value={d.slug}>
                  {d.name} ({d.widgetCount})
                </option>
              ))}
              <option value="__new__">New board</option>
            </Input>
          ) : (
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                setCreateForm({ name: "", description: "" });
                setShowCreate(true);
              }}
              className="flex-1"
            >
              <Plus size={16} strokeWidth={1.5} /> Create your first board
            </Button>
          )}
        </div>

        {/* Desktop board list */}
        <aside className="hidden md:flex flex-col gap-0.5 w-56 shrink-0 overflow-y-auto">
          {loadingList && <div className="text-text-muted text-[13px] px-2 py-1.5">Loading boards</div>}
          {!loadingList && dashboards.length === 0 && (
            <div className="text-text-muted text-[13px] px-2 py-1.5">No boards yet</div>
          )}
          {!loadingList &&
            dashboards.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setSearchParams({ slug: d.slug }, { replace: true })}
                className={`w-full flex items-center gap-2.5 h-8 px-2 rounded-md border-none text-left text-sm cursor-pointer transition-colors ${
                  active?.id === d.id
                    ? "bg-raised text-text-primary"
                    : "bg-transparent text-text-secondary hover:bg-white/4 hover:text-text-primary"
                }`}
              >
                <LayoutGrid size={16} strokeWidth={1.5} className="shrink-0 text-text-muted" />
                <span className="truncate">{d.name}</span>
                <span className="ml-auto flex items-center gap-2 font-mono text-xs text-text-muted tabular-nums">
                  {d.autoRefreshEnabled && <LiveDot />}
                  {d.widgetCount}
                </span>
              </button>
            ))}
        </aside>

        {/* Active board */}
        <main className="flex-1 min-w-0 overflow-y-auto">
          {!active && !loadingActive && dashboards.length === 0 && (
            <EmptyState onCreate={() => setShowCreate(true)} />
          )}
          {!active && !loadingActive && dashboards.length > 0 && (
            <div className="text-text-muted text-[13px] py-6">Select a board</div>
          )}
          {loadingActive && <div className="text-text-muted text-[13px] py-6">Loading board</div>}
          {active && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-lg leading-tight font-medium text-text-primary">{active.name}</h3>
                  {active.description && <p className="text-[13px] text-text-muted mt-1">{active.description}</p>}
                </div>
                <div className="flex gap-2 items-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={toggleDashboardAutoRefresh}
                    aria-pressed={active.autoRefreshEnabled}
                    title={
                      active.autoRefreshEnabled
                        ? "Auto-refresh is on. Widgets with an interval refresh on their own"
                        : "Auto-refresh is off. Widgets refresh only when you press refresh"
                    }
                  >
                    <LiveDot live={active.autoRefreshEnabled} />
                    Auto-refresh {active.autoRefreshEnabled ? "on" : "off"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRenameForm({ name: active.name, description: active.description });
                      setShowRename(true);
                    }}
                  >
                    <Pencil size={16} strokeWidth={1.5} /> Rename
                  </Button>
                  <Button variant="outline" size="sm" onClick={deleteDashboard}>
                    <Trash2 size={16} strokeWidth={1.5} /> Delete
                  </Button>
                </div>
              </div>

              {sortedWidgets.length === 0 ? (
                <WidgetEmptyState />
              ) : (
                <div className="grid grid-cols-3 gap-4">
                  {sortedWidgets.map((w, i) => (
                    <article
                      key={w.id}
                      className={`group flex flex-col gap-2 min-w-0 ${COLUMN_SPAN[Math.min(w.gridW, MAX_W)] ?? "col-span-1"}`}
                    >
                      <header className="flex items-start justify-between gap-2">
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <h4 className="text-sm font-medium text-text-primary truncate">{w.title}</h4>
                          <WidgetStatus widget={w} dashboardAutoRefresh={active.autoRefreshEnabled} />
                        </div>
                        <div className="flex items-center shrink-0 transition-opacity [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                          <IconButton
                            label={w.refresherKind ? "Refresh" : "No refresher configured"}
                            onClick={() => refreshWidget(w)}
                            disabled={!w.refresherKind || refreshing[w.id]}
                          >
                            {refreshing[w.id] ? (
                              <Loader2 size={16} strokeWidth={1.5} className="animate-spin" />
                            ) : (
                              <RefreshCw size={16} strokeWidth={1.5} />
                            )}
                          </IconButton>
                          <IconButton label="Refresh settings" onClick={() => openRefresherEditor(w)}>
                            <SettingsIcon size={16} strokeWidth={1.5} />
                          </IconButton>
                          <IconButton label="Move up" onClick={() => moveWidget(w, -1)} disabled={i === 0}>
                            <ChevronUp size={16} strokeWidth={1.5} />
                          </IconButton>
                          <IconButton
                            label="Move down"
                            onClick={() => moveWidget(w, 1)}
                            disabled={i === sortedWidgets.length - 1}
                          >
                            <ChevronDown size={16} strokeWidth={1.5} />
                          </IconButton>
                          <IconButton label="Narrower" onClick={() => resizeWidget(w, -1)} disabled={w.gridW <= 1}>
                            <Minus size={16} strokeWidth={1.5} />
                          </IconButton>
                          <IconButton label="Wider" onClick={() => resizeWidget(w, 1)} disabled={w.gridW >= MAX_W}>
                            <Plus size={16} strokeWidth={1.5} />
                          </IconButton>
                          <IconButton label="Delete widget" tone="danger" onClick={() => deleteWidget(w)}>
                            <Trash2 size={16} strokeWidth={1.5} />
                          </IconButton>
                        </div>
                      </header>
                      {w.blocks.length > 0 ? (
                        <div className="flex flex-col gap-2 min-w-0">
                          {w.blocks.map((block, idx) => (
                            <CanvasRenderer key={idx} data={block} />
                          ))}
                        </div>
                      ) : (
                        <p className="text-text-muted text-[13px]">No canvas content</p>
                      )}
                      {refreshNote[w.id] && <p className="text-xs text-error">{refreshNote[w.id]}</p>}
                      {w.lastClassifyError && !w.classifying && (
                        <p className="text-xs text-error cursor-help" title={w.lastClassifyError}>
                          Classify failed. Set the refresher by hand in refresh settings.
                        </p>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      <FormModal
        title="New board"
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSubmit={createDashboard}
      >
        <label className="text-[13px] text-text-secondary">Name</label>
        <Input
          value={createForm.name}
          onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
          placeholder="e.g. Portfolio"
          autoFocus
        />
        <label className="text-[13px] text-text-secondary mt-2">Description (optional)</label>
        <Input
          value={createForm.description}
          onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
          placeholder="Short description"
        />
      </FormModal>

      <FormModal
        title="Rename board"
        open={showRename}
        onClose={() => setShowRename(false)}
        onSubmit={renameDashboard}
      >
        <label className="text-[13px] text-text-secondary">Name</label>
        <Input
          value={renameForm.name}
          onChange={(e) => setRenameForm({ ...renameForm, name: e.target.value })}
        />
        <label className="text-[13px] text-text-secondary mt-2">Description</label>
        <Input
          value={renameForm.description}
          onChange={(e) => setRenameForm({ ...renameForm, description: e.target.value })}
        />
      </FormModal>

      <RefresherEditorModal
        open={!!editingRefresher}
        widget={editingRefresher}
        dashboardAutoRefresh={active?.autoRefreshEnabled ?? false}
        onClose={() => setEditingRefresher(null)}
        onSaved={() => {
          if (active) loadActive(active.id);
        }}
      />
    </div>
  );
}


const REFRESHER_LABELS: Record<string, string> = { template: "template", agent: "agent" };

function WidgetStatus({ widget, dashboardAutoRefresh }: { widget: Widget; dashboardAutoRefresh: boolean }) {
  if (widget.classifying) {
    return (
      <span className="flex items-center gap-1.5 font-mono text-xs text-text-muted">
        <LiveDot /> classifying
      </span>
    );
  }
  if (!widget.refresherKind) {
    return <span className="font-mono text-xs text-text-muted">frozen</span>;
  }
  const interval = widget.refreshIntervalMinutes;
  const autoLabel = dashboardAutoRefresh ? `auto every ${interval}m` : `auto paused (${interval}m)`;
  const parts = [
    REFRESHER_LABELS[widget.refresherKind] ?? `legacy ${widget.refresherKind}`,
    typeof interval === "number" && autoLabel,
    widget.lastRefreshedAt && `refreshed ${formatTimeAgo(widget.lastRefreshedAt)}`,
  ].filter(Boolean);
  return <span className="font-mono text-xs text-text-muted truncate">{parts.join(" · ")}</span>;
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
      <LayoutGrid size={24} strokeWidth={1.5} className="text-text-muted" />
      <h3 className="text-[15px] font-medium text-text-primary">No boards yet</h3>
      <p className="text-[13px] text-text-muted max-w-sm">
        Create a board, then pin a chat response that has canvas blocks to it.
      </p>
      <Button variant="ghost" size="md" onClick={onCreate}>
        <Plus size={16} strokeWidth={1.5} /> Create your first board
      </Button>
    </div>
  );
}

function WidgetEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 gap-2 text-center border border-dashed border-border rounded-xl">
      <p className="text-sm text-text-secondary">This board is empty</p>
      <p className="text-[13px] text-text-muted max-w-md">
        Open a chat, find a response with canvas blocks, and click{" "}
        <Star size={14} strokeWidth={1.5} className="inline align-[-2px]" aria-label="the star" /> in its footer to pin
        it here.
      </p>
    </div>
  );
}
