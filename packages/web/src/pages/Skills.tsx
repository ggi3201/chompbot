import { useState } from "react";
import {
  Search, Home, TrendingUp, Palette, Code2, Mail, Newspaper, UtensilsCrossed, Sparkles, type LucideIcon,
} from "lucide-react";
import { useCrud } from "../hooks/useCrud";
import FormModal from "../components/FormModal";
import { Button, Input, PageHeader } from "../components/ui";

interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Category {
  id: string;
  label: string;
  icon: LucideIcon;
  tint: string;
  match: RegExp;
}

// Class strings stay literal so Tailwind can see them. Order matters: first match wins.
const CATEGORIES: Category[] = [
  { id: "money", label: "Money", icon: TrendingUp, tint: "text-emerald bg-emerald/10", match: /stock|portfolio|crypto|insider|politician|chomp-calls/i },
  { id: "home", label: "Home", icon: Home, tint: "text-amber bg-amber/10", match: /home.?assistant|oven|nest|iphone|login-booth/i },
  { id: "build", label: "Build & ship", icon: Code2, tint: "text-blue bg-blue/10", match: /chomp-dev|github|ship|git-spice|mcp|sysadmin|deploy|appstore|expose|landing|vercel|agent-browser|ponytail/i },
  { id: "design", label: "Design & images", icon: Palette, tint: "text-pink bg-pink/10", match: /design|banner|brand|slides|ui-|image|banana|unslop|impeccable|emil/i },
  { id: "food", label: "Food & content", icon: UtensilsCrossed, tint: "text-violet bg-violet/10", match: /foodie|recipe|tiktok|linkedin|receipt|transcribe/i },
  { id: "comms", label: "Mail & calendar", icon: Mail, tint: "text-cyan bg-cyan/10", match: /gmail|calendar|drive|email|craft|reminder/i },
  { id: "world", label: "World & trips", icon: Newspaper, tint: "text-cyan bg-cyan/10", match: /weather|news|football|trend|flight|trips|brief|radar/i },
];
const OTHER: Category = { id: "other", label: "Other", icon: Sparkles, tint: "text-text-secondary bg-white/6", match: /./ };

// shortcut: name wins over description so "deploy-ios-app" isn't pulled into Food by its blurb; fine until names collide.
const categoryOf = (s: Skill) =>
  CATEGORIES.find((c) => c.match.test(s.name)) ?? CATEGORIES.find((c) => c.match.test(s.description)) ?? OTHER;

/** Descriptions are "<what it does>. Use when ... Triggers on 'a', 'b'" — split into a blurb and "say this" phrases. */
function parseDescription(description: string) {
  const [blurb] = description.split(/\s*(?:Use (?:when|this|it)|Triggers?)\b/i);
  const triggers = description.match(/Triggers?(?: on| include)?:?\s*(.+)$/is)?.[1] ?? "";
  const phrases = [...triggers.matchAll(/['"“]([^'"”]{2,40})['"”]/g)].map((m) => m[1]);
  return { blurb: blurb.trim() || description, phrases: phrases.slice(0, 4) };
}

