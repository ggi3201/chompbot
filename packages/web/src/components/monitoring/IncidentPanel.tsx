import { useEffect, useRef, useState } from "react";
import { MessageSquareText, X } from "lucide-react";
import { useIncident } from "../../hooks/useMonitoring";
import { formatElapsed, formatTimeAgo } from "../../lib/format";
import Markdown from "../Markdown";
import { Button, IconButton, LiveDot } from "../ui";
import { incidentMessage, useChatAbout } from "./chatAbout";
import StatusDot from "./StatusDot";

const EVENT_LABELS: Record<string, string> = {
  opened: "Opened",
  joined: "Joined",
  up: "Back up",
  recovered: "All services up",
  resolved: "Resolved",
  reopened: "Down again",
  flapping: "Flapping",
  stable: "Stable",
  alerted: "Alert sent",
  retired: "Retired",
  note: "Note",
  diagnosis_requested: "Diagnosis requested",
  diagnosis: "Diagnosis",
  diagnosis_failed: "Diagnosis failed",
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

interface IncidentPanelProps {
  id: string;
  onClose: () => void;
  onOpenTarget: (key: string) => void;
}

/** One incident: what it blames, the services it affects, the diagnosis and the timeline. Opens as a modal drawer, like the target panel. */
export default function IncidentPanel({ id, onClose, onOpenTarget }: IncidentPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { incident, error, diagnose } = useIncident(id);
  const chatAbout = useChatAbout();
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");

  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, []);

  const ask = async () => {
    setAsking(true);
    try {
      await diagnose();
      setAskError("");
    } catch (err) {
      setAskError(err instanceof Error ? err.message : "Could not start the diagnosis");
    } finally {
      setAsking(false);
    }
  };

  const running = incident?.diagnosis === "running";
  const failure = incident?.diagnosis === "failed" ? incident.events.filter((e) => e.kind === "diagnosis_failed").at(-1)?.text : null;
  const seconds = incident?.endedAt ? Math.round((Date.parse(incident.endedAt) - Date.parse(incident.startedAt)) / 1000) : 0;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}
      className="m-0 ml-auto h-[100dvh] max-h-none w-full max-w-md border-l border-border bg-glass p-0 text-text-primary backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          {incident && <StatusDot state={incident.state === "open" ? "down" : "up"} />}
          <h3 className="m-0 min-w-0 flex-1 truncate text-[15px] font-medium">{incident?.title ?? "Incident"}</h3>
          {incident && <IconButton label="Chat about this" onClick={() => chatAbout(incidentMessage(incident))}><MessageSquareText size={16} strokeWidth={1.5} /></IconButton>}
          <IconButton label="Close" onClick={onClose}><X size={16} strokeWidth={1.5} /></IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && !incident && <p className="text-sm text-error">{error}</p>}
          {incident && (
            <>
              <section className="mb-5">
                <p className="m-0 font-mono text-xs text-text-secondary">
                  {incident.endedAt ? `Resolved after ${formatElapsed(seconds)}, ${formatTimeAgo(incident.endedAt)}` : `Ongoing since ${formatTimeAgo(incident.startedAt)}`}
                </p>
                {incident.flapping && <p className="mt-2 mb-0 text-sm text-accent-ink">Flapping: it keeps going up and down. Alerts pause until it is stable for 15 minutes.</p>}
                <dl className="m-0 mt-2">
                  <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 py-1.5 text-[13px]">
                    <dt className="text-text-muted">Cause</dt>
                    <dd className="m-0 min-w-0 break-words font-mono text-xs text-text-secondary">{incident.cause}</dd>
                  </div>
                  {incident.msg && (
                    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 py-1.5 text-[13px]">
                      <dt className="text-text-muted">First error</dt>
                      <dd className="m-0 min-w-0 break-words font-mono text-xs text-text-secondary">{incident.msg}</dd>
                    </div>
                  )}
                </dl>
              </section>

              {incident.targets.length > 0 && (
                <section className="mb-5">
                  <h4 className="mb-2 mt-0 text-[13px] font-medium text-text-secondary">Affected services</h4>
                  {incident.targets.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => onOpenTarget(t.key)}
                      className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-2 text-left text-[13px] first:border-t-0"
                    >
                      <StatusDot state={t.upAt ? "up" : "down"} />
                      <span className="truncate text-text-primary">{t.title}</span>
                      <span className="font-mono text-xs text-text-muted">{t.upAt ? `up ${formatTimeAgo(t.upAt)}` : `down ${formatTimeAgo(t.downAt)}`}</span>
                    </button>
                  ))}
                </section>
              )}

              <section className="mb-5">
                <div className="mb-2 flex items-center gap-3">
                  <h4 className="m-0 flex-1 text-[13px] font-medium text-text-secondary">Diagnosis</h4>
                  <Button size="sm" variant={incident.diagnosisText ? "outline" : "primary"} disabled={running || asking} onClick={ask}>
                    {running && <LiveDot />}
                    {running ? "Diagnosing" : incident.diagnosisText ? "Diagnose again" : "Diagnose"}
                  </Button>
                </div>
                {running && <p className="m-0 text-sm text-text-muted">An agent is reading logs on the mini. This takes a minute or two.</p>}
                {failure && <p className="m-0 text-sm text-error">{failure}</p>}
                {askError && <p className="m-0 text-sm text-error">{askError}</p>}
                {incident.diagnosisText && <Markdown>{incident.diagnosisText}</Markdown>}
                {!running && !failure && !incident.diagnosisText && <p className="m-0 text-sm text-text-muted">An agent reads the logs and says what is wrong. It changes nothing.</p>}
              </section>

              <section>
                <h4 className="mb-2 mt-0 text-[13px] font-medium text-text-secondary">Timeline</h4>
                {incident.events.map((event) => (
                  <div key={event.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 border-t border-border py-2 text-[13px] first:border-t-0">
                    <span className="font-mono text-xs text-text-muted" title={`${day(event.ts)} ${clock(event.ts)}`}>{clock(event.ts)}</span>
                    <span className="min-w-0 break-words">
                      <span className="text-text-primary">{EVENT_LABELS[event.kind] ?? event.kind}</span>
                      {event.text && event.kind !== "diagnosis" && <span className="ml-2 text-text-muted">{event.text}</span>}
                    </span>
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
