/** Who can reach a service, widest first. Public direct comes before the tunnel: it shows the home IP. */
export const EXPOSURE_LEVELS = ["public-direct", "public-tunnel", "lan", "tailnet", "local"] as const;
export type Exposure = (typeof EXPOSURE_LEVELS)[number];

export const EXPOSURE_LABELS: Record<Exposure, string> = {
  "public-direct": "Public, direct",
  "public-tunnel": "Public, tunnel",
  lan: "LAN",
  tailnet: "Tailnet",
  local: "Local",
};

export const widest = (levels: readonly Exposure[]): Exposure =>
  EXPOSURE_LEVELS.find((level) => levels.includes(level)) ?? "local";

const WILDCARDS = new Set(["0.0.0.0", "::", "*"]);
const LOOPBACK = /^(127\.|::1$|localhost$)/;
/** Tailscale's CGNAT range 100.64.0.0/10, and its IPv6 range. */
const TAILNET = /^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|fd7a:115c:a1e0:)/;
/** What a Traefik allow-list may name and still keep a hostname inside the tailnet: tailnet, loopback and Docker's own networks. */
const TAILNET_RANGE = /^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/;

export const isWildcard = (bind: string | null) => bind !== null && WILDCARDS.has(bind);
export const isLoopback = (bind: string | null) => bind !== null && LOOPBACK.test(bind);

/** The level a listener's bind address gives. No bind means no published port: reachable on Docker's networks only. */
export function bindExposure(bind: string | null, tailnetIps: readonly string[] = []): Exposure {
  if (bind === null || isLoopback(bind)) return "local";
  if (tailnetIps.includes(bind) || TAILNET.test(bind)) return "tailnet";
  return "lan";
}

/** A router whose allow-list names only tailnet ranges cannot be reached from the LAN, even though Traefik listens on every address. */
export const isTailnetOnly = (allowedRanges: readonly string[] | null) =>
  allowedRanges !== null && allowedRanges.length > 0 && allowedRanges.every((range) => TAILNET_RANGE.test(range));

export interface Reach {
  /** In the Cloudflare tunnel's ingress. */
  tunnel: boolean;
  /** A DNS A or AAAA record points at the home IP. */
  direct: boolean;
  /** Behind a Traefik router, with the ranges its allow-list admits (null: no allow-list). */
  route: { allowedRanges: readonly string[] | null } | null;
  /** Bind addresses of the ports the service listens on. */
  binds: readonly (string | null)[];
}

export function classify(reach: Reach, tailnetIps: readonly string[] = []): Exposure {
  const levels: Exposure[] = reach.binds.map((bind) => bindExposure(bind, tailnetIps));
  if (reach.tunnel) levels.push("public-tunnel");
  if (reach.direct) levels.push("public-direct");
  if (reach.route) levels.push(isTailnetOnly(reach.route.allowedRanges) ? "tailnet" : "lan");
  return widest(levels);
}
