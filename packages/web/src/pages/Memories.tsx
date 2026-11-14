import { useState } from "react";
import { useCrud } from "../hooks/useCrud";
import CrudTable, { type Column } from "../components/CrudTable";
import FormModal from "../components/FormModal";
import { Button, Input, PageHeader } from "../components/ui";

interface Memory {
  id: string;
  agentId: string | null;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

const columns: Column<Memory>[] = [
  { key: "category", label: "Category", render: (v) => <span className="font-mono text-xs text-text-secondary">{String(v)}</span> },
  { key: "content", label: "Content", render: (v) => String(v).slice(0, 100) + (String(v).length > 100 ? "…" : "") },
  {
    key: "agentId",
    label: "Agent",
    render: (v) => <span className="font-mono text-xs text-text-muted">{v ? String(v).slice(0, 8) : "global"}</span>,
  },
  {
    key: "createdAt",
    label: "Created",
    render: (v) => <span className="font-mono text-xs text-text-muted tabular-nums">{new Date(String(v)).toLocaleDateString()}</span>,
  },
];

export default function Memories() {
  const { items, loading, error, create, update, remove } = useCrud<Memory>("/memories");
  const [editing, setEditing] = useState<Memory | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ content: "", category: "facts", agentId: "" });
  const [filter, setFilter] = useState({ category: "", query: "" });

  const filtered = items.filter((m) => {
    if (filter.category && m.category !== filter.category) return false;
    if (filter.query && !m.content.toLowerCase().includes(filter.query.toLowerCase())) return false;
    return true;
  });

  function openNew() {
    setEditing(null);
    setForm({ content: "", category: "facts", agentId: "" });
    setShowForm(true);
  }

  function openEdit(memory: Memory) {
    setEditing(memory);
    setForm({ content: memory.content, category: memory.category, agentId: memory.agentId ?? "" });
    setShowForm(true);
  }

  async function handleSubmit() {
    if (editing) {
      await update(editing.id, { content: form.content });
    } else {
      await create({
        content: form.content,
        category: form.category,
        agentId: form.agentId || undefined,
      } as Partial<Memory>);
    }
    setShowForm(false);
  }

  return (
    <div className="p-6">
      <PageHeader title="Memories" action={<Button onClick={openNew}>Add memory</Button>} />
      <div className="flex gap-2 mb-4">
        <Input
          as="select"
          value={filter.category}
          onChange={(e) => setFilter({ ...filter, category: e.target.value })}
        >
          <option value="">All categories</option>
          <option value="preferences">Preferences</option>
          <option value="project-context">Project context</option>
          <option value="facts">Facts</option>
          <option value="instructions">Instructions</option>
        </Input>
        <Input
          className="flex-1"
          placeholder="Search memories"
          value={filter.query}
          onChange={(e) => setFilter({ ...filter, query: e.target.value })}
        />
      </div>
      <CrudTable
        items={filtered}
        columns={columns}
        loading={loading}
        error={error}
        onEdit={openEdit}
        onDelete={(id) => remove(id)}
      />
      <FormModal title={editing ? "Edit memory" : "New memory"} open={showForm} onClose={() => setShowForm(false)} onSubmit={handleSubmit}>
        {!editing && (
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Category
            <Input as="select" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="preferences">Preferences</option>
              <option value="project-context">Project context</option>
              <option value="facts">Facts</option>
              <option value="instructions">Instructions</option>
            </Input>
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Content<Input as="textarea" className="min-h-[120px] resize-y" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} /></label>
      </FormModal>
    </div>
  );
}
