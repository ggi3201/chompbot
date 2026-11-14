import { useState } from "react";
import { useCrud } from "../hooks/useCrud";
import FormModal from "../components/FormModal";
import { Button, GlassCard, Input, PageHeader } from "../components/ui";
import { apiFetch } from "../lib/api";
import { Star, Pencil, Trash2, Plus, Upload } from "lucide-react";

interface Soul {
  id: string;
  name: string;
  description: string;
  content: string;
  imageUrl: string | null;
  color: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

const COLORS = [
  { name: "violet", swatch: "bg-violet-400" },
  { name: "emerald", swatch: "bg-emerald-400" },
  { name: "pink", swatch: "bg-pink-400" },
  { name: "cyan", swatch: "bg-cyan-400" },
  { name: "amber", swatch: "bg-amber-400" },
  { name: "blue", swatch: "bg-blue-400" },
  { name: "purple", swatch: "bg-purple-400" },
];

function getColor(name: string) {
  return COLORS.find((c) => c.name === name) ?? COLORS[0];
}

const iconButton =
  "size-8 inline-flex items-center justify-center rounded-md bg-transparent border-none cursor-pointer transition-colors";

function SoulCard({ soul, onEdit, onDelete, onSetDefault }: {
  soul: Soul;
  onEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const c = getColor(soul.color);

  return (
    <GlassCard hover className="overflow-hidden flex flex-col">
      <button
        type="button"
        onClick={onEdit}
        className="text-left bg-transparent border-none p-0 cursor-pointer w-full"
      >
        {soul.imageUrl && (
          <div className="h-28 overflow-hidden border-b border-border">
            <img src={soul.imageUrl} alt="" className="w-full h-full object-cover" />
          </div>
        )}

        <div className="px-4 py-3">
          <div className="flex items-center gap-2">
            {!soul.imageUrl && (
              <span className="size-8 shrink-0 rounded-md bg-raised border border-border flex items-center justify-center text-sm font-medium text-text-secondary select-none">
                {soul.name.charAt(0).toUpperCase()}
              </span>
            )}
            <span className={`size-2 shrink-0 rounded-full ${c.swatch}`} title={c.name} />
            <h3 className="text-sm font-medium text-text-primary m-0 truncate">{soul.name}</h3>
            {soul.isDefault && (
              <span className="ml-auto font-mono text-xs text-text-muted shrink-0">default</span>
            )}
          </div>
          {soul.description && (
            <p className="mt-2 text-sm text-text-secondary m-0 line-clamp-2">{soul.description}</p>
          )}
          <div className="mt-2 font-mono text-xs text-text-muted truncate">
            {soul.content ? soul.content.split("\n").filter(Boolean)[0] : "Empty agent"}
          </div>
        </div>
      </button>

      <div className="flex items-center gap-1 px-2 py-1 border-t border-border mt-auto">
        <button
          type="button"
          onClick={onSetDefault}
          className={`${iconButton} ${
            soul.isDefault ? "text-accent-ink" : "text-text-muted hover:text-text-primary hover:bg-raised"
          }`}
          title={soul.isDefault ? "Default agent" : "Set as default"}
          aria-label={soul.isDefault ? "Default agent" : "Set as default"}
        >
          <Star size={16} strokeWidth={1.5} fill={soul.isDefault ? "currentColor" : "none"} />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onEdit}
          className={`${iconButton} text-text-muted hover:text-text-primary hover:bg-raised`}
          title="Edit"
          aria-label="Edit"
        >
          <Pencil size={16} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className={`${iconButton} text-text-muted hover:text-error hover:bg-error/10`}
          title="Delete"
          aria-label="Delete"
        >
          <Trash2 size={16} strokeWidth={1.5} />
        </button>
      </div>
    </GlassCard>
  );
}

export default function Souls() {
  const { items, loading, error, create, update, remove } = useCrud<Soul>("/souls");
  const [editing, setEditing] = useState<Soul | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    content: "",
    imageUrl: "" as string,
    color: "violet",
    isDefault: false,
  });
  const [uploading, setUploading] = useState(false);

  function openNew() {
    setEditing(null);
    setForm({ name: "", description: "", content: "", imageUrl: "", color: "violet", isDefault: false });
    setShowForm(true);
  }

  function openEdit(soul: Soul) {
    setEditing(soul);
    setForm({
      name: soul.name,
      description: soul.description,
      content: soul.content,
      imageUrl: soul.imageUrl ?? "",
      color: soul.color,
      isDefault: soul.isDefault,
    });
    setShowForm(true);
  }

  async function handleSubmit() {
    const payload = { ...form, imageUrl: form.imageUrl || null };
    if (editing) {
      await update(editing.id, payload as Partial<Soul>);
    } else {
      await create(payload as Partial<Soul>);
    }
    setShowForm(false);
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const res = await apiFetch("/uploads", {
        method: "POST",
        body: JSON.stringify({ data: base64, mimeType: file.type }),
      });
      if (res.ok) {
        const { url } = await res.json();
        setForm((f) => ({ ...f, imageUrl: url }));
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleSetDefault(soul: Soul) {
    await update(soul.id, { isDefault: true } as Partial<Soul>);
  }

  if (loading) {
    return (
      <div className="p-6">
        <PageHeader title="Agents" />
        <p className="text-text-muted text-sm">Loading</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Agents"
        action={
          <Button variant="primary" onClick={openNew}>
            <Plus size={16} strokeWidth={1.5} /> New agent
          </Button>
        }
      />

      {error && <p className="text-error text-sm mb-4">{error}</p>}

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="size-12 rounded-lg bg-raised border border-border flex items-center justify-center mb-4">
            <Star size={20} strokeWidth={1.5} className="text-text-muted" />
          </div>
          <h3 className="text-text-primary text-base font-medium m-0 mb-1">No agents yet</h3>
          <p className="text-text-secondary text-sm m-0 mb-4 max-w-xs">
            An agent is how Chomp behaves: its voice, style, values and quirks. Any agent can run on any provider and model.
          </p>
          <Button variant="primary" onClick={openNew}>
            <Plus size={16} strokeWidth={1.5} /> Create your first agent
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((soul) => (
            <SoulCard
              key={soul.id}
              soul={soul}
              onEdit={() => openEdit(soul)}
              onDelete={() => remove(soul.id)}
              onSetDefault={() => handleSetDefault(soul)}
            />
          ))}
        </div>
      )}

      <FormModal
        title={editing ? "Edit agent" : "New agent"}
        open={showForm}
        onClose={() => setShowForm(false)}
        onSubmit={handleSubmit}
      >
        {/* Name */}
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Name
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="For example: professional, casual, pirate" />
        </label>

        {/* Description */}
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Description
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Short tagline for this soul" />
        </label>

        {/* Image */}
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Image
          <div className="flex items-center gap-2">
            {form.imageUrl && (
              <img src={form.imageUrl} alt="" className="size-10 rounded-md object-cover border border-border" />
            )}
            <label className="inline-flex items-center gap-2 h-8 px-3 rounded-md bg-raised border border-border text-text-primary text-[13px] font-medium cursor-pointer hover:bg-[#2a2a2d] transition-colors">
              <Upload size={16} strokeWidth={1.5} />
              {uploading ? "Uploading" : "Upload image"}
              <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
            </label>
            {form.imageUrl && (
              <button
                type="button"
                onClick={() => setForm({ ...form, imageUrl: "" })}
                className="text-xs text-text-muted hover:text-error cursor-pointer bg-transparent border-none transition-colors"
              >
                Remove
              </button>
            )}
          </div>
        </label>

        {/* Color */}
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Color
          <div className="flex gap-3 mt-1">
            {COLORS.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => setForm({ ...form, color: c.name })}
                className={`size-6 rounded-full border-none cursor-pointer ${c.swatch} ${
                  form.color === c.name ? "ring-2 ring-white/40 ring-offset-2 ring-offset-glass" : ""
                }`}
                title={c.name}
                aria-label={c.name}
                aria-pressed={form.color === c.name}
              />
            ))}
          </div>
        </label>

        {/* Content (the actual soul markdown) */}
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Soul content
          <Input
            as="textarea"
            className="w-full resize-y font-mono text-[13px]"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            rows={14}
            placeholder={"# Personality\n- Direct, no fluff\n- Dry humor\n\n# Communication Style\n- Short sentences\n- Active voice\n\n# Values\n- Privacy first\n- Honesty over comfort"}
          />
        </label>

        {/* Default toggle */}
        <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
            className="accent-accent"
          />
          Set as default agent (used when nothing picks a specific one)
        </label>
      </FormModal>
    </div>
  );
}
