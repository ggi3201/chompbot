import { useState, useEffect, useCallback, useRef } from "react";
import { useCrud } from "../hooks/useCrud";
import { apiFetch } from "../lib/api";
import CrudTable, { type Column } from "../components/CrudTable";
import FormModal from "../components/FormModal";
import JsonEditor from "../components/JsonEditor";
import { Check, Copy, X } from "lucide-react";
import { Badge, Button, GlassCard, Input, PageHeader } from "../components/ui";
import { formatTimeAgo } from "../lib/format";

interface McpServer {
  id: string;
  name: string;
  description: string;
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
  enabled: boolean;
  healthCheckUrl: string | null;
  healthCheckInterval: number;
  lastHealthCheck: string | null;
  isReachable: boolean | null;
  latencyMs: number | null;
  healthStatus: string;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

interface LiveStatus {
  name: string;
  status: string;
}

/** Servers Chomp did not add: changing them happens where they live, not here. */
function managedBy(item: { name: string; inDb: boolean }): string | undefined {
  if (item.inDb) return undefined;
  if (item.name.startsWith("claude.ai ")) return "In your claude.ai account";
  if (item.name === "chomp-api") return "Chomp's own tools";
  return "Added in Claude Code";
}

/** Reconstruct a `claude mcp add` command from server config. */
function buildMcpAddCommand(server: McpServer): string {
  const cfg = server.config as Record<string, unknown>;
  const transport = (cfg.type as string) ?? (cfg.command ? "stdio" : cfg.url ? "sse" : "stdio");
  const parts = ["claude", "mcp", "add"];

  if (transport === "sse" || transport === "http") {
    parts.push("--transport", transport);
  }

  parts.push(JSON.stringify(server.name));

  if (transport === "stdio") {
    if (cfg.command) parts.push(String(cfg.command));
    if (Array.isArray(cfg.args)) {
      for (const a of cfg.args) parts.push(String(a));
    }
  } else {
    if (cfg.url) parts.push(String(cfg.url));
  }

  if (cfg.env && typeof cfg.env === "object") {
    for (const [k, v] of Object.entries(cfg.env as Record<string, string>)) {
      parts.push("--env", `${k}=${v}`);
    }
  }

  return parts.join(" ");
}


const LIVE_UP = ["connected", "running", "ok"];
const LIVE_DOWN = ["error", "disconnected", "failed"];

/** Healthy is the normal state and stays quiet; only a server that is down takes color. */
function healthLabel(isReachable: boolean | null | undefined, liveStatus: string | undefined): { label: string; tone: string } {
  // Prefer DB health check data; fall back to live status from claude mcp list
  if (isReachable === true) return { label: "reachable", tone: "text-text-muted" };
  if (isReachable === false) return { label: "unreachable", tone: "text-error" };
  if (!liveStatus) return { label: "unchecked", tone: "text-text-muted" };
  if (LIVE_UP.includes(liveStatus)) return { label: liveStatus, tone: "text-text-muted" };
  if (LIVE_DOWN.includes(liveStatus)) return { label: liveStatus, tone: "text-error" };
  return { label: liveStatus, tone: "text-text-secondary" };
}

function HealthStatusCell({
  isReachable,
  latencyMs,
  lastHealthCheck,
  liveStatus,
}: {
  isReachable: boolean | null | undefined;
  latencyMs: number | null | undefined;
  lastHealthCheck: string | null | undefined;
  liveStatus: string | undefined;
}) {
  const { label, tone } = healthLabel(isReachable, liveStatus);
  return (
    <span className="inline-flex flex-col gap-0.5 font-mono text-xs tabular-nums">
      <span className="inline-flex items-baseline gap-2">
        <span className={tone}>{label}</span>
        {latencyMs != null && <span className="text-text-muted">{latencyMs}ms</span>}
      </span>
      {lastHealthCheck && <span className="text-text-muted">{formatTimeAgo(lastHealthCheck)}</span>}
    </span>
  );
}

export default function McpServers() {
  const { items, loading, error, create, update, remove, refresh } = useCrud<McpServer>("/mcp-servers");

  // --- Form state ---
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    config: '{\n  "type": "stdio",\n  "command": "",\n  "args": []\n}',
    credentials: "{}",
    healthCheckUrl: "",
    healthCheckInterval: "300",
  });

  // --- Quick-add state ---
  const [quickCmd, setQuickCmd] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickMsg, setQuickMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // --- Live status ---
  const [liveStatuses, setLiveStatuses] = useState<LiveStatus[]>([]);
  const statusTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLiveStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/mcp-servers/live");
      if (res.ok) {
        setLiveStatuses(await res.json());
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchLiveStatus();
    statusTimer.current = setInterval(fetchLiveStatus, 30_000);
    return () => {
      if (statusTimer.current) clearInterval(statusTimer.current);
    };
  }, [fetchLiveStatus]);

  // --- Command modal state ---
  const [cmdModalServer, setCmdModalServer] = useState<McpServer | null>(null);
  const [copied, setCopied] = useState(false);

  // --- Action feedback ---
  const [actionMsg, setActionMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  // Merge live + DB: live is the source of truth for what exists,
  // DB provides description/config/id for managed servers
  const mergedItems: (McpServer & { liveStatus?: string; inDb: boolean })[] = liveStatuses.map((live) => {
    const db = items.find((s) => s.name === live.name);
    return {
      id: db?.id ?? `live:${live.name}`,
      name: live.name,
      description: db?.description ?? "",
      config: db?.config ?? {},
      credentials: db?.credentials ?? {},
      enabled: db?.enabled ?? true,
      healthCheckUrl: db?.healthCheckUrl ?? null,
      healthCheckInterval: db?.healthCheckInterval ?? 300,
      lastHealthCheck: db?.lastHealthCheck ?? null,
      isReachable: db?.isReachable ?? null,
      latencyMs: db?.latencyMs ?? null,
      healthStatus: db?.healthStatus ?? "unknown",
      consecutiveFailures: db?.consecutiveFailures ?? 0,
      createdAt: db?.createdAt ?? "",
      updatedAt: db?.updatedAt ?? "",
      liveStatus: live.status,
      inDb: !!db,
    };
  });
  // Also include DB-only entries not in live list (registered but not returned by CLI yet)
  for (const dbItem of items) {
    if (!mergedItems.find((m) => m.name === dbItem.name)) {
      mergedItems.push({ ...dbItem, liveStatus: "registered", inDb: true });
    }
  }

  // --- Quick-add handler ---
  async function handleQuickAdd() {
    if (!quickCmd.trim()) return;
    setQuickBusy(true);
    setQuickMsg(null);
    try {
      const res = await apiFetch("/mcp-servers/add-command", {
        method: "POST",
        body: JSON.stringify({ command: quickCmd.trim() }),
      });
      if (res.ok) {
        setQuickMsg({ text: "Server added", ok: true });
        setQuickCmd("");
        await refresh();
        fetchLiveStatus();
      } else {
        const body = await res.json().catch(() => null);
        setQuickMsg({ text: body?.error ?? `Failed (${res.status})`, ok: false });
      }
    } catch (e) {
      setQuickMsg({ text: e instanceof Error ? e.message : "Request failed", ok: false });
    } finally {
      setQuickBusy(false);
    }
  }

  // --- Health check all servers ---
  async function handleCheckAll() {
    setCheckingAll(true);
    setActionMsg(null);
    try {
      const res = await apiFetch("/mcp-servers/check-health", { method: "POST" });
      if (res.ok) {
        setActionMsg({ text: "Health check complete", ok: true });
        await refresh();
      } else {
        const body = await res.json().catch(() => null);
        setActionMsg({ text: body?.error ?? `Check failed (${res.status})`, ok: false });
      }
    } catch (e) {
      setActionMsg({ text: e instanceof Error ? e.message : "Check failed", ok: false });
    } finally {
      setCheckingAll(false);
    }
  }

  // --- Health check one server ---
  async function handleCheckOne(server: McpServer) {
    setCheckingId(server.id);
    setActionMsg(null);
    try {
      const res = await apiFetch(`/mcp-servers/${server.id}/health-check`, { method: "POST" });
      if (res.ok) {
        await refresh();
      } else {
        const body = await res.json().catch(() => null);
        setActionMsg({ text: body?.error ?? `Check failed (${res.status})`, ok: false });
      }
    } catch (e) {
      setActionMsg({ text: e instanceof Error ? e.message : "Check failed", ok: false });
    } finally {
      setCheckingId(null);
    }
  }

  // --- Sync all ---
  async function handleSyncAll() {
    setActionMsg(null);
    try {
      const res = await apiFetch("/mcp-servers/sync", { method: "POST" });
      if (res.ok) {
        setActionMsg({ text: "Sync complete", ok: true });
        await refresh();
        fetchLiveStatus();
      } else {
        const body = await res.json().catch(() => null);
        setActionMsg({ text: body?.error ?? `Sync failed (${res.status})`, ok: false });
      }
    } catch (e) {
      setActionMsg({ text: e instanceof Error ? e.message : "Sync failed", ok: false });
    }
  }

  // --- Import from Claude Desktop ---
  async function handleImportDesktop() {
    setActionMsg(null);
    try {
      const res = await apiFetch("/mcp-servers/import-desktop", { method: "POST" });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const count = body?.imported ?? body?.count;
        setActionMsg({ text: count != null ? `Imported ${count} ${count === 1 ? "server" : "servers"}` : "Import complete", ok: true });
        await refresh();
        fetchLiveStatus();
      } else {
        const body = await res.json().catch(() => null);
        setActionMsg({ text: body?.error ?? `Import failed (${res.status})`, ok: false });
      }
    } catch (e) {
      setActionMsg({ text: e instanceof Error ? e.message : "Import failed", ok: false });
    }
  }

  // --- Reconnect a server ---
  async function handleReconnect(server: McpServer) {
    setActionMsg(null);
    try {
      await apiFetch(`/mcp-servers/${server.id}`, { method: "DELETE" });
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = server;
      void _id; void _c; void _u;
      await create(rest);
      setActionMsg({ text: `Reconnected ${server.name}`, ok: true });
      fetchLiveStatus();
    } catch (e) {
      setActionMsg({ text: e instanceof Error ? e.message : "Reconnect failed", ok: false });
    }
  }

  // --- Copy command ---
  function handleShowCommand(server: McpServer) {
    setCmdModalServer(server);
    setCopied(false);
  }

  function copyCommand() {
    if (!cmdModalServer) return;
    const cmd = buildMcpAddCommand(cmdModalServer);
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // --- Form open/close ---
  function openNew() {
    setEditing(null);
    setForm({
      name: "",
      description: "",
      config: '{\n  "type": "stdio",\n  "command": "",\n  "args": []\n}',
      credentials: "{}",
      healthCheckUrl: "",
      healthCheckInterval: "300",
    });
    setShowForm(true);
  }

  function openEdit(server: McpServer & { inDb?: boolean; liveStatus?: string }) {
    setEditing(server);
    setForm({
      name: server.name,
      description: server.description,
      config: JSON.stringify(server.config, null, 2),
      credentials: JSON.stringify(server.credentials, null, 2),
      healthCheckUrl: server.healthCheckUrl ?? "",
      healthCheckInterval: String(server.healthCheckInterval ?? 300),
    });
    setShowForm(true);
  }

  async function handleSubmit() {
    const data: Record<string, unknown> = {
      name: form.name,
      description: form.description,
      config: JSON.parse(form.config),
      credentials: JSON.parse(form.credentials),
      healthCheckUrl: form.healthCheckUrl.trim() || null,
      healthCheckInterval: parseInt(form.healthCheckInterval, 10) || 300,
    };
    if (editing) {
      await update(editing.id, data);
    } else {
      await create(data);
    }
    setShowForm(false);
    fetchLiveStatus();
  }

  type MergedServer = McpServer & { liveStatus?: string; inDb: boolean };

  // --- Columns with live + health status ---
  const columns: Column<MergedServer>[] = [
    { key: "name", label: "Name" },
    {
      key: "description",
      label: "Description",
      render: (v) => {
        const s = String(v ?? "");
        if (!s) return <span className="text-text-muted">&mdash;</span>;
        return s.slice(0, 60) + (s.length > 60 ? "…" : "");
      },
    },
    {
      key: "config",
      label: "Transport",
      render: (v) => {
        const cfg = v as Record<string, unknown>;
        const transport = (cfg.type as string) ?? (cfg.command ? "stdio" : cfg.url ? "http" : "\u2014");
        return <span className="font-mono text-xs text-text-muted">{transport}</span>;
      },
    },
    {
      key: "liveStatus" as keyof MergedServer,
      label: "Status",
      render: (_v, item) => (
        <HealthStatusCell
          isReachable={item.isReachable}
          latencyMs={item.latencyMs}
          lastHealthCheck={item.lastHealthCheck}
          liveStatus={item.liveStatus}
        />
      ),
    },
  ];

  return (
    <div className="p-6">
      <PageHeader
        title="MCP servers"
        action={
          <div className="flex gap-2 flex-wrap justify-end">
            <Button onClick={handleImportDesktop}>Import desktop</Button>
            <Button onClick={handleSyncAll}>Sync all</Button>
            <Button onClick={handleCheckAll} disabled={checkingAll}>
              {checkingAll ? "Checking" : "Check health"}
            </Button>
            <Button variant="primary" onClick={openNew}>Add MCP server</Button>
          </div>
        }
      />

      {actionMsg && (
        <div className={`flex items-center justify-between gap-2 mb-3 pl-3 pr-1 py-1 rounded-md border border-border bg-glass text-[13px] ${actionMsg.ok ? "text-success" : "text-error"}`}>
          <span>{actionMsg.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setActionMsg(null)}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-transparent border-none text-text-muted cursor-pointer transition-colors hover:bg-white/4 hover:text-text-primary"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      )}

      <GlassCard className="mb-4 p-4">
        <label htmlFor="mcp-quick-add" className="block text-[13px] text-text-secondary mb-2">
          Quick add: paste a <Badge>claude mcp add</Badge> command
        </label>
        <div className="flex gap-2">
          <Input
            id="mcp-quick-add"
            className="flex-1 min-w-0 font-mono"
            value={quickCmd}
            onChange={(e) => setQuickCmd(e.target.value)}
            placeholder='claude mcp add my-server -- npx -y @my/server'
            onKeyDown={(e) => {
              if (e.key === "Enter") handleQuickAdd();
            }}
          />
          <Button onClick={handleQuickAdd} disabled={quickBusy || !quickCmd.trim()}>
            {quickBusy ? "Running" : "Run"}
          </Button>
        </div>
        {quickMsg && (
          <div className={`mt-2 text-[13px] ${quickMsg.ok ? "text-success" : "text-error"}`}>
            {quickMsg.text}
          </div>
        )}
      </GlassCard>

      {/* ---- Table ---- */}
      <CrudTable
        items={mergedItems}
        columns={columns}
        loading={loading && liveStatuses.length === 0}
        error={error}
        onEdit={(item) => item.inDb ? openEdit(item) : undefined}
        onDelete={(id) => { const item = mergedItems.find(m => m.id === id); if (item?.inDb) remove(id); }}
        onToggle={(id, enabled) => update(id, { enabled } as Partial<McpServer>)}
        enabledKey="enabled"
        readOnly={(item: MergedServer) => managedBy(item)}
        renderActions={(item: MergedServer) => (
          <>
            {item.inDb ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCheckOne(item)}
                disabled={checkingId === item.id}
                title="Run health check"
              >
                {checkingId === item.id ? "Checking" : "Check"}
              </Button>
            ) : null}
            {item.inDb ? (
              <Button variant="outline" size="sm" onClick={() => handleReconnect(item)} title="Reconnect">
                Reconnect
              </Button>
            ) : null}
            {item.inDb ? (
              <Button variant="outline" size="sm" onClick={() => handleShowCommand(item)} title="Show command">
                Command
              </Button>
            ) : null}
          </>
        )}
      />

      {/* ---- Edit / New form modal ---- */}
      <FormModal
        title={editing ? "Edit MCP server" : "New MCP server"}
        open={showForm}
        onClose={() => setShowForm(false)}
        onSubmit={handleSubmit}
        wide
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Name
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Description
          <Input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Config (JSON)</label>
        <JsonEditor
          value={form.config}
          onChange={(v) => setForm({ ...form, config: v })}
          minHeight="160px"
        />

        {/* Credentials */}
        <div className="border-t border-border pt-3 mt-1">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Credentials (JSON)
            <span className="text-xs text-text-muted font-normal">API keys and secrets for this server</span>
          </label>
          <JsonEditor
            value={form.credentials}
            onChange={(v) => setForm({ ...form, credentials: v })}
            minHeight="80px"
          />
        </div>

        {/* Health Monitoring */}
        <div className="border-t border-border pt-3 mt-1">
          <p className="text-sm font-medium text-text-primary m-0 mb-2">Health monitoring</p>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
              Health check URL
              <Input
                value={form.healthCheckUrl}
                onChange={(e) => setForm({ ...form, healthCheckUrl: e.target.value })}
                placeholder="https://example.com/health"
              />
              <span className="text-xs text-text-muted font-normal">Optional HTTP endpoint the worker polls to detect outages</span>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
              Check interval in seconds
              <Input
                type="number"
                min="60"
                value={form.healthCheckInterval}
                onChange={(e) => setForm({ ...form, healthCheckInterval: e.target.value })}
              />
            </label>
          </div>
        </div>
      </FormModal>

      {/* ---- Command modal ---- */}
      {cmdModalServer && (
        <dialog
          open
          className="border border-white/12 rounded-xl p-6 max-w-[600px] w-[90vw] m-auto fixed inset-0 h-fit bg-glass text-text-primary shadow-modal z-[1000]"
        >
          <h3 className="m-0 mb-1 text-[17px] font-medium text-text-primary">Add command</h3>
          <p className="text-[13px] text-text-secondary m-0 mb-3">
            Run this in your terminal to register the server with Claude Code.
          </p>
          <pre className="m-0 bg-surface-alt border border-border rounded-md p-3 font-mono text-[13px] text-text-primary overflow-x-auto whitespace-pre-wrap break-all">
            {buildMcpAddCommand(cmdModalServer)}
          </pre>
          <div className="flex gap-2 justify-end mt-4">
            <Button variant="outline" onClick={() => setCmdModalServer(null)}>
              Close
            </Button>
            <Button variant="primary" onClick={copyCommand}>
              {copied ? <Check size={16} strokeWidth={1.5} /> : <Copy size={16} strokeWidth={1.5} />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </dialog>
      )}

      {/* Backdrop for command modal */}
      {cmdModalServer && (
        <div
          onClick={() => setCmdModalServer(null)}
          className="fixed inset-0 bg-black/50 z-[999]"
        />
      )}
    </div>
  );
}
