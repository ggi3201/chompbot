import type { Outcome } from "./types.ts";

export const ALARM_AFTER_FAILURES = 3;

export interface AlarmState {
  failures: number;
  /** Epoch ms of the first failed report in the current outage. */
  since: number | null;
  alarmed: boolean;
}

export const HEALTHY: AlarmState = { failures: 0, since: null, alarmed: false };

/** Sends a message. Returns false when it was not delivered. */
export type Notify = (text: string) => Promise<boolean>;

export interface StateStore {
  load(): Promise<AlarmState>;
  save(state: AlarmState): Promise<void>;
}

export function parseState(raw: string | null): AlarmState {
  if (raw === null) return HEALTHY;
  try {
    const { failures, since, alarmed } = JSON.parse(raw);
    const valid =
      Number.isInteger(failures) && (since === null || Number.isFinite(since)) && typeof alarmed === "boolean";
    return valid ? { failures, since, alarmed } : HEALTHY;
  } catch {
    return HEALTHY;
  }
}

const sameState = (a: AlarmState, b: AlarmState) =>
  a.failures === b.failures && a.since === b.since && a.alarmed === b.alarmed;

const minutesSince = (since: number | null, now: number) => Math.max(1, Math.round((now - (since ?? now)) / 60_000));

async function advance(state: AlarmState, outcome: Outcome, now: number, notify: Notify): Promise<AlarmState> {
  if (outcome.ok) {
    if (!state.alarmed) return HEALTHY;
    // If the message is lost, stay alarmed and say it again on the next run.
    const sent = await notify(`Chomp is back after ${minutesSince(state.since, now)} min.`);
    return sent ? HEALTHY : state;
  }
  if (state.alarmed) return state;
  // The count stops at the threshold, so a failing Telegram retries without writing state.
  const failures = Math.min(state.failures + 1, ALARM_AFTER_FAILURES);
  const next = { failures, since: state.since ?? now, alarmed: false };
  if (failures < ALARM_AFTER_FAILURES) return next;
  const alarmed = await notify(
    `Chomp has not answered for ${ALARM_AFTER_FAILURES} minutes. Monitoring is blind until it is back.\nLast error: ${outcome.error}`,
  );
  return { ...next, alarmed };
}

/** Applies one report outcome. Writes state only when it changes, to stay inside the KV write limit. */
export async function trackChomp(store: StateStore, outcome: Outcome, now: number, notify: Notify): Promise<void> {
  const before = await store.load();
  const after = await advance(before, outcome, now, notify);
  if (!sameState(before, after)) await store.save(after);
}
