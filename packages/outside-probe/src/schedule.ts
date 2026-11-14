import type { Targets, UrlTarget } from "./types.ts";

// Workers free plan: 50 subrequests per invocation. Keep two spare.
export const SUBREQUEST_BUDGET = 48;

// Fixed cost of a run: read targets, read state, post the report, send one Telegram
// message, write state.
const RESERVED_SUBREQUESTS = 5;

/** Fetches and connects one run may start. */
export const CHECK_SLOTS = SUBREQUEST_BUDGET - RESERVED_SUBREQUESTS;

export const PORT_CHECK_EVERY_MINUTES = 15;

export interface Plan {
  urls: UrlTarget[];
  ports: number[];
  homeHost: string;
}

/**
 * Decides what one run checks. `epochMinute` is minutes since the Unix epoch.
 *
 * Port checks come first. URLs take the remaining slots. When they do not fit, they are
 * split into shards and each minute checks one shard. With 33 URLs and 12 ports that
 * means two shards on a port minute and everything on every other minute, so no URL
 * waits more than 2 minutes. A list so large that it needs N shards on every minute
 * stretches the interval to N minutes.
 */
export function planRun(targets: Targets, epochMinute: number): Plan {
  const portsDue = epochMinute % PORT_CHECK_EVERY_MINUTES === 0;
  const ports = portsDue ? targets.ports : [];
  const shards = Math.ceil(targets.urls.length / (CHECK_SLOTS - ports.length));
  const urls =
    shards <= 1 ? targets.urls : targets.urls.filter((_, index) => index % shards === epochMinute % shards);
  return { urls, ports, homeHost: targets.homeHost };
}
