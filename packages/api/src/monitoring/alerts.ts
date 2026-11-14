import { and, eq, inArray, isNull } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import { db } from "../db/index.js";
import { incidentEvents, incidents, monitorWarnings } from "../db/schema.js";
import { emit } from "../events/bus.js";
import { markdownToTelegramHtml } from "../telegram/format.js";
import { alertsTarget } from "./alerts-client.js";
import { getIncident, type IncidentDetail } from "./incident-views.js";
import { getUserTimezone } from "../proactive/engine.js";

/** What happened to an incident, as far as the alert message is concerned. */
export type IncidentNotice = "opened" | "changed" | "reopened" | "flapping" | "stable" | "resolved";

/** More incidents than this inside the window become one summary message. */
export const FLOOD_LIMIT = 5;
export const FLOOD_WINDOW_MS = 2 * 60_000;
/** More new warnings than this in one pass become one summary message. */
export const WARNING_BURST = 5;
const TELEGRAM_TEXT_LIMIT = 3900;
const MAX_LISTED_TARGETS = 8;

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clock = (ts: string) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: getUserTimezone() });

// ── Text ────────────────────────────────────────────────────────────────

/** The alert message for an incident as it stands now. HTML, so every piece of data is escaped. */
export function renderIncident(incident: IncidentDetail): string {
  const lines = [`<b>${escapeHtml(incident.title)}</b>`];
  if (incident.state === "resolved") {
    const resolved = incident.events.filter((e) => e.kind === "resolved").at(-1);
    lines.push(escapeHtml(resolved?.text ?? "Recovered"));
    return lines.join("\n");
  }
  const error = incident.events.find((e) => e.kind === "opened")?.text;
  if (error && error !== incident.title) lines.push(escapeHtml(error));
  // The title already names a service that is its own cause.
  const sole = incident.targets.length === 1 && incident.targets[0].key === incident.causeKey;
  if (!sole) {
    lines.push(`Cause: ${escapeHtml(incident.cause)}`);
    const down = incident.targets.filter((t) => t.upAt === null).map((t) => t.title);
    if (down.length) {
      const shown = down.slice(0, MAX_LISTED_TARGETS).map(escapeHtml).join(", ");
      lines.push(`Down (${down.length}): ${shown}${down.length > MAX_LISTED_TARGETS ? `, +${down.length - MAX_LISTED_TARGETS} more` : ""}`);
    }
  }
  lines.push(`Since ${clock(incident.startedAt)}`);
  if (incident.flapping) lines.push("It keeps going up and down. No more messages until it has been stable for 15 min.");
  return lines.join("\n");
}

const diagnoseKeyboard = (incidentId: string) => new InlineKeyboard().text("Diagnose", `diag:${incidentId}`);

/** An agent's markdown answer as Telegram HTML, cut to fit one message. */
function answerHtml(markdown: string): string {
  const cut = markdown.length > TELEGRAM_TEXT_LIMIT ? `${markdown.slice(0, TELEGRAM_TEXT_LIMIT)}\n\n(Cut. The full answer is in Chomp.)` : markdown;
  return markdownToTelegramHtml(cut);
}

// ── Sending ─────────────────────────────────────────────────────────────

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const replyTo = (messageId: number) => ({ reply_parameters: { message_id: messageId, allow_sending_without_reply: true } });
/** Telegram answers an edit that changes nothing with an error. That is not a failure. */
const isNotModified = (err: unknown) => err instanceof Error && err.message.includes("message is not modified");

/** Opened times of the alerts sent or held back lately, for the flood guard. */
let recentOpens: number[] = [];
let floodSummary: { messageId: Promise<number>; lastAt: number } | null = null;

/** Forgets the flood guard's memory. For tests. */
export function resetAlertState(): void {
  recentOpens = [];
  floodSummary = null;
}

async function sendOpened(incident: IncidentDetail, now: number): Promise<void> {
  const target = alertsTarget()!;
  recentOpens = [...recentOpens.filter((at) => now - at < FLOOD_WINDOW_MS), now];
  if (recentOpens.length > FLOOD_LIMIT) {
    await sendFloodSummary(recentOpens.length, now);
    return;
  }
  const sent = await target.api.sendMessage(target.chatId, renderIncident(incident), { ...HTML, reply_markup: diagnoseKeyboard(incident.id) });
  db.update(incidents).set({ telegramMessageId: sent.message_id }).where(eq(incidents.id, incident.id)).run();
  db.insert(incidentEvents).values({ incidentId: incident.id, ts: new Date(now).toISOString(), kind: "alerted", text: "Telegram message sent" }).run();
}

/** One message for the whole burst, edited as it grows. The incidents it covers send nothing of their own. */
async function sendFloodSummary(count: number, now: number): Promise<void> {
  const target = alertsTarget()!;
  const text = `${count} incidents opened, see Chomp`;
  if (floodSummary && now - floodSummary.lastAt < FLOOD_WINDOW_MS) {
    floodSummary.lastAt = now;
    // Incidents are delivered side by side: the summary is shared as a promise, so a second one edits instead of sending again.
    const messageId = await floodSummary.messageId;
    await target.api.editMessageText(target.chatId, messageId, text).catch((err) => { if (!isNotModified(err)) throw err; });
    return;
  }
  const messageId = target.api.sendMessage(target.chatId, text).then((sent) => sent.message_id);
  const summary = { messageId, lastAt: now };
  floodSummary = summary;
  messageId.catch(() => { if (floodSummary === summary) floodSummary = null; });
  await messageId;
}

