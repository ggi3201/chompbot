import { createHmac, timingSafeEqual } from "crypto";
import { execFile } from "child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { promisify } from "util";
import { join, resolve } from "path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { JWT_SECRET } from "../auth/config.js";
import { getApiKey } from "../chat/providers.js";
import { db } from "../db/index.js";
import { chatMessages, conversations, settings } from "../db/schema.js";
import { OPENAI_TTS_URL, DEFAULT_TTS_MODEL } from "../routes/voice.js";
import { publishLocalImages } from "../lib/chat-images.js";

const REPORTS_DIR = resolve(process.env.GOODMORNING_DIR ?? "./data/goodmorning");
const DEFAULT_VOICE = "ash";
const SPEAKING_STYLE = "A friend reading you the morning's news over coffee: dry, unhurried, conversational. Never a newsreader.";

const text = z.string().trim().min(1);

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => !Number.isNaN(Date.parse(date)));

export const reportSchema = z.object({
  date: dateSchema,
  place: text,
  headline: text,
  lead: text,
  headsUp: z.array(text).default([]),
  weather: z.object({
    summary: text,
    high: z.number().optional(),
    low: z.number().optional(),
    sunrise: text.optional(),
    sunset: text.optional(),
  }).optional(),
  take: z.object({ title: text, body: text, url: z.string().url() }).optional(),
  news: z.array(z.object({ title: text, why: text.optional(), source: text.optional(), url: z.string().url() })).default([]),
  inbox: z.array(z.object({ from: text, subject: text, action: text.optional() })).default([]),
  // Flights and hotels often live only in mail, so the calendar alone would show those days as free.
  travel: z.array(z.object({ date: dateSchema, title: text, time: text.optional() })).default([]),
  suggestions: z.array(text).max(3).default([]),
  // OpenAI's speech endpoint caps input at about 2000 tokens.
  voiceScript: text.max(3000),
});

export type MorningReport = z.infer<typeof reportSchema>;

/** The only credential on these links. Chomp itself is reachable over Tailscale alone. */
export function reportKey(): string {
  return createHmac("sha256", JWT_SECRET).update("goodmorning").digest("hex").slice(0, 32);
}

export function isReportKey(candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(reportKey());
  const given = Buffer.from(candidate);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function reportUrl(date: string): string {
  const domain = process.env.CHOMP_DOMAIN ?? `http://localhost:${process.env.PORT ?? "3001"}`;
  return `${domain}/goodmorning?date=${date}&key=${reportKey()}`;
}

function reportFile(date: string, extension: "json" | "mp3" | "ogg"): string {
  return join(REPORTS_DIR, `${date}.${extension}`);
}

/** The Chomp chat that holds a day's report. Stable, so publishing a date again updates it. */
export function reportConversationId(date: string): string {
  return `goodmorning-${date}`;
}

function reportAsText(report: MorningReport): string {
  const list = (title: string, lines: string[]) => (lines.length > 0 ? `**${title}**\n${lines.map((line) => `- ${line}`).join("\n")}` : "");
  return [
    `**${report.headline}**`,
    `${report.place}, ${report.date}`,
    report.lead,
    report.weather && `Weather: ${report.weather.summary}`,
    list("Before you go", report.headsUp),
    list("Travel", report.travel.map((trip) => [trip.date, trip.time, trip.title].filter(Boolean).join(" "))),
    report.take && `**One take: ${report.take.title}**\n${report.take.body}\n${report.take.url}`,
    list("Elsewhere", report.news.map((item) => `${item.title}: ${item.url}`)),
    list("Waiting on you", report.inbox.map((item) => [`${item.from}: ${item.subject}`, item.action].filter(Boolean).join(". "))),
  ].filter(Boolean).join("\n\n");
}

export function saveReport(report: MorningReport): void {
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(reportFile(report.date, "json"), JSON.stringify(report, null, 2));

  // The report opens a normal chat, so anything said about it runs in Chomp with this as context.
  const id = reportConversationId(report.date);
  const now = new Date().toISOString();
  db.insert(conversations).values({ id, title: `Morning report ${report.date}`, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
  const content = publishLocalImages(reportAsText(report));
  db.insert(chatMessages).values({ id, conversationId: id, role: "assistant", content, createdAt: now })
    .onConflictDoUpdate({ target: chatMessages.id, set: { content } })
    .run();
}

export function loadReport(date: string): MorningReport | null {
  const file = reportFile(date, "json");
  return existsSync(file) ? reportSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
}

export function voicePath(date: string): string | null {
  const file = reportFile(date, "mp3");
  return existsSync(file) ? file : null;
}

/** Speaks the report's script: an mp3 for the page, and Opus in Ogg for a Telegram voice note. */
export async function speakReport(report: MorningReport): Promise<string> {
  const apiKey = getApiKey("openai");
  if (!apiKey) throw new Error("OpenAI API key not configured");
  const voice = db.select().from(settings).where(eq(settings.key, "voice_tts_voice")).get()?.value || DEFAULT_VOICE;

  const response = await fetch(OPENAI_TTS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: DEFAULT_TTS_MODEL, input: report.voiceScript, voice, instructions: SPEAKING_STYLE, response_format: "mp3" }),
  });
  if (!response.ok) throw new Error(`TTS failed (${response.status}): ${(await response.text()).slice(0, 200)}`);

  mkdirSync(REPORTS_DIR, { recursive: true });
  const mp3 = reportFile(report.date, "mp3");
  const ogg = reportFile(report.date, "ogg");
  writeFileSync(mp3, Buffer.from(await response.arrayBuffer()));
  await promisify(execFile)("ffmpeg", ["-y", "-loglevel", "error", "-i", mp3, "-c:a", "libopus", "-b:a", "48k", ogg]);
  return ogg;
}
