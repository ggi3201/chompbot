import { and, isNotNull, like, lt, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentSessions, proactiveRuleRuns } from "../db/schema.js";
import { rollupAndPrune } from "../monitoring/store.js";

// Rules check every minute or so and log every "not now", ~4,000 rows a day that nobody reads.
// Kept 30 days, the window of the dashboard's rule-outcome chart; fired and error runs are kept forever.
const SKIPPED_RUN_DAYS = 30;
// The full prompt is copied into every session row; the row itself stays for stats and model restore.
const SESSION_PROMPT_DAYS = 30;
// SQLite keeps deleted pages in the file; compact once they add up (the first prune freed ~150 MB, VACUUM took 0.4 s).
const VACUUM_FREE_BYTES = 50_000_000;

export function pruneHistory(now = Date.now()): { skippedRuns: number; sessionPrompts: number } {
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const skippedRuns = db.delete(proactiveRuleRuns)
    .where(and(like(proactiveRuleRuns.outcome, "skipped%"), lt(proactiveRuleRuns.triggeredAt, ago(SKIPPED_RUN_DAYS))))
    .run().changes;
  const sessionPrompts = db.update(agentSessions)
    .set({ prompt: null, userPrompt: null })
    .where(and(
      lt(agentSessions.startedAt, ago(SESSION_PROMPT_DAYS)),
      ne(agentSessions.status, "running"),
      or(isNotNull(agentSessions.prompt), isNotNull(agentSessions.userPrompt)),
    ))
    .run().changes;
  return { skippedRuns, sessionPrompts };
}

/** VACUUM when enough free pages piled up. Returns whether it ran. */
export function compactIfBloated(minFreeBytes = VACUUM_FREE_BYTES): boolean {
  const sqlite = db.$client;
  const free = (sqlite.pragma("freelist_count", { simple: true }) as number) * (sqlite.pragma("page_size", { simple: true }) as number);
  if (free < minFreeBytes) return false;
  sqlite.exec("VACUUM");
  return true;
}

export function startDailyRetention(): void {
  const tick = () => {
    try {
      const r = pruneHistory();
      console.log(`[retention] deleted ${r.skippedRuns} skipped rule runs, blanked ${r.sessionPrompts} session prompts`);
      const m = rollupAndPrune();
      console.log(`[retention] monitoring: pruned ${m.checks} checks and ${m.rollups} rollups`);
      if (compactIfBloated()) console.log("[retention] compacted the database");
    } catch (err) {
      console.error("[retention] failed:", err instanceof Error ? err.message : err);
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 86_400_000).unref();
}
