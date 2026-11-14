import { randomUUID } from "crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatMessages, conversations, incidentEvents, incidents, monitorChecks, monitorTargets } from "../db/schema.js";
import { replyUnderAlert } from "./alerts.js";
import { claimDiagnosis, getIncident, releaseDiagnosis, type IncidentDetail } from "./incident-views.js";

const MAX_TARGETS_IN_PROMPT = 6;
const CHECKS_PER_TARGET = 6;

export type DiagnosisStart = { started: true; done: Promise<void> } | { started: false; reason: "not-found" | "running" };

const addEvent = (incidentId: string, kind: string, text: string | null, now: number) =>
  db.insert(incidentEvents).values({ incidentId, ts: new Date(now).toISOString(), kind, text }).run();

type Clock = () => number;

/** What the agent is told: the facts Chomp already has, where to look next, and that it must only look. */
export function buildDiagnosisPrompt(incident: IncidentDetail): string {
  const down = incident.targets.filter((t) => t.upAt === null).slice(0, MAX_TARGETS_IN_PROMPT);
  const shown = down.length ? down : incident.targets.slice(0, MAX_TARGETS_IN_PROMPT);
  const rows = shown.length ? db.select().from(monitorTargets).where(inArray(monitorTargets.key, shown.map((t) => t.key))).all() : [];

  const targets = shown.map((t) => {
    const row = rows.find((r) => r.key === t.key);
    const checks = db.select().from(monitorChecks).where(eq(monitorChecks.targetKey, t.key))
      .orderBy(desc(monitorChecks.ts), desc(monitorChecks.id)).limit(CHECKS_PER_TARGET).all();
    const facts = row && [
      `kind ${row.kind}`, row.url && `url ${row.url}`, row.host && `host ${row.host}`, row.port && `port ${row.port}`,
      row.container && `container ${row.container}`, row.image && `image ${row.image}`, row.systemdUnit && `systemd unit ${row.systemdUnit}`,
      row.containerInfo && `docker says ${row.containerInfo.state}${row.containerInfo.health ? `, ${row.containerInfo.health}` : ""}, ${row.containerInfo.restarts} restarts${row.containerInfo.oomKilled ? ", killed for memory" : ""}`,
    ].filter(Boolean).join(", ");
    const lines = checks.map((c) => `    ${new Date(c.ts).toISOString()} ${c.vantage} ${c.ok ? "ok" : "FAILED"}${c.statusCode ? ` HTTP ${c.statusCode}` : ""}${c.latencyMs !== null ? ` ${c.latencyMs} ms` : ""}${c.error ? ` ${c.error}` : ""}`);
    return `- ${t.title} (${t.key}): down since ${t.downAt}${t.upAt ? `, up again ${t.upAt}` : ""}\n    ${facts ?? "no details"}\n  Last checks, newest first:\n${lines.join("\n") || "    none"}`;
  });

  const timeline = incident.events.filter((e) => !e.kind.startsWith("diagnosis")).slice(-12).map((e) => `- ${e.ts} ${e.kind}${e.text ? `: ${e.text}` : ""}`);

  return [
    `Diagnose this monitoring incident on the home lab and tell me what is wrong.`,
    ``,
    `Incident: ${incident.title}`,
    `State: ${incident.state}${incident.flapping ? ", flapping (it keeps going up and down)" : ""}, started ${incident.startedAt}`,
    `Cause Chomp picked: ${incident.cause} (${incident.causeKey})`,
    incident.msg ? `First error: ${incident.msg}` : null,
    ``,
    `Affected services:`,
    ...(targets.length ? targets : ["- none: this is a host incident, see the cause above"]),
    ``,
    `Timeline:`,
    ...timeline,
    ``,
    `You run on the machine Chomp runs on. You may read things, with whichever of these it has: \`docker ps\`, \`docker inspect\`, \`docker logs --tail 200 <container>\`, \`journalctl -u <unit> -n 200\` (Linux), recent deploys (git log, the GitHub Actions runner logs), and host load (\`uptime\`, \`free -h\`, \`df -h\`, \`docker stats --no-stream\`).`,
    `Do not restart, stop, start, change, delete or deploy anything. This is a read-only job.`,
    ``,
    `Answer with one chomp_reply message: what failed, the most likely cause, the log lines that show it, and what I should do next. Use short sentences and plain words. Keep it under 15 lines.`,
  ].filter((line) => line !== null).join("\n");
}

/** The incident's own conversation, created on the first diagnosis. A follow-up diagnosis continues in it. */
function conversationFor(incident: IncidentDetail, now: number): string {
  if (incident.conversationId) return incident.conversationId;
  const id = randomUUID();
  const stamp = new Date(now).toISOString();
  db.insert(conversations).values({ id, title: `Monitoring: ${incident.title}`, createdAt: stamp, updatedAt: stamp }).run();
  db.update(incidents).set({ conversationId: id }).where(eq(incidents.id, incident.id)).run();
  return id;
}

const assistantMessageIds = (conversationId: string) =>
  new Set(db.select({ id: chatMessages.id }).from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, "assistant"))).all().map((m) => m.id));

async function runDiagnosis(incident: IncidentDetail, clock: Clock): Promise<void> {
  try {
    addEvent(incident.id, "diagnosis_requested", null, clock());
    const conversationId = conversationFor(incident, clock());
    const before = assistantMessageIds(conversationId);
    const { dispatchToAgent } = await import("../agents/dispatch.js");
    const result = await dispatchToAgent(
      { action: "delegate", prompt: buildDiagnosisPrompt(incident), reason: "monitoring diagnosis" },
      { conversationId, send: () => {} },
      { deliveryChannel: "proactive", autonomy: "autonomous", label: `Diagnose: ${incident.title}` },
    );
    // The agent answers through chomp_reply, which writes chat_messages. result.response is only the prose after its last tool call.
    const replies = db.select().from(chatMessages)
      .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, "assistant")))
      .orderBy(chatMessages.createdAt, sql`rowid`).all().filter((m) => !before.has(m.id));
    const answer = (replies.at(-1)?.content ?? result.response).trim();
    if (!answer) throw new Error("The agent gave no answer");
    addEvent(incident.id, "diagnosis", answer, clock());
    await replyUnderAlert(incident.id, answer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[monitoring] Diagnosis of incident ${incident.id} failed:`, message);
    addEvent(incident.id, "diagnosis_failed", message, clock());
    await replyUnderAlert(incident.id, `Diagnosis failed: ${message}`).catch(() => false);
  } finally {
    releaseDiagnosis(incident.id);
  }
}

/**
 * Starts a diagnosis and returns at once; `done` settles when the answer is saved and posted.
 * One diagnosis runs per incident at a time. The answer lands on the timeline and under the Telegram alert.
 */
export function startDiagnosis(incidentId: string, clock: Clock = Date.now): DiagnosisStart {
  const incident = getIncident(incidentId);
  if (!incident) return { started: false, reason: "not-found" };
  if (!claimDiagnosis(incidentId)) return { started: false, reason: "running" };
  return { started: true, done: runDiagnosis(incident, clock) };
}
