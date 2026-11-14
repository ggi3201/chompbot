import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

// The tailnet port is derived from the local one, so the same dev server keeps its URL and nothing needs storing.
const TAILNET_PORT_OFFSET = 40_000;
const MIN_PORT = 1024;
const MAX_PORT = 65_535 - TAILNET_PORT_OFFSET;
// Chrome's debug port and noVNC drive the login booth's logged-in browser, and the API holds Chomp's own data.
const BLOCKED_PORTS = new Set([9222, 6080, 3001, 3002]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Exposes the dev server behind a localhost page on the tailnet over HTTPS, so the user can open it on their own device.
 * shortcut: entries stay in `tailscale serve` until removed by hand, add a sweep if they pile up.
 */
export async function exposeOnTailnet(pageUrl: string): Promise<string> {
  const page = new URL(pageUrl);
  if (!LOCAL_HOSTS.has(page.hostname)) return page.href;
  const port = Number(page.port || 80);
  if (port < MIN_PORT || port > MAX_PORT) throw new Error(`Port ${port} cannot be mapped onto the tailnet; it must be from ${MIN_PORT} to ${MAX_PORT}.`);
  if (BLOCKED_PORTS.has(port)) throw new Error(`Port ${port} is not a dev server and must not be exposed.`);

  const tailnetPort = port + TAILNET_PORT_OFFSET;
  // Fixed arguments and a validated port. Works as is when the service user is Tailscale's operator
  // (`tailscale set --operator=$USER`), otherwise needs passwordless sudo.
  const serve = ["serve", "--bg", `--https=${tailnetPort}`, `http://localhost:${port}`];
  await run("tailscale", serve, { timeout: 15_000 }).catch(() => run("sudo", ["-n", "tailscale", ...serve], { timeout: 15_000 }));
  const { stdout } = await run("tailscale", ["status", "--json"], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  const host = (JSON.parse(stdout) as { Self: { DNSName: string } }).Self.DNSName.replace(/\.$/, "");
  return `https://${host}:${tailnetPort}${page.pathname}${page.search}${page.hash}`;
}