const matches = (s: Skill, q: string) => `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase());

function Switch({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Enabled"
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      className={`w-8 h-[18px] rounded-full p-0.5 cursor-pointer transition-colors shrink-0 ${on ? "bg-emerald/70" : "bg-raised border border-border"}`}
    >
      <span className={`block size-3.5 rounded-full bg-text-primary transition-transform ${on ? "translate-x-3.5" : ""}`} />
    </button>
  );
}

function SkillCard({ skill, onOpen, onToggle }: { skill: Skill; onOpen: () => void; onToggle: () => void }) {
  const { icon: Icon, tint } = categoryOf(skill);
  const { blurb, phrases } = parseDescription(skill.description);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={`flex flex-col gap-3 p-4 rounded-lg border border-glass-border bg-glass cursor-pointer transition-colors hover:bg-glass-hover hover:border-glass-border-hover ${skill.enabled ? "" : "opacity-50"}`}
    >
      <div className="flex items-center gap-3">
        <span className={`grid place-items-center size-9 rounded-md shrink-0 ${tint}`}><Icon size={16} strokeWidth={1.5} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary truncate">{skill.name}</div>
          <div className="text-[11px] text-text-muted">{skill.source}</div>
        </div>
        <Switch on={skill.enabled} onChange={onToggle} />
      </div>
      <p className="m-0 text-[13px] leading-snug text-text-secondary line-clamp-3">{blurb}</p>
      {phrases.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-auto">
          {phrases.map((p) => (
            <span key={p} className="text-[11px] px-1.5 py-0.5 rounded-sm bg-raised border border-border text-text-muted">“{p}”</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Skills() {
  const { items, loading, error, create, update, remove } = useCrud<Skill>("/skills");
  const [editing, setEditing] = useState<Skill | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", content: "" });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");

  function openNew() {
    setEditing(null);
    setForm({ name: "", description: "", content: "" });
    setShowForm(true);
  }

  function openEdit(skill: Skill) {
    setEditing(skill);
    setForm({ name: skill.name, description: skill.description, content: skill.content });
    setShowForm(true);
  }

  async function handleSubmit() {
    if (editing) {
      await update(editing.id, form);
    } else {
      await create(form);
    }
    setShowForm(false);
  }

  async function handleDelete() {
    if (!editing || !confirm(`Delete "${editing.name}"?`)) return;
    await remove(editing.id);
    setShowForm(false);
  }

  const searched = items.filter((s) => matches(s, query));
  const visible = searched.filter((s) => category === "all" || categoryOf(s).id === category);
  const pills = [{ id: "all", label: "All", count: searched.length }, ...[...CATEGORIES, OTHER]
    .map((c) => ({ id: c.id, label: c.label, count: searched.filter((s) => categoryOf(s).id === c.id).length }))
    .filter((c) => c.count > 0)];

  return (
    <div className="p-6">
      <PageHeader title="Skills" action={<Button onClick={openNew}>Add skill</Button>} />
      <p className="mt-[-1rem] mb-5 text-sm text-text-muted">
        {items.filter((s) => s.enabled).length} of {items.length} skills on. Ask in the chat in your own words, and Chomp picks the right one. Or ask it to write a new skill for you.
      </p>

      <div className="relative mb-3">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        <Input
          className="w-full pl-9"
          placeholder="Search skills — try “stocks”, “recipe”, “lights”…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-1.5 mb-5">
        {pills.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setCategory(p.id)}
            className={`h-7 px-2.5 rounded-md border text-xs cursor-pointer transition-colors ${
              category === p.id
                ? "bg-raised border-white/14 text-text-primary"
                : "bg-transparent border-border text-text-muted hover:text-text-secondary hover:border-white/14"
            }`}
          >
            {p.label} <span className="text-text-muted">{p.count}</span>
          </button>
        ))}
      </div>

      {error && <p className="text-error text-sm">{error}</p>}
      {loading && <p className="text-text-muted text-sm">Loading…</p>}
      {!loading && visible.length === 0 && <p className="text-text-muted text-sm">Nothing matches. Chomp can't do that yet — or you could build it.</p>}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((s) => (
          <SkillCard key={s.id} skill={s} onOpen={() => openEdit(s)} onToggle={() => update(s.id, { enabled: !s.enabled } as Partial<Skill>)} />
        ))}
      </div>

      <FormModal title={editing ? "Edit skill" : "New skill"} open={showForm} onClose={() => setShowForm(false)} onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Name<Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Description<Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">Content (Markdown)<Input as="textarea" className="min-h-[200px] resize-y" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} /></label>
        {editing && <Button type="button" variant="danger" size="sm" className="self-start" onClick={handleDelete}>Delete skill</Button>}
      </FormModal>
    </div>
  );
}
