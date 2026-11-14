import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "../lib/api";
import { Button, GlassCard, Input, PageHeader, LiveDot } from "../components/ui";
import { ChevronDown, ChevronUp, Copy, RefreshCw, X } from "lucide-react";
import { SyntaxHighlighter } from "../lib/syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { formatDate, formatElapsed, formatTimeAgo } from "../lib/format";

/* ── Activity Log types & helpers ── */

interface ActivityEntry {
  id: string;
  type: string;
  summary: string;
  details: Record<string, unknown> | null;
  scheduleId: string | null;
  agentUsed: string | null;
  createdAt: string;
}

const ALL_ACTIVITY_TYPES = [
  "agent.started",
  "agent.completed",
  "agent.failed",
  "schedule.completed",
  "schedule.failed",
  "chat.message",
  "memory.saved",
  "webhook.received",
  "location.changed",
  "service.health.changed",
  "system.startup",
];

const ACTIVITY_PAGE_SIZE = 50;

const FILTER_ON = "bg-raised text-text-primary border-white/14";
const FILTER_OFF = "bg-transparent text-text-muted border-transparent hover:text-text-primary";
const FILTER_CHIP = "h-8 px-3 rounded-md border text-[13px] cursor-pointer transition-colors";


/** The one date format on this page, e.g. "3 Nov, 14:05". */

/** Color only for outcomes: failures read as errors, completions as success, the rest stay neutral. */
function activityTone(type: string): string {
  if (type.endsWith(".failed")) return "text-error";
  if (type.endsWith(".completed")) return "text-success";
  return "text-text-muted";
}

function activityTypeLabel(type: string): string {
  const parts = type.split(".");
  return parts[parts.length - 1] ?? type;
}

