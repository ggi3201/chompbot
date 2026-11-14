import { useNavigate } from "react-router-dom";
import type { IncidentDetail, MonitorTarget, OverviewWarning } from "../../hooks/useMonitoring";
import { chatPrefill } from "../../lib/chat-prefill";
import { EXPOSURE_LABELS } from "./ExposureBadge";
import { whereOf } from "./ServiceRow";

const ASK = "Look into this with the monitoring tools and tell me what you find and what you would do.";
const RECENT_EVENTS = 5;
const EVENT_TEXT_MAX = 200;

/** Joins the lines that have a value: "Label: value" pairs become one line each, headings stay as they are. */
const lines = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join("\n");
const fact = (label: string, value: string | number | null | undefined) => value !== null && value !== undefined && value !== "" && `${label}: ${value}`;

function targetFacts(t: MonitorTarget): (string | false | null | undefined)[] {
  return [
    fact("Kind", t.kind),
    fact("URL", t.url),
    fact("Reach", t.exposure && EXPOSURE_LABELS[t.exposure]),
    fact("Where", whereOf(t)),
    fact("Bind", t.bind),
    fact("Port", t.port),
    fact("Project", t.project),
    fact("Status", `${t.state}${t.statusSince ? ` since ${t.statusSince}` : ""}`),
    fact("Last error", t.state === "up" ? null : t.message),
    fact("Outside check", t.outside && `${t.outside.state}${t.outside.error ? `, ${t.outside.error}` : ""}`),
    fact("Notes", t.notes),
  ];
}

/** A warning from the "Needs attention" list, with the target it points at when there is one. */
export function warningMessage(w: OverviewWarning, target?: MonitorTarget | null): string {
  return lines([
    "Monitoring warning:",
    w.text,
    fact("Key", w.key),
    fact("Kind", w.kind),
    fact("First seen", w.firstSeen),
    w.critical && "It is past the line where it opens an incident.",
    target && `\nAbout the service ${target.title} (key: ${target.key}):`,
    ...(target ? targetFacts(target) : []),
    `\n${ASK}`,
  ]);
}

/** One service: its facts and the warnings on it. */
export function targetMessage(t: MonitorTarget): string {
  return lines([
    `Monitoring service: ${t.title} (key: ${t.key})`,
    ...targetFacts(t),
    t.warnings.length > 0 && "Warnings:",
    ...t.warnings.map((w) => `- ${w.text} (key: ${w.key})`),
    `\n${ASK}`,
  ]);
}

/** One incident: what it blames, who it hit and the latest events. */
export function incidentMessage(i: IncidentDetail): string {
  return lines([
    `Monitoring incident: ${i.title} (id: ${i.id})`,
    fact("State", `${i.state}${i.flapping ? ", flapping" : ""}`),
    fact("Started", i.startedAt),
    fact("Ended", i.endedAt),
    fact("Cause", i.cause),
    fact("First error", i.msg),
    i.targets.length > 0 && "Affected services:",
    ...i.targets.map((t) => `- ${t.title} (key: ${t.key}), down ${t.downAt}${t.upAt ? `, up ${t.upAt}` : ""}`),
    i.events.length > 0 && "Latest events:",
    // The diagnosis is given whole below, so its events show only that one ran.
    ...i.events.slice(-RECENT_EVENTS).map((e) => `- ${e.ts} ${e.kind}${e.text && !e.kind.startsWith("diagnosis") ? `: ${e.text.slice(0, EVENT_TEXT_MAX)}` : ""}`),
    i.diagnosisText && `\nLatest diagnosis:\n${i.diagnosisText}`,
    `\n${ASK}`,
  ]);
}

/** Opens a new chat with the text in the composer. It does not send. */
export function useChatAbout() {
  const navigate = useNavigate();
  return (message: string) => navigate("/chat", { state: chatPrefill(message) });
}
