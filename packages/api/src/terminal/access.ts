import type { IncomingMessage } from "node:http";
import { isIPv4 } from "node:net";

// Loopback (tailscale serve and the Vite proxy arrive here), private LANs, the tailnet's CGNAT range and IPv6 ULA (tailnet included).
const LOCAL_V4: [number, number][] = [
  [0x7f000000, 8],
  [0x0a000000, 8],
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0x64400000, 10],
];

function v4InRange(address: string, [base, bits]: [number, number]): boolean {
  const value = address.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isLocalAddress(raw: string): boolean {
  const address = raw.replace(/^::ffff:/i, "");
  if (isIPv4(address)) return LOCAL_V4.some((range) => v4InRange(address, range));
  const lower = address.toLowerCase();
  return lower === "::1" || /^f[cd][0-9a-f]{2}:/.test(lower);
}

/**
 * Whether this request may reach a shell on the host: from a page Chomp served, over the tailnet or the LAN,
 * and never through a public tunnel. A Cloudflare tunnel connects from loopback too, so its headers give it away.
 */
export function terminalAllowed(req: IncomingMessage): boolean {
  if (req.headers["cf-connecting-ip"] || req.headers["cf-ray"]) return false;
  const origin = req.headers.origin;
  if (origin && !ownHosts(req).includes(hostOf(origin) ?? "")) return false;
  return isLocalAddress(req.socket.remoteAddress ?? "");
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * The hosts Chomp's own pages come from: this request's, the one a proxy such as tailscale serve forwarded,
 * and CHOMP_DOMAIN. A page on another site cannot set X-Forwarded-Host on a WebSocket, so trusting it is safe.
 */
function ownHosts(req: IncomingMessage): string[] {
  const forwarded = req.headers["x-forwarded-host"];
  return [req.headers.host, ...(Array.isArray(forwarded) ? forwarded : [forwarded]), process.env.CHOMP_DOMAIN && hostOf(process.env.CHOMP_DOMAIN)].filter((h): h is string => !!h);
}