function activityTypeName(type: string): string {
  const words = type.replace(/\./g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = entry.details && Object.keys(entry.details).length > 0;

  return (
    <div
      className={`border-b border-border last:border-b-0 transition-colors duration-150 ${hasDetails ? "cursor-pointer hover:bg-white/2" : ""}`}
      onClick={() => hasDetails && setExpanded((v) => !v)}
    >
      <div className="flex gap-4 px-4 py-3 items-start">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] text-text-secondary leading-snug m-0 break-words">
            {entry.summary}
          </p>
          {(entry.agentUsed || entry.scheduleId) && (
            <p className="font-mono text-xs text-text-muted mt-1">
              {entry.agentUsed || "schedule"}
            </p>
          )}
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1 font-mono text-xs">
          <span className={activityTone(entry.type)}>{activityTypeLabel(entry.type)}</span>
          <span className="text-text-muted tabular-nums" title={formatDate(entry.createdAt)}>
            {formatTimeAgo(entry.createdAt)}
          </span>
          {hasDetails && (
            <span className="inline-flex items-center gap-1 text-text-muted">
              {expanded ? <ChevronUp size={14} strokeWidth={1.5} /> : <ChevronDown size={14} strokeWidth={1.5} />}
              {expanded ? "Hide" : "Details"}
            </span>
          )}
        </div>
      </div>
      {expanded && entry.details && (
        <div className="px-4 pb-3">
          <pre className="font-mono text-xs text-text-muted bg-surface border border-border rounded-md p-3 max-h-[300px] overflow-auto whitespace-pre-wrap break-all leading-relaxed m-0">
            {JSON.stringify(entry.details, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ActivityTypeFilter({
  selected,
  onChange,
}: {
  selected: string | null;
  onChange: (t: string | null) => void;
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      <button
        type="button"
        onClick={() => onChange(null)}
        className={`${FILTER_CHIP} ${selected === null ? FILTER_ON : FILTER_OFF}`}
      >
        All
      </button>
      {ALL_ACTIVITY_TYPES.map((t) => {
        const isActive = selected === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(isActive ? null : t)}
            className={`${FILTER_CHIP} ${isActive ? FILTER_ON : FILTER_OFF}`}
          >
            {activityTypeName(t)}
          </button>
        );
      })}
    </div>
  );
}

function ActivityLogTab() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (reset: boolean) => {
      const currentOffset = reset ? 0 : offset;
      if (reset) {
        setLoading(true);
        setEntries([]);
      } else {
        setLoadingMore(true);
      }
      setError(null);
      try {
        const res = await apiFetch(
          `/dashboard/activity?limit=${ACTIVITY_PAGE_SIZE}&offset=${currentOffset}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ActivityEntry[] = await res.json();
        const filtered = typeFilter ? data.filter((e) => e.type === typeFilter) : data;
        setEntries((prev) => (reset ? filtered : [...prev, ...filtered]));
        setOffset(currentOffset + data.length);
        setHasMore(data.length === ACTIVITY_PAGE_SIZE);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load activity");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [offset, typeFilter],
  );

  useEffect(() => {
    setOffset(0);
    setHasMore(true);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter]);

  useEffect(() => {
    const id = setInterval(() => {
      setOffset(0);
      setHasMore(true);
      load(true);
    }, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter]);

  const isEmpty = !loading && entries.length === 0 && !error;

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
        <ActivityTypeFilter selected={typeFilter} onChange={setTypeFilter} />
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setOffset(0); setHasMore(true); load(true); }}
        >
          <RefreshCw size={16} strokeWidth={1.5} />
          Refresh
        </Button>
      </div>

      <GlassCard>
        {loading && (
          <div className="py-16 text-center text-[13px] text-text-muted">Loading activity</div>
        )}

        {error && (
          <div className="py-16 text-center text-[13px] text-error">{error}</div>
        )}

        {isEmpty && (
          <div className="py-16 px-4 flex flex-col items-center gap-1 text-center">
            <p className="text-sm text-text-secondary m-0">No activity recorded yet</p>
            <p className="text-[13px] text-text-muted m-0">
              Activity is logged as proactive rules fire, agents run and schedules execute.
            </p>
          </div>
        )}

        {!loading && !error && entries.length > 0 && (
          <>
            {entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}

            <div className="px-4 py-3 flex justify-center border-t border-border">
              {hasMore ? (
                <Button variant="outline" size="sm" onClick={() => load(false)} disabled={loadingMore}>
                  {loadingMore ? "Loading" : "Load more"}
                </Button>
              ) : (
                <span className="font-mono text-xs text-text-muted tabular-nums">
                  All {entries.length} entries shown
                </span>
              )}
            </div>
          </>
        )}
      </GlassCard>
    </>
  );
}

/* ── Agent Monitor types & helpers ── */

interface ActiveSession {
  sessionId: string;
  ccSessionId?: string;
  agentName: string;
  agentType: string;
  conversationId?: string;
  pid?: number;
  prompt?: string;
  label?: string;
  model?: string;
  lastActivity?: { tool: string; summary: string };
  startedAt: string;
  runtimeSeconds: number;
  outputBytes: number;
  outputChunks: number;
  lastOutputSecondsAgo: number;
}

// API returns Drizzle camelCase field names
interface HistoryEntry {
  sessionId: string;
  ccSessionId?: string;
  agentName: string;
  agentType: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  outputBytes: number;
  outputChunks: number;
  prompt?: string;
  label?: string;
  model?: string;
  error?: string;
  conversationId?: string;
}

interface HistoryResponse {
  history: HistoryEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "\u2014";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}


function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len) + "\u2026";
}

const STATUS_TONE: Record<string, string> = {
  completed: "text-text-muted",
  failed: "text-error",
  killed: "text-text-secondary",
  timed_out: "text-error",
};

const STATUS_LABELS: Record<string, string> = {
  all: "All",
  completed: "Completed",
  failed: "Failed",
  killed: "Killed",
  timed_out: "Timed out",
};

const STATUS_OPTIONS = ["all", "completed", "failed", "killed", "timed_out"] as const;

function SessionStatus({ status }: { status: string }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-2 font-mono text-xs text-text-primary">
        <LiveDot />
        running
      </span>
    );
  }
  return (
    <span className={`font-mono text-xs ${STATUS_TONE[status] ?? "text-text-muted"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ResumeCommand({ ccSessionId }: { ccSessionId: string }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-2 max-w-full font-mono text-xs text-text-secondary bg-raised border border-border rounded-md px-2 h-7 text-left hover:text-text-primary transition-colors cursor-pointer"
      onClick={() => navigator.clipboard.writeText(`claude --resume ${ccSessionId}`)}
      title="Copy to clipboard"
    >
      <span className="truncate">claude --resume {ccSessionId}</span>
      <Copy size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
    </button>
  );
}

/** Full-screen dialog showing a prompt with syntax highlighting */
function PromptDialog({ entry, onClose }: { entry: HistoryEntry; onClose: () => void }) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl max-h-[80vh] flex flex-col rounded-xl border border-border bg-glass shadow-modal overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0 flex flex-col gap-1">
            <h3 className="text-[15px] font-medium text-text-primary m-0">
              Prompt — {entry.agentName}
            </h3>
            <div className="flex items-center gap-3 flex-wrap font-mono text-xs text-text-muted tabular-nums">
              <SessionStatus status={entry.status} />
              {entry.model && <span>{entry.model}</span>}
              <span>{formatDate(entry.startedAt)}</span>
              {entry.durationMs != null && <span>{formatDuration(entry.durationMs)}</span>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-md text-text-muted hover:text-text-primary hover:bg-raised transition-colors shrink-0 cursor-pointer"
            aria-label="Close"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="overflow-auto flex-1 text-[13px]">
          {entry.prompt ? (
            <SyntaxHighlighter
              language="markdown"
              style={vscDarkPlus}
              customStyle={{
                margin: 0,
                padding: "20px 24px",
                background: "transparent",
                fontSize: "13px",
                lineHeight: "1.6",
              }}
              wrapLongLines
            >
              {entry.prompt}
            </SyntaxHighlighter>
          ) : (
            <p className="px-5 py-4 text-text-muted m-0">No prompt recorded</p>
          )}
        </div>

        {(entry.error || entry.ccSessionId) && (
          <div className="shrink-0 px-5 py-3 border-t border-border flex flex-col items-start gap-2">
            {entry.error && (
              <div className="self-stretch text-[13px] text-error px-3 py-2 rounded-md border border-error/25">
                {entry.error}
              </div>
            )}
            {entry.ccSessionId && <ResumeCommand ccSessionId={entry.ccSessionId} />}
          </div>
        )}
      </div>
    </div>
  );
}

type Tab = "agents" | "activity";

export default function AgentMonitor() {
  const [tab, setTab] = useState<Tab>("agents");
  const [active, setActive] = useState<ActiveSession[]>([]);
  const [historyData, setHistoryData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [promptDialog, setPromptDialog] = useState<HistoryEntry | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadHistory = useCallback(async (p: number, s: string, status: string) => {
    const params = new URLSearchParams({ page: String(p), limit: "20" });
    if (s) params.set("search", s);
    if (status !== "all") params.set("status", status);
    const res = await apiFetch(`/agent-monitor/history?${params}`);
    if (res.ok) {
      const data: HistoryResponse = await res.json();
      setHistoryData(data);
    }
  }, []);

  const loadActive = useCallback(async () => {
    const res = await apiFetch("/agent-monitor/active");
    if (res.ok) {
      const data = await res.json();
      setActive(data.sessions);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      await Promise.all([loadActive(), loadHistory(page, search, statusFilter)]);
    } finally {
      setLoading(false);
    }
  }, [loadActive, loadHistory, page, search, statusFilter]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  function handleSearchChange(value: string) {
    setSearch(value);
    setPage(1);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      loadHistory(1, value, statusFilter);
    }, 300);
  }

  function handleStatusChange(status: string) {
    setStatusFilter(status);
    setPage(1);
    loadHistory(1, search, status);
  }

  function handlePageChange(newPage: number) {
    setPage(newPage);
    loadHistory(newPage, search, statusFilter);
  }

  async function killSession(sessionId: string) {
    await apiFetch(`/agent-monitor/kill/${sessionId}`, { method: "POST" });
    load();
  }

  async function killAll() {
    await apiFetch("/agent-monitor/kill-all", { method: "POST" });
    load();
  }

  const history = historyData?.history ?? [];
  const totalPages = historyData?.totalPages ?? 0;
  const total = historyData?.total ?? 0;

  if (loading && tab === "agents") return <div className="p-8 text-text-muted">Loading</div>;

  const tabs: { key: Tab; label: string }[] = [
    { key: "agents", label: "Agents" },
    { key: "activity", label: "Activity log" },
  ];

  return (
    <div className="p-4 md:p-6 h-full overflow-y-auto">
      {promptDialog && (
        <PromptDialog entry={promptDialog} onClose={() => setPromptDialog(null)} />
      )}

      <PageHeader
        title="Activity"
        action={
          tab === "agents" && active.length > 0 ? (
            <Button variant="danger" onClick={killAll}>Kill all</Button>
          ) : undefined
        }
      />

      <div className="flex gap-1 mb-6 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`h-9 px-3 -mb-px text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              tab === t.key
                ? "text-text-primary border-accent"
                : "text-text-muted border-transparent hover:text-text-secondary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "activity" && <ActivityLogTab />}

      {tab === "agents" && (
        <>
          <SectionTitle title="Active sessions" count={active.length} />

          {active.length === 0 ? (
            <p className="text-[13px] text-text-muted mb-8">No agents running</p>
          ) : (
            <div className="flex flex-col gap-3 mb-8">
              {active.map((s) => (
                <GlassCard key={s.sessionId} className="p-4 flex gap-4 items-start justify-between">
                  <div className="min-w-0 flex flex-col gap-2">
                    <div className="flex items-center gap-3 flex-wrap">
                      <LiveDot />
                      <span className="text-[15px] font-medium text-text-primary">{s.agentName}</span>
                      {s.model && <span className="font-mono text-xs text-text-muted">{s.model}</span>}
                      <span className="font-mono text-xs text-text-muted tabular-nums">PID {s.pid}</span>
                    </div>

                    {s.prompt && (
                      <p className="text-[13px] text-text-secondary leading-snug m-0">
                        {truncate(s.prompt, 120)}
                      </p>
                    )}

                    {s.lastActivity && (
                      <p className="font-mono text-xs text-text-muted truncate m-0">
                        {s.lastActivity.tool}: {s.lastActivity.summary}
                      </p>
                    )}

                    {s.ccSessionId && (
                      <div><ResumeCommand ccSessionId={s.ccSessionId} /></div>
                    )}

                    <div className="flex gap-4 flex-wrap font-mono text-xs text-text-muted tabular-nums">
                      <span>Running <span className="text-text-secondary">{formatElapsed(s.runtimeSeconds)}</span></span>
                      <span>Output <span className="text-text-secondary">{formatBytes(s.outputBytes)}</span></span>
                      <span>Chunks <span className="text-text-secondary">{s.outputChunks}</span></span>
                      <span>Last <span className="text-text-secondary">{s.lastOutputSecondsAgo}s ago</span></span>
                      {s.conversationId && (
                        <span>Conversation <span className="text-text-secondary">{s.conversationId.slice(0, 8)}</span></span>
                      )}
                    </div>
                  </div>

                  <Button variant="outline" size="sm" className="shrink-0" onClick={() => killSession(s.sessionId)}>
                    Kill
                  </Button>
                </GlassCard>
              ))}
            </div>
          )}

          <SectionTitle title="Session history" count={total > 0 ? total : undefined} />

          <div className="flex gap-3 mb-4 items-center flex-wrap">
            <Input
              placeholder="Search prompts and agents"
              value={search}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleSearchChange(e.target.value)}
              className="flex-1 min-w-[200px] max-w-[400px]"
            />
            <div className="flex gap-1 flex-wrap">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => handleStatusChange(s)}
                  className={`${FILTER_CHIP} ${statusFilter === s ? FILTER_ON : FILTER_OFF}`}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>

          {history.length === 0 ? (
            <p className="text-[13px] text-text-muted m-0">
              {search || statusFilter !== "all" ? "No matching sessions" : "No session history yet"}
            </p>
          ) : (
            <>
              <div className="bg-glass rounded-lg border border-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse min-w-[600px]">
                    <thead>
                      <tr>
                        {["Status", "Agent", "Prompt", "Model", "Started", "Duration", "Output"].map((h) => (
                          <th key={h} className="text-left px-4 h-10 border-b border-border text-[13px] text-text-muted font-normal">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((s) => (
                        <tr key={s.sessionId} className="border-b border-border last:border-b-0 hover:bg-white/2 transition-colors">
                          <td className="px-4 py-2.5 align-top whitespace-nowrap">
                            <SessionStatus status={s.status} />
                          </td>
                          <td className="px-4 py-2.5 text-sm text-text-primary align-top whitespace-nowrap">
                            {s.agentName}
                          </td>
                          <td className="px-4 py-2.5 max-w-[280px] align-top">
                            {s.prompt ? (
                              <button
                                type="button"
                                className="text-left text-[13px] text-text-secondary w-full group cursor-pointer"
                                onClick={() => setPromptDialog(s)}
                                title="View full prompt"
                              >
                                {s.label ? (
                                  <span className="text-text-primary font-medium block">{s.label}</span>
                                ) : (
                                  <span className="line-clamp-2 leading-snug">{truncate(s.prompt, 80)}</span>
                                )}
                                <span className="text-xs text-text-muted group-hover:text-text-primary transition-colors mt-1 block">
                                  View prompt
                                </span>
                              </button>
                            ) : (
                              <span className="text-text-muted">&mdash;</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-text-muted align-top whitespace-nowrap">
                            {s.model ?? <>&mdash;</>}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-text-muted align-top whitespace-nowrap tabular-nums">
                            {formatDate(s.startedAt)}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-text-secondary align-top whitespace-nowrap tabular-nums">
                            {formatDuration(s.durationMs)}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-text-muted align-top whitespace-nowrap tabular-nums">
                            <div className="flex flex-col gap-1">
                              <span>{formatBytes(s.outputBytes)}</span>
                              {s.outputChunks > 0 && <span>{s.outputChunks} chunks</span>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <span className="font-mono text-xs text-text-muted tabular-nums">
                    {total} sessions
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(page - 1)}
                      disabled={page <= 1}
                    >
                      Previous
                    </Button>
                    <span className="font-mono text-xs text-text-muted tabular-nums">
                      {page} / {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(page + 1)}
                      disabled={page >= totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function SectionTitle({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-baseline gap-3 mb-3">
      <h3 className="text-[15px] font-medium text-text-primary m-0">{title}</h3>
      {count != null && <span className="font-mono text-xs text-text-muted tabular-nums">{count}</span>}
    </div>
  );
}
