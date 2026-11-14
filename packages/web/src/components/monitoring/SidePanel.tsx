import { useEffect, useRef, useState } from "react";
import { MessageSquareText, X } from "lucide-react";
import type { MonitorTarget, TargetEdit } from "../../hooks/useMonitoring";
import { canActOn } from "../../hooks/useTargetActions";
import { formatTimeAgo } from "../../lib/format";
import { Button, IconButton, Input } from "../ui";
import { targetMessage, useChatAbout } from "./chatAbout";
import ExposureBadge from "./ExposureBadge";
import History from "./History";
import LatencySection from "./LatencySection";
import LogsSection from "./LogsSection";
import { outsideSummary } from "./OutsideMark";
import RestartSection from "./RestartSection";
import { whereOf } from "./ServiceRow";
import StatusDot from "./StatusDot";

interface Form { title: string; project: string; notes: string; expectedStatus: string }

const formOf = (t: MonitorTarget): Form => ({ title: t.title, project: t.project ?? "", notes: t.notes ?? "", expectedStatus: t.expectedStatus?.toString() ?? "" });

/** Only the fields that differ from the target, in the shape the API takes. */
function changesIn(form: Form, t: MonitorTarget): TargetEdit {
  const saved = formOf(t);
  return {
    ...(form.title !== saved.title && { title: form.title }),
    ...(form.project !== saved.project && { project: form.project || null }),
    ...(form.notes !== saved.notes && { notes: form.notes || null }),
    ...(form.expectedStatus !== saved.expectedStatus && { expectedStatus: form.expectedStatus ? Number(form.expectedStatus) : null }),
  };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 py-1.5 text-[13px]">
      <dt className="text-text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words font-mono text-xs text-text-secondary">{children}</dd>
    </div>
  );
}

function containerLine(t: MonitorTarget): string | null {
  const c = t.containerState;
  if (!c) return null;
  return [c.state, c.health, c.restarts ? `${c.restarts} restarts` : null, c.oomKilled ? "killed for memory" : null].filter(Boolean).join(", ");
}

interface SidePanelProps {
  target: MonitorTarget;
  onClose: () => void;
  onEdit: (key: string, edit: TargetEdit) => Promise<void>;
  /** Set while the target has an open incident: starts a diagnosis of it. */
  onDiagnose?: () => void;
}

/**
 * Everything about one target, and the controls for it. Opens as a modal drawer.
 * The facts, latency, logs and buttons are plain sections, so more can be added between them.
 */
export default function SidePanel({ target, onClose, onEdit, onDiagnose }: SidePanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const chatAbout = useChatAbout();
  const [form, setForm] = useState(() => formOf(target));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // A restart changes what the log says; a new key makes the logs load again.
  const [restarts, setRestarts] = useState(0);

  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, []);

  const changes = changesIn(form, target);
  const dirty = Object.keys(changes).length > 0;

  const save = async (edit: TargetEdit) => {
    setSaving(true);
    try {
      await onEdit(target.key, edit);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}
      className="m-0 ml-auto h-[100dvh] max-h-none w-full max-w-md border-l border-border bg-glass p-0 text-text-primary backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <StatusDot state={target.state} />
          <h3 className="m-0 min-w-0 flex-1 truncate text-[15px] font-medium">{target.title}</h3>
          <IconButton label="Chat about this" onClick={() => chatAbout(targetMessage(target))}><MessageSquareText size={16} strokeWidth={1.5} /></IconButton>
          <IconButton label="Close" onClick={onClose}><X size={16} strokeWidth={1.5} /></IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {target.state !== "up" && target.message && <p className="mb-3 text-sm text-error">{target.message}</p>}
          {target.warnings.map((w) => <p key={w.key} className="mb-3 text-sm text-accent-ink">{w.text}</p>)}

          <section className="mb-5">
            <div className="mb-2 flex items-center gap-3">
              <History target={target} />
              <span className="font-mono text-xs text-text-secondary">{target.uptime === null ? "" : `${target.uptime}% over 30 days`}</span>
            </div>
            <dl className="m-0">
              <Fact label="Reach">{target.exposure && <ExposureBadge exposure={target.exposure} />}</Fact>
              <Fact label="URL">{target.url}</Fact>
              <Fact label="Where">{whereOf(target)}</Fact>
              <Fact label="Bind">{target.bind}</Fact>
              <Fact label="Container">{target.container && [target.container, containerLine(target)].filter(Boolean).join(": ")}</Fact>
              <Fact label="Image">{target.image}</Fact>
              <Fact label="Unit">{target.unit}</Fact>
              <Fact label="Depends on">{target.dependsOn.join(", ")}</Fact>
              <Fact label="Found by">{target.sources.join(", ")}</Fact>
              <Fact label="Since">{target.statusSince && formatTimeAgo(target.statusSince)}</Fact>
              <Fact label="Outside">{target.outside && outsideSummary(target.outside)}</Fact>
              <Fact label="Outside error">{target.outside?.error}</Fact>
            </dl>
          </section>

          <LatencySection targetKey={target.key} />

          {canActOn(target) && (
            <>
              <LogsSection key={restarts} targetKey={target.key} />
              <RestartSection targetKey={target.key} name={target.container ?? target.unit ?? target.title} onRestarted={() => setRestarts((n) => n + 1)} />
            </>
          )}

          <section className="mb-5 flex flex-wrap gap-2">
            <Button size="sm" variant={target.tracked ? "outline" : "primary"} disabled={saving} onClick={() => save({ tracked: !target.tracked })}>
              {target.tracked ? "Stop tracking" : "Track"}
            </Button>
            <Button size="sm" variant="outline" disabled={saving} onClick={() => save({ hidden: !target.hidden })}>
              {target.hidden ? "Show" : "Hide"}
            </Button>
            {onDiagnose && <Button size="sm" variant="outline" onClick={onDiagnose}>Diagnose</Button>}
            {target.retired && <span className="self-center font-mono text-xs text-text-muted">Retired: discovery no longer sees it</span>}
          </section>

          <form
            onSubmit={(e) => { e.preventDefault(); void save(changes); }}
            className="flex flex-col gap-3"
          >
            <label className="flex flex-col gap-1 text-[13px] text-text-secondary">
              Title
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={120} />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-text-secondary">
              Project
              <Input value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} maxLength={60} />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-text-secondary">
              Notes
              <Input as="textarea" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={2000} />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-text-secondary">
              Expected status
              <Input type="number" min={100} max={599} placeholder="Any answer below 500" value={form.expectedStatus} onChange={(e) => setForm({ ...form, expectedStatus: e.target.value })} />
            </label>
            {error && <p className="m-0 text-sm text-error">{error}</p>}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={!dirty || saving}>Save</Button>
            </div>
          </form>
        </div>
      </div>
    </dialog>
  );
}
