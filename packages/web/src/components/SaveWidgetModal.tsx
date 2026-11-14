import { useEffect, useState } from "react";
import FormModal from "./FormModal";
import { Input } from "./ui";
import { apiFetch } from "../lib/api";

interface DashboardSummary {
  id: string;
  name: string;
  slug: string;
  widgetCount?: number;
}

interface SaveWidgetModalProps {
  open: boolean;
  messageId: string | null;
  defaultTitle?: string;
  onClose: () => void;
  onSaved?: (result: { dashboardId: string; widgetId: string; dashboardSlug: string }) => void;
}

const NEW_DASHBOARD = "__new__";

export default function SaveWidgetModal({
  open,
  messageId,
  defaultTitle,
  onClose,
  onSaved,
}: SaveWidgetModalProps) {
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [title, setTitle] = useState(defaultTitle ?? "");
  const [dashboardId, setDashboardId] = useState<string>("");
  const [newDashboardName, setNewDashboardName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle ?? "");
    setNewDashboardName("");
    setError(null);
    apiFetch("/dashboards")
      .then(async (r) => {
        if (!r.ok) throw new Error("Failed to load dashboards");
        return r.json();
      })
      .then((items: DashboardSummary[]) => {
        setDashboards(items);
        setDashboardId(items.length > 0 ? items[0].id : NEW_DASHBOARD);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [open, defaultTitle]);

  async function handleSubmit() {
    if (!messageId) return;
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    if (dashboardId === NEW_DASHBOARD && !newDashboardName.trim()) {
      setError("New dashboard name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body =
        dashboardId === NEW_DASHBOARD
          ? { title: title.trim(), newDashboardName: newDashboardName.trim() }
          : { title: title.trim(), dashboardId };
      const res = await apiFetch(`/widgets/from-message/${messageId}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        setError(err.error ?? "Save failed");
        setSubmitting(false);
        return;
      }
      const widget = await res.json();
      const slug =
        dashboards.find((d) => d.id === widget.dashboardId)?.slug ??
        (newDashboardName.trim() || "");
      onSaved?.({ dashboardId: widget.dashboardId, widgetId: widget.id, dashboardSlug: slug });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal title="Save to board" open={open} onClose={onClose} onSubmit={handleSubmit}>
      <label className="text-[13px] text-text-secondary">Widget title</label>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Portfolio at a glance"
        autoFocus
      />

      <label className="text-[13px] text-text-secondary mt-2">Board</label>
      <Input
        as="select"
        value={dashboardId}
        onChange={(e) => setDashboardId((e.target as HTMLSelectElement).value)}
      >
        {dashboards.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} {d.widgetCount ? `(${d.widgetCount})` : ""}
          </option>
        ))}
        <option value={NEW_DASHBOARD}>New board</option>
      </Input>

      {dashboardId === NEW_DASHBOARD && (
        <>
          <label className="text-[13px] text-text-secondary mt-2">New board name</label>
          <Input
            value={newDashboardName}
            onChange={(e) => setNewDashboardName(e.target.value)}
            placeholder="e.g. Portfolio"
          />
        </>
      )}

      {error && <p className="text-[13px] text-error mt-1">{error}</p>}
      {submitting && <p className="font-mono text-xs text-text-muted mt-1">Saving</p>}
    </FormModal>
  );
}