async function deliver(incidentId: string, notice: IncidentNotice, now: number): Promise<void> {
  const incident = getIncident(incidentId);
  if (!incident) return;
  const target = alertsTarget();
  if (!target) {
    console.log(`[monitoring] Alert skipped, the alerts bot is not set up: ${incident.title} (${notice})`);
    return;
  }
  if (notice === "opened") {
    if (!incident.telegramMessageId) await sendOpened(incident, now);
    return;
  }
  // No message means the incident was part of a flood summary, or its first message failed.
  const messageId = incident.telegramMessageId;
  if (!messageId) return;

  await target.api.editMessageText(target.chatId, messageId, renderIncident(incident), { ...HTML, reply_markup: diagnoseKeyboard(incident.id) })
    .catch((err) => { if (!isNotModified(err)) throw err; });
  if (notice === "resolved") {
    // Silent: the thread shows the end without a ping.
    await target.api.sendMessage(target.chatId, escapeHtml(incident.events.filter((e) => e.kind === "resolved").at(-1)?.text ?? "Recovered"), { ...HTML, ...replyTo(messageId), disable_notification: true });
  }
  if (notice === "reopened") {
    await target.api.sendMessage(target.chatId, `<b>${escapeHtml(incident.title)}</b>\nDown again`, { ...HTML, ...replyTo(messageId) });
  }
}

/** Each incident's messages go out one at a time, so an edit never overtakes the message it edits. */
const chains = new Map<string, Promise<void>>();

/** Tells the alerts chat about an incident. Does not wait: a slow or broken Telegram must not slow the checks. */
export function notifyIncident(incidentId: string, notice: IncidentNotice, now: number): void {
  // A flapping incident is silent until it settles. Decided here, not at delivery, so a late delivery cannot swallow what came before.
  const flapping = db.select({ flapping: incidents.flapping }).from(incidents).where(eq(incidents.id, incidentId)).get()?.flapping;
  if (flapping && notice !== "flapping" && notice !== "stable") return;
  const next = (chains.get(incidentId) ?? Promise.resolve())
    .then(() => deliver(incidentId, notice, now))
    .catch((err) => console.error(`[monitoring] Alert for incident ${incidentId} failed:`, err instanceof Error ? err.message : err));
  chains.set(incidentId, next);
  void next.then(() => { if (chains.get(incidentId) === next) chains.delete(incidentId); });
}

/** Resolves when the alerts queued so far have been sent. For tests. */
export const alertsIdle = async (): Promise<void> => { await Promise.all(chains.values()); };

/** Posts text as a reply under the incident's alert, and returns whether it was sent. */
export async function replyUnderAlert(incidentId: string, markdown: string): Promise<boolean> {
  const target = alertsTarget();
  const messageId = getIncident(incidentId)?.telegramMessageId;
  if (!target || !messageId) return false;
  const reply = replyTo(messageId);
  try {
    await target.api.sendMessage(target.chatId, answerHtml(markdown), { parse_mode: "HTML", ...reply });
  } catch {
    // The agent's markdown can still trip Telegram's HTML parser; plain text always goes through.
    await target.api.sendMessage(target.chatId, markdown.slice(0, TELEGRAM_TEXT_LIMIT), reply);
  }
  return true;
}

// ── Warnings ────────────────────────────────────────────────────────────

/**
 * Each new warning is announced once: an event on the bus, and one silent message. Warnings are marked first,
 * so a slow send never sends twice. With the alerts bot not set up they are marked and logged, so setting it up later
 * does not replay the old ones. More than WARNING_BURST at once (the first run after an upgrade) become one message.
 */
export async function notifyNewWarnings(now = Date.now()): Promise<number> {
  const fresh = db.select().from(monitorWarnings)
    .where(and(isNull(monitorWarnings.resolvedAt), isNull(monitorWarnings.notifiedAt), eq(monitorWarnings.muted, false))).all();
  if (!fresh.length) return 0;
  db.update(monitorWarnings).set({ notifiedAt: new Date(now).toISOString() })
    .where(inArray(monitorWarnings.key, fresh.map((w) => w.key))).run();
  for (const w of fresh) emit({ type: "monitoring.warning.new", key: w.key, kind: w.kind, targetKey: w.targetKey, text: w.text });

  const target = alertsTarget();
  if (!target) {
    console.log(`[monitoring] ${fresh.length} new warning(s) not sent, the alerts bot is not set up`);
    return fresh.length;
  }
  const texts = fresh.length > WARNING_BURST ? [`${fresh.length} new warnings, see Chomp`] : fresh.map((w) => `<b>Warning</b>\n${escapeHtml(w.text)}`);
  for (const text of texts) {
    try {
      await target.api.sendMessage(target.chatId, text, { ...HTML, disable_notification: true });
    } catch (err) {
      console.error("[monitoring] Warning message failed:", err instanceof Error ? err.message : err);
    }
  }
  return fresh.length;
}
