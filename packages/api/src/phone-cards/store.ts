import { randomUUID } from "crypto";
import { asc, eq, gt, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { phoneCards } from "../db/schema.js";

const text = z.string().trim().min(1);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());

// The limits are what still reads in a small widget. A refused card makes the agent write a shorter one.
const cardSchema = z.object({
  showFrom: instant,
  showUntil: instant,
  headline: text.max(48),
  detail: text.max(60).optional(),
  countdownTo: instant.optional(),
  alerts: z.array(z.object({ at: instant, text })).default([]),
  icon: z.string().regex(/^[a-z0-9.]+$/, "must be an SF Symbol name").optional(),
  tone: z.enum(["normal", "urgent"]).default("normal"),
  rows: z.array(z.object({ label: text.max(14), value: text.max(22) })).max(4).default([]),
  link: z.string().url().optional(),
  source: text.optional(),
  checkedAt: instant.optional(),
}).refine((card) => card.showFrom < card.showUntil, { message: "showUntil must be after showFrom" });

export const publishSchema = z.object({
  group: text,
  board: text.default("today"),
  cards: z.array(cardSchema).min(1),
}).refine(({ cards }) => cards.some((card) => card.showUntil > new Date().toISOString()), {
  message: "every card has already ended",
});

export type PublishInput = z.infer<typeof publishSchema>;

/** The countdown times still ahead, to tell a moved time from a reworded card. */
function upcomingCountdowns(cards: { countdownTo?: string | null }[], now: string): string {
  const times = cards.flatMap(({ countdownTo }) => (countdownTo && countdownTo > now ? [countdownTo] : []));
  return JSON.stringify([...new Set(times)].sort());
}

/**
 * Replaces the group's cards and clears out cards that have ended. Returns the
 * headline to announce when a countdown moved, and null for anything else.
 */
export function publishPhoneCards({ group, board, cards }: PublishInput): string | null {
  const now = new Date().toISOString();
  return db.transaction((tx) => {
    const previous = tx.select().from(phoneCards).where(eq(phoneCards.groupKey, group)).all();
    tx.delete(phoneCards).where(eq(phoneCards.groupKey, group)).run();
    tx.delete(phoneCards).where(lte(phoneCards.showUntil, now)).run();
    tx.insert(phoneCards).values(cards.map((card) => ({ id: randomUUID(), groupKey: group, board, ...card }))).run();

    const before = upcomingCountdowns(previous, now);
    if (before === "[]" || before === upcomingCountdowns(cards, now)) return null;
    const next = cards.filter((card) => card.showUntil > now).sort((a, b) => a.showFrom.localeCompare(b.showFrom))[0];
    return next.headline;
  });
}

/** Removes a group, and returns how many cards it held. */
export function removePhoneCards(group: string): number {
  return db.delete(phoneCards).where(eq(phoneCards.groupKey, group)).run().changes;
}

/** The cards that have not ended yet, including those that show later. */
export function listPhoneCards() {
  return db.select().from(phoneCards)
    .where(gt(phoneCards.showUntil, new Date().toISOString()))
    .orderBy(asc(phoneCards.showFrom))
    .all()
    .map(({ groupKey, ...card }) => ({ ...card, group: groupKey }));
}
