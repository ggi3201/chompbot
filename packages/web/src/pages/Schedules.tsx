import { useState } from "react";
import type { RunTarget } from "@chomp/shared";
import { useAgentModels } from "../hooks/useAgentModels";
import { useCrud } from "../hooks/useCrud";
import RunTargetFields, { readRunTarget } from "../components/RunTargetFields";
import CrudTable, { type Column } from "../components/CrudTable";
import FormModal from "../components/FormModal";
import { apiFetch } from "../lib/api";
import { Play } from "lucide-react";
import { Button, Input, Badge, PageHeader } from "../components/ui";
import { formatDate } from "../lib/format";

interface Schedule {
  id: string;
  naturalLanguage: string;
  cronExpression: string;
  enabled: boolean;
  lastRun: string | null;
  lastResult: string | null;
  context: { services?: string[]; prompt?: string; target?: Record<string, unknown> };
  createdAt: string;
  updatedAt: string;
}

/** The one date format on this page, e.g. "3 Nov 2026, 14:05". */

const columns: Column<Schedule>[] = [
  { key: "naturalLanguage", label: "Schedule" },
  { key: "cronExpression", label: "Cron", render: (v) => <Badge>{String(v)}</Badge> },
  {
    key: "lastRun",
    label: "Last run",
    render: (v) => <span className="font-mono text-xs text-text-muted tabular-nums">{v ? formatDate(String(v)) : "never"}</span>,
  },
  { key: "lastResult", label: "Result", render: (v) => String(v ?? "\u2014").slice(0, 50) + (String(v ?? "").length > 50 ? "\u2026" : "") },
];

export default function Schedules() {
  const { items, loading, error, create, update, remove, refresh } = useCrud<Schedule>("/schedules");
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [showForm, setShowForm] = useState(false);
  const providers = useAgentModels();
  const { items: souls } = useCrud<{ id: string; name: string }>("/souls");
  const [form, setForm] = useState({ naturalLanguage: "", cronExpression: "", target: {} as RunTarget, contextPrompt: "" });

  function openNew() {
    setEditing(null);
    setForm({ naturalLanguage: "", cronExpression: "", target: {}, contextPrompt: "" });
    setShowForm(true);
  }

  function openEdit(schedule: Schedule) {
    setEditing(schedule);
    setForm({
      naturalLanguage: schedule.naturalLanguage,
      cronExpression: schedule.cronExpression,
      target: readRunTarget(schedule.context.target ?? {}),
      contextPrompt: schedule.context.prompt ?? "",
    });
    setShowForm(true);
  }

  async function handleSubmit() {
    const data = {
      naturalLanguage: form.naturalLanguage,
      cronExpression: form.cronExpression || undefined,
      context: {
        ...(form.contextPrompt ? { prompt: form.contextPrompt } : {}),
        ...(Object.keys(form.target).length > 0 ? { target: form.target } : {}),
      },
    };
    if (editing) {
      await update(editing.id, data as unknown as Partial<Schedule>);
    } else {
      await create(data as unknown as Partial<Schedule>);
    }
    setShowForm(false);
  }

  async function handleTrigger(id: string) {
    await apiFetch(`/schedules/${id}/trigger`, { method: "POST" });
    refresh();
  }

  return (
    <div className="p-6">
      <PageHeader title="Schedules" action={<Button onClick={openNew}>Add schedule</Button>} />
      <CrudTable
        items={items}
        columns={columns}
        loading={loading}
        error={error}
        onEdit={openEdit}
        onDelete={(id) => remove(id)}
        onToggle={(id, enabled) => update(id, { enabled } as Partial<Schedule>)}
        enabledKey="enabled"
      />
      {items.length > 0 && (
        <div className="mt-6">
          <h3 className="text-[13px] text-text-muted mb-2">Run now</h3>
          <div className="flex gap-2 flex-wrap">
            {items.map((s) => (
              <Button
                key={s.id}
                variant="outline"
                size="sm"
                onClick={() => handleTrigger(s.id)}
                disabled={!s.enabled}
              >
                <Play size={14} strokeWidth={1.5} />
                {s.naturalLanguage.slice(0, 30)}
              </Button>
            ))}
          </div>
        </div>
      )}
      <FormModal title={editing ? "Edit schedule" : "New schedule"} open={showForm} onClose={() => setShowForm(false)} onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Description (natural language)
          <Input value={form.naturalLanguage} onChange={(e) => setForm({ ...form, naturalLanguage: e.target.value })} placeholder="e.g. Every morning at 8am" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Cron expression (optional)
          <Input value={form.cronExpression} onChange={(e) => setForm({ ...form, cronExpression: e.target.value })} placeholder="e.g. 0 8 * * *" />
        </label>
        <RunTargetFields value={form.target} onChange={(target) => setForm({ ...form, target })} providers={providers} souls={souls} />
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Context and instructions
          <Input as="textarea" className="min-h-[60px] resize-y" value={form.contextPrompt} onChange={(e) => setForm({ ...form, contextPrompt: e.target.value })} placeholder="Additional instructions for this scheduled task" />
        </label>
      </FormModal>
    </div>
  );
}
