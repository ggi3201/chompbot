import { parseState, trackChomp, type StateStore } from "./alarm.ts";
import { CONCURRENCY, checkPort, checkUrl, mapLimit, type Connect, type Fetch } from "./checks.ts";
import { sendReport } from "./report.ts";
import { planRun, type Plan } from "./schedule.ts";
import { parseTargets } from "./targets.ts";
import { telegramNotifier } from "./telegram.ts";
import type { Env, Report } from "./types.ts";

export const TARGETS_KEY = "targets";
export const STATE_KEY = "state";

export interface Deps {
  kv: Pick<KVNamespace, "get" | "put">;
  fetch: Fetch;
  connect: Connect;
  now: () => number;
}

const NOTHING_TO_CHECK: Plan = { urls: [], ports: [], homeHost: "" };

export async function runProbe(env: Env, deps: Deps, scheduledTime: number): Promise<void> {
  const targets = parseTargets(await deps.kv.get(TARGETS_KEY));
  const plan = targets ? planRun(targets, Math.floor(scheduledTime / 60_000)) : NOTHING_TO_CHECK;

  const ts = deps.now();
  const ports = await mapLimit(plan.ports, CONCURRENCY, (port) => checkPort(plan.homeHost, port, deps.connect));
  const results = await mapLimit(plan.urls, CONCURRENCY, (target) => checkUrl(target, deps.fetch, deps.now));
  const report: Report = { ts, colo: null, vantage: "outside", results, ...(ports.length > 0 && { ports }) };

  const outcome = await sendReport(deps.fetch, env.CHOMP_RESULTS_URL, env.MONITOR_OUTSIDE_SECRET, report, deps.now());
  const store: StateStore = {
    load: async () => parseState(await deps.kv.get(STATE_KEY)),
    save: (state) => deps.kv.put(STATE_KEY, JSON.stringify(state)),
  };
  const notify = telegramNotifier(deps.fetch, env.TELEGRAM_ALERTS_BOT_TOKEN, env.TELEGRAM_ALERTS_CHAT_ID);
  await trackChomp(store, outcome, deps.now(), notify);
}
