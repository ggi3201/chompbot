import { desc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { locationHistory } from "../db/schema.js";
import { emit } from "../events/bus.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const reportSchema = z.object({
  source: z.string().trim().min(1).max(40),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0),
  address: z.string().trim().min(1).max(200).optional(),
  /** The named place the user is in, null for none. A source that does not know places leaves it out. */
  place: z.string().trim().min(1).max(100).nullable().optional(),
  capturedAt: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
});

export type LocationReport = z.infer<typeof reportSchema>;

export function latestLocation() {
  return db.select().from(locationHistory).orderBy(desc(locationHistory.capturedAt), desc(locationHistory.id)).limit(1).get();
}

/** Where Home Assistant last put the user. The phone reports more often but knows no zones. */
export function latestZone() {
  return db.select().from(locationHistory)
    .where(eq(locationHistory.source, "home-assistant"))
    .orderBy(desc(locationHistory.capturedAt), desc(locationHistory.id))
    .limit(1)
    .get();
}

export function locationSince(since: string, limit: number) {
  return db.select().from(locationHistory)
    .where(gte(locationHistory.capturedAt, since))
    .orderBy(desc(locationHistory.capturedAt), desc(locationHistory.id))
    .limit(limit)
    .all();
}

/**
 * Saves a report and announces a change of place. Each source is compared with itself: a phone
 * report just before a Home Assistant one must not make that zone change look late, and a source
 * that does not know places must not move the user out of a zone.
 */
export function ingestLocation(report: LocationReport): void {
  const previous = db.select().from(locationHistory)
    .where(eq(locationHistory.source, report.source))
    .orderBy(desc(locationHistory.capturedAt), desc(locationHistory.id))
    .limit(1)
    .get();
  if (previous && previous.capturedAt >= report.capturedAt) return;

  const place = report.place === undefined ? previous?.place ?? null : report.place;
  db.insert(locationHistory).values({ ...report, place }).run();
  db.delete(locationHistory).where(lt(locationHistory.capturedAt, new Date(Date.now() - RETENTION_MS).toISOString())).run();

  // The first report ever has nothing to compare with, so it is not a move.
  if (!previous || previous.place === place) return;
  const { source, latitude, longitude, capturedAt } = report;
  if (previous.place) emit({ type: "location.changed", transition: "leave", place: previous.place, source, latitude, longitude, capturedAt });
  if (place) emit({ type: "location.changed", transition: "arrive", place, source, latitude, longitude, capturedAt });
}
