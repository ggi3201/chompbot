import { asc, gte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatMessages } from "../db/schema.js";

export interface ChatRow {
  conversationId: string;
  role: string;
  /** The start of the message. */
  text: string;
  /** The end of the message. */
  tail: string;
  createdAt: string;
}

const LOOKBACK_DAYS = 365;
const MAX_CORRECTIONS = 120;
const MAX_CORRECTION_CHARS = 14_000;
const QUOTED_CHARS = 240;
const CONTEXT_CHARS = 110;
/** A short reply only makes sense next to what it answered. */
const NEEDS_CONTEXT_BELOW = 70;
/** Rules and schedules send the same prompt over and over. A person does not. */
const AUTOMATED_REPEATS = 6;
const TRIAL_POOL = 150;
const TRIAL_MIN_CHARS = 25;
const TRIAL_MAX_CHARS = 280;

/** A reply that pushes back on the turn before it, in English or Norwegian. */
const PUSHBACK = /^\s*(no+\b|nope|nah\b|nei\b|wrong|not (what|working|that)|that'?s not|thats not|stop\b|don'?t\b|dont\b|why\b|still\b|again\b|actually\b|wtf|huh\b|you (didn'?t|didnt|forgot|missed)|i (said|told|asked|meant)|it (doesn'?t|doesnt|didn'?t|didnt|isn'?t|isnt)|doesn'?t work|doesnt work|didn'?t work|didnt work|broken|too (long|much|many|wordy|verbose)|hvorfor|ikke\b|feil\b|igjen\b)/i;
/** A rule meant to hold from here on. */
const STANDING_RULE = /(from now on|\bremember\b|\balways\b|\bnever\b|every time|stop (doing|using|asking|adding|saying)|i (don'?t|dont) want|fra nå av|\bhusk\b)/i;
/** Not something a person would ask an agent in plain words. */
const NOT_A_REQUEST = /^(\/|@|\[|<|!\[|https?:)|^(test|testing|hi|hei|hey|hello|hest|ping)\b/i;

/** What the person really typed: quoted replies and pasted images say nothing about them. */
function cleaned(text: string): string {
  return text
    .replace(/^\[Replying to: "[\s\S]*?"\]\s*/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function typedByAPerson(rows: ChatRow[]): ChatRow[] {
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.role === "user") seen.set(row.text.slice(0, 60), (seen.get(row.text.slice(0, 60)) ?? 0) + 1);
  }
  return rows.filter((row) => row.role !== "user" || (seen.get(row.text.slice(0, 60)) ?? 0) < AUTOMATED_REPEATS);
}

/** Rows in conversation order. Reading only the ends of each message keeps this cheap on a large database. */
export function readChatRows(): ChatRow[] {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  return db
    .select({
      conversationId: chatMessages.conversationId,
      role: chatMessages.role,
      text: sql<string>`substr(${chatMessages.content}, 1, 600)`,
      tail: sql<string>`substr(${chatMessages.content}, -${sql.raw(String(CONTEXT_CHARS))})`,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(gte(chatMessages.createdAt, since))
    .orderBy(asc(chatMessages.conversationId), asc(chatMessages.createdAt))
    .all();
}

/**
 * What the person has corrected, newest first. Stated preferences are weak evidence;
 * what someone actually pushed back on is much stronger, so the interview starts here.
 */
export function pickCorrections(rows: ChatRow[]): string[] {
  const found: Array<{ at: string; line: string }> = [];
  let lastReply = "";
  let conversation = "";
  for (const row of typedByAPerson(rows)) {
    if (row.conversationId !== conversation) {
      conversation = row.conversationId;
      lastReply = "";
    }
    if (row.role === "assistant") {
      lastReply = row.tail.replace(/\s+/g, " ").trim();
      continue;
    }
    const text = cleaned(row.text);
    if (!text || !(PUSHBACK.test(text) || STANDING_RULE.test(text))) continue;
    const context = text.length < NEEDS_CONTEXT_BELOW && lastReply ? ` (replying to: "${lastReply}")` : "";
    found.push({ at: row.createdAt, line: `- "${text.slice(0, QUOTED_CHARS)}"${context}` });
  }

  const lines: string[] = [];
  let chars = 0;
  for (const { line } of found.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_CORRECTIONS)) {
    if (chars + line.length > MAX_CORRECTION_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  return lines;
}

/** Real opening requests from recent conversations, to try a soul on. */
export function pickTrialMessages(rows: ChatRow[], count: number, random: () => number = Math.random): string[] {
  const openers: Array<{ at: string; text: string }> = [];
  let conversation = "";
  for (const row of typedByAPerson(rows)) {
    if (row.role !== "user" || row.conversationId === conversation) continue;
    conversation = row.conversationId;
    const text = cleaned(row.text);
    if (text.length >= TRIAL_MIN_CHARS && text.length <= TRIAL_MAX_CHARS && !NOT_A_REQUEST.test(text)) {
      openers.push({ at: row.createdAt, text });
    }
  }
  const pool = openers.sort((a, b) => b.at.localeCompare(a.at)).slice(0, TRIAL_POOL).map((o) => o.text);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return [...new Set(pool)].slice(0, count);
}
