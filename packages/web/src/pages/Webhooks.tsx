import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useCrud } from "../hooks/useCrud";
import { apiFetch } from "../lib/api";
import { Check, Copy, Eye, EyeOff, Link2, Plus, Trash2, X } from "lucide-react";
import { Button, Input, Badge, GlassCard, IconButton, PageHeader } from "../components/ui";
import { formatDate } from "../lib/format";

const labelCls = "flex flex-col gap-1 text-xs font-medium text-text-secondary";
const rowButtonCls =
  "inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-text-muted hover:text-text-primary hover:bg-raised shrink-0 cursor-pointer transition-colors";

/** The one date format on this page, e.g. "3 Nov 2026, 14:05". */

interface Webhook {
  id: string;
  name: string;
  description: string;
  secret: string;
  eventType: string;
  enabled: boolean;
  lastReceivedAt: string | null;
  receiveCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ProactiveRule {
  id: string;
  name: string;
  triggerType: string;
  condition: { eventType?: string; conditions?: { field: string; op: string; value: string }[] };
  actionType: string;
  enabled: boolean;
}

export default function Webhooks() {
  const navigate = useNavigate();
  const { items, loading, error, create, update, remove, setError } =
    useCrud<Webhook>("/webhooks");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    eventType: "webhook.received",
  });
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(
    new Set()
  );
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [rules, setRules] = useState<ProactiveRule[]>([]);
  const [linkingWebhookId, setLinkingWebhookId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/proactive-rules")
      .then((r) => r.json())
      .then((data: ProactiveRule[]) => setRules(data))
      .catch(() => {});
  }, []);

  function getLinkedRules(webhookId: string): ProactiveRule[] {
    return rules.filter((r) => {
      if (r.triggerType !== "event") return false;
      const cond = r.condition;
      if (cond?.eventType !== "webhook.received") return false;
      return cond.conditions?.some(
        (c) => c.field === "webhookId" && c.op === "eq" && c.value === webhookId
      );
    });
  }

  function getLinkableRules(webhookId: string): ProactiveRule[] {
    const linkedIds = new Set(getLinkedRules(webhookId).map((r) => r.id));
    return rules.filter(
      (r) => r.triggerType === "event" && !linkedIds.has(r.id)
    );
  }

  async function linkRuleToWebhook(ruleId: string, webhookId: string) {
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) return;

    const condition = { ...rule.condition };
    condition.eventType = "webhook.received";
    const existing = condition.conditions ?? [];
    // Don't add duplicate
    const alreadyLinked = existing.some(
      (c) => c.field === "webhookId" && c.op === "eq" && c.value === webhookId
    );
    if (!alreadyLinked) {
      condition.conditions = [...existing, { field: "webhookId", op: "eq", value: webhookId }];
    }

    try {
      await apiFetch(`/proactive-rules/${ruleId}`, {
        method: "PUT",
        body: JSON.stringify({ condition }),
      });
      // Refresh rules
      const res = await apiFetch("/proactive-rules");
      const data: ProactiveRule[] = await res.json();
      setRules(data);
      setLinkingWebhookId(null);
    } catch {
      setError("Failed to link rule");
    }
  }

  function getReceiveUrl(id: string, external = false): string {
    // The public entrance for webhooks (a tunnel), when one is set up; else this page's own address.
    const base = (external && import.meta.env.VITE_WEBHOOKS_ORIGIN) || window.location.origin;
    return `${base}/api/webhooks/receive/${id}`;
  }

  async function copyToClipboard(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(key);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      setError("Failed to copy to clipboard");
    }
  }

  function toggleSecret(id: string) {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function testWebhook(webhook: Webhook) {
    setTesting(webhook.id);
    setTestResults((prev) => ({ ...prev, [webhook.id]: "" }));
    try {
      const res = await apiFetch(`/webhooks/receive/${webhook.id}`, {
        method: "POST",
        body: JSON.stringify({ test: true, timestamp: new Date().toISOString() }),
      });
      if (res.ok) {
        setTestResults((prev) => ({ ...prev, [webhook.id]: "success" }));
      } else {
        setTestResults((prev) => ({
          ...prev,
          [webhook.id]: `error:${res.status}`,
        }));
      }
    } catch {
      setTestResults((prev) => ({ ...prev, [webhook.id]: "error:network" }));
    } finally {
      setTesting(null);
    }
  }

  async function handleCreate() {
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    await create({
      name: form.name,
      description: form.description,
      eventType: form.eventType,
    } as Partial<Webhook>);
    setForm({ name: "", description: "", eventType: "webhook.received" });
    setShowForm(false);
  }

  async function handleToggle(webhook: Webhook) {
    await update(webhook.id, { enabled: !webhook.enabled } as Partial<Webhook>);
  }

  async function handleDelete(id: string) {
    await remove(id);
    setConfirmDelete(null);
  }

  function createRuleForWebhook(wh: Webhook) {
    navigate("/proactive", {
      state: {
        prefillRule: {
          name: `On webhook: ${wh.name}`,
          triggerType: "event",
          eventType: "webhook.received",
          conditions: [{ field: "webhookId", op: "eq", value: wh.id }],
        },
      },
    });
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-text-muted">Loading webhooks</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader title="Webhooks" action={<Button onClick={() => setShowForm(true)}>Create webhook</Button>} />

      {error && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 mb-4 rounded-md border border-error/25 text-error text-[13px]">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss"
            className="flex items-center justify-center w-6 h-6 rounded-md text-error/80 hover:text-error cursor-pointer transition-colors"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      )}

      {/* Create Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-surface/80 flex items-center justify-center z-[1000]">
          <div className="bg-glass border border-border rounded-xl p-6 w-full max-w-[480px] shadow-modal flex flex-col gap-4">
            <h3 className="m-0 text-[15px] font-medium text-text-primary">New webhook</h3>
            <label className={labelCls}>
              Name
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. GitHub push events"
                autoFocus
              />
            </label>
            <label className={labelCls}>
              Description
              <Input
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="What this webhook receives"
              />
            </label>
            <label className={labelCls}>
              Event type
              <Input
                value={form.eventType}
                onChange={(e) =>
                  setForm({ ...form, eventType: e.target.value })
                }
                placeholder="webhook.received"
              />
            </label>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleCreate}>
                Create
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-surface/80 flex items-center justify-center z-[1000]">
          <div className="bg-glass border border-border rounded-xl p-6 w-full max-w-[480px] shadow-modal flex flex-col gap-4">
            <h3 className="m-0 text-[15px] font-medium text-text-primary">Delete webhook</h3>
            <p className="text-sm text-text-secondary">
              This cannot be undone. Any external service that sends data to this URL
              will get errors.
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => handleDelete(confirmDelete)}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Webhook List */}
      {items.length === 0 ? (
        <div className="py-12 px-4 text-center rounded-lg border border-border">
          <p className="text-[13px] text-text-muted">
            No webhooks yet. Create one to receive external events.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((wh) => (
            <GlassCard key={wh.id} className="overflow-hidden">
              {/* Card Header */}
              <div className="flex items-center justify-between px-4 py-3 gap-3 flex-wrap">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <span className={`text-[15px] font-medium truncate ${wh.enabled ? "text-text-primary" : "text-text-secondary"}`}>
                    {wh.name}
                  </span>
                  <Badge>{wh.eventType}</Badge>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggle(wh)}
                    aria-pressed={wh.enabled}
                    title={wh.enabled ? "Disable this webhook" : "Enable this webhook"}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${wh.enabled ? "bg-success" : "bg-text-muted/50"}`} />
                    {wh.enabled ? "Enabled" : "Disabled"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => testWebhook(wh)}
                    disabled={testing === wh.id}
                  >
                    {testing === wh.id ? "Testing" : "Test"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => createRuleForWebhook(wh)}
                    title="Create a proactive rule triggered by this webhook"
                  >
                    <Plus size={16} strokeWidth={1.5} />
                    Create rule
                  </Button>
                  <Button
                    variant={linkingWebhookId === wh.id ? "ghost" : "outline"}
                    size="sm"
                    onClick={() => setLinkingWebhookId(linkingWebhookId === wh.id ? null : wh.id)}
                    title="Link an existing proactive rule to this webhook"
                  >
                    <Link2 size={16} strokeWidth={1.5} />
                    Link rule
                  </Button>
                  <IconButton tone="danger" label="Delete webhook" onClick={() => setConfirmDelete(wh.id)}>
                    <Trash2 size={16} strokeWidth={1.5} />
                  </IconButton>
                </div>
              </div>

              {/* Test result */}
              {testResults[wh.id] && (
                <div
                  className={`px-4 py-2 font-mono text-xs border-t border-border ${
                    testResults[wh.id] === "success" ? "text-success" : "text-error"
                  }`}
                >
                  {testResults[wh.id] === "success"
                    ? "Test payload sent"
                    : `Test failed: ${testResults[wh.id]}`}
                </div>
              )}

              {/* Description */}
              {wh.description && (
                <div className="px-4 pb-3 text-[13px] text-text-secondary">{wh.description}</div>
              )}

              {/* Receive URL */}
              <div className="flex items-center gap-3 px-4 h-10 border-t border-border">
                <span className="text-xs text-text-muted w-12 shrink-0">URL</span>
                <code className="font-mono text-xs text-text-secondary flex-1 truncate">{getReceiveUrl(wh.id, true)}</code>
                <button
                  type="button"
                  className={rowButtonCls}
                  onClick={() =>
                    copyToClipboard(getReceiveUrl(wh.id, true), `url-${wh.id}`)
                  }
                >
                  {copiedField === `url-${wh.id}` ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
                  {copiedField === `url-${wh.id}` ? "Copied" : "Copy"}
                </button>
              </div>

              {/* Secret */}
              <div className="flex items-center gap-3 px-4 h-10 border-t border-border">
                <span className="text-xs text-text-muted w-12 shrink-0">Secret</span>
                <code className="font-mono text-xs text-text-secondary flex-1 truncate">
                  {revealedSecrets.has(wh.id)
                    ? wh.secret
                    : "\u2022".repeat(32)}
                </code>
                <button
                  type="button"
                  className={rowButtonCls}
                  onClick={() => toggleSecret(wh.id)}
                >
                  {revealedSecrets.has(wh.id) ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
                  {revealedSecrets.has(wh.id) ? "Hide" : "Reveal"}
                </button>
                <button
                  type="button"
                  className={rowButtonCls}
                  onClick={() =>
                    copyToClipboard(wh.secret, `secret-${wh.id}`)
                  }
                >
                  {copiedField === `secret-${wh.id}` ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
                  {copiedField === `secret-${wh.id}` ? "Copied" : "Copy"}
                </button>
              </div>

              {/* Stats */}
              <div className="flex gap-6 px-4 py-3 border-t border-border flex-wrap font-mono text-xs text-text-muted tabular-nums">
                <span>
                  Received <span className="text-text-secondary">{wh.receiveCount}</span>
                </span>
                <span>
                  Last received{" "}
                  <span className="text-text-secondary">
                    {wh.lastReceivedAt ? formatDate(wh.lastReceivedAt) : "never"}
                  </span>
                </span>
                <span>
                  Created <span className="text-text-secondary">{formatDate(wh.createdAt)}</span>
                </span>
              </div>

              {/* Linked Rules */}
              {getLinkedRules(wh.id).length > 0 && (
                <div className="px-4 py-3 border-t border-border flex flex-col gap-2">
                  <span className="text-xs text-text-muted">Linked rules</span>
                  <div className="flex flex-wrap gap-2">
                    {getLinkedRules(wh.id).map((r) => (
                      <button
                        type="button"
                        key={r.id}
                        onClick={() => navigate("/proactive")}
                        className="inline-flex items-center gap-2 h-7 px-2 rounded-md text-xs bg-raised border border-border text-text-secondary hover:text-text-primary cursor-pointer transition-colors"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${r.enabled ? "bg-success" : "bg-text-muted/50"}`} />
                        {r.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Link Existing Rule Dropdown */}
              {linkingWebhookId === wh.id && (
                <div className="px-4 py-3 border-t border-border flex flex-col gap-2">
                  <span className="text-xs text-text-muted">Link existing rule</span>
                  {getLinkableRules(wh.id).length === 0 ? (
                    <p className="text-[13px] text-text-muted">No event rules available to link</p>
                  ) : (
                    <div className="flex flex-col gap-1 max-h-[200px] overflow-y-auto">
                      {getLinkableRules(wh.id).map((r) => (
                        <button
                          type="button"
                          key={r.id}
                          onClick={() => linkRuleToWebhook(r.id, wh.id)}
                          className="flex items-center justify-between gap-3 h-8 px-3 rounded-md text-[13px] text-left border border-border text-text-secondary hover:bg-raised hover:text-text-primary transition-colors cursor-pointer"
                        >
                          <span className="truncate">{r.name}</span>
                          <span className="font-mono text-xs text-text-muted shrink-0">{r.actionType}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
