import { useState } from "react";
import { useAgentModels } from "../hooks/useAgentModels";
import { useCrud } from "../hooks/useCrud";
import RunTargetFields, { readRunTarget } from "../components/RunTargetFields";
import CrudTable, { type Column } from "../components/CrudTable";
import FormModal from "../components/FormModal";
import JsonEditor from "../components/JsonEditor";
import { Button, Input, Badge, PageHeader } from "../components/ui";
import { formatDate } from "../lib/format";

interface EventTrigger {
  id: string;
  name: string;
  description: string;
  eventType: string;
  condition: unknown[];
  action: Record<string, unknown>;
  enabled: boolean;
  cooldownSeconds: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const EVENT_TYPES = [
  "chat.message",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "schedule.completed",
  "schedule.failed",
  "service.health.changed",
  "user.active",
  "user.idle",
  "memory.saved",
  "webhook.received",
  "location.changed",
  "system.startup",
];

/** The one date format on this page, e.g. "3 Nov 2026, 14:05". */

/** The action being edited, while it is valid JSON of the delegate type. */
function parseDelegateAction(json: string): Record<string, unknown> | null {
  try {
    const action = JSON.parse(json) as Record<string, unknown>;
    return action?.type === "delegate" ? action : null;
  } catch {
    return null;
  }
}

const columns: Column<EventTrigger>[] = [
  { key: "name", label: "Name" },
  { key: "eventType", label: "Event", render: (v) => <Badge>{String(v)}</Badge> },
  { key: "action", label: "Action", render: (v) => {
    const a = v as Record<string, unknown>;
    return <span className="font-mono text-xs text-text-secondary">{String(a.type ?? "\u2014")}</span>;
  }},
  {
    key: "lastTriggeredAt",
    label: "Last fired",
    render: (v) => <span className="font-mono text-xs text-text-muted tabular-nums">{v ? formatDate(String(v)) : "never"}</span>,
  },
];

export default function Triggers() {
  const { items, loading, error, create, update, remove } = useCrud<EventTrigger>("/triggers");
  const providers = useAgentModels();
  const { items: souls } = useCrud<{ id: string; name: string }>("/souls");
  const [editing, setEditing] = useState<EventTrigger | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    eventType: "service.health.changed",
    condition: "[]",
    action: '{\n  "type": "notify",\n  "title": "",\n  "body": ""\n}',
    cooldownSeconds: "60",
  });

  function openNew() {
    setEditing(null);
    setForm({
      name: "",
      description: "",
      eventType: "service.health.changed",
      condition: "[]",
      action: '{\n  "type": "notify",\n  "title": "",\n  "body": ""\n}',
      cooldownSeconds: "60",
    });
    setShowForm(true);
  }

  function openEdit(trigger: EventTrigger) {
    setEditing(trigger);
    setForm({
      name: trigger.name,
      description: trigger.description,
      eventType: trigger.eventType,
      condition: JSON.stringify(trigger.condition, null, 2),
      action: JSON.stringify(trigger.action, null, 2),
      cooldownSeconds: String(trigger.cooldownSeconds),
    });
    setShowForm(true);
  }

  async function handleSubmit() {
    const data = {
      name: form.name,
      description: form.description,
      eventType: form.eventType,
      condition: JSON.parse(form.condition),
      action: JSON.parse(form.action),
      cooldownSeconds: parseInt(form.cooldownSeconds, 10) || 0,
    };
    if (editing) {
      await update(editing.id, data as unknown as Partial<EventTrigger>);
    } else {
      await create(data as unknown as Partial<EventTrigger>);
    }
    setShowForm(false);
  }

  const delegateAction = parseDelegateAction(form.action);

  return (
    <div className="p-6">
      <PageHeader title="Event triggers" action={<Button onClick={openNew}>Add trigger</Button>} />
      <CrudTable
        items={items}
        columns={columns}
        loading={loading}
        error={error}
        onEdit={openEdit}
        onDelete={(id) => remove(id)}
        onToggle={(id, enabled) => update(id, { enabled } as Partial<EventTrigger>)}
        enabledKey="enabled"
      />
      <FormModal title={editing ? "Edit trigger" : "New trigger"} open={showForm} onClose={() => setShowForm(false)} onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Name<Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Alert on service down" /></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Description<Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What this trigger does" /></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Event type
          <Input as="select" value={form.eventType} onChange={(e) => setForm({ ...form, eventType: e.target.value })}>
            {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Input>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Cooldown (seconds)<Input type="number" value={form.cooldownSeconds} onChange={(e) => setForm({ ...form, cooldownSeconds: e.target.value })} min="0" step="30" /></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Condition (JSON array of {`{field, op, value}`})</label>
        <JsonEditor value={form.condition} onChange={(v) => setForm({ ...form, condition: v })} />
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Action (JSON — type: notify/run-schedule/delegate, with prompt for delegate)</label>
        <JsonEditor value={form.action} onChange={(v) => setForm({ ...form, action: v })} />
        {delegateAction && (
          <RunTargetFields
            value={readRunTarget(delegateAction)}
            onChange={(target) => {
              const { provider: _provider, soulId: _soulId, model: _model, effort: _effort, ...rest } = delegateAction;
              setForm({ ...form, action: JSON.stringify({ ...rest, ...target }, null, 2) });
            }}
            providers={providers}
            souls={souls}
          />
        )}
      </FormModal>
    </div>
  );
}
