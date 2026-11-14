import { vi, type Mock } from "vitest";
import { fixture, json } from "./fixtures.js";

type Reply = string | Error;
const ACCOUNT = "0000000000000000000000000000abcdef";
export const TUNNEL = "00000000-0000-4000-8000-000000000010";

export const enoent = (command: string) => Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
export const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

/** Replies for the mini's commands and URLs, from sanitized fixtures. A test replaces one reply to make a source fail. */
export function givenMini(execFile: Mock) {
  const realFetch = globalThis.fetch;
  const inspect = json("docker-inspect.json") as { Name: string; RestartCount: number }[];
  const commands = new Map<string, Reply>([
    ["docker ps -aq", inspect.map((_, i) => `id${i}`).join("\n")],
    ["docker inspect", JSON.stringify(inspect)],
    ["docker system df", fixture("docker-system-df.txt")],
    ["ss -tlnp", fixture("ss-tlnp.txt")],
    ["tailscale status --json", fixture("tailscale-status.json")],
  ]);
  const urls = new Map<string, Reply | Response>([
    ["http://127.0.0.1:8081/api/http/routers", fixture("traefik-routers.json")],
    ["http://127.0.0.1:8081/api/http/services", fixture("traefik-services.json")],
    ["http://127.0.0.1:8081/api/http/middlewares", fixture("traefik-middlewares.json")],
    ["https://cloudflare.com/cdn-cgi/trace", fixture("cdn-cgi-trace.txt")],
    [`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/cfd_tunnel?is_deleted=false`, fixture("cloudflare-tunnels.json")],
    [`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`, fixture("cloudflare-tunnel.json")],
    [`https://api.cloudflare.com/client/v4/zones?account.id=${ACCOUNT}&per_page=50`, fixture("cloudflare-zones.json")],
    ["https://api.cloudflare.com/client/v4/zones/zone-home/dns_records?per_page=1000", fixture("cloudflare-dns-home.json")],
    ["https://api.cloudflare.com/client/v4/zones/zone-apps/dns_records?per_page=1000", fixture("cloudflare-dns-apps.json")],
  ]);

  execFile.mockImplementation((command: string, args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
    const line = [command, ...args].join(" ");
    const key = [...commands.keys()].find((k) => line.startsWith(k));
    const reply = key === undefined ? new Error(`unexpected command: ${line}`) : commands.get(key)!;
    if (reply instanceof Error) callback(reply, "", reply.message);
    else callback(null, reply, "");
  });

  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const reply = urls.get(url);
    // Anything not listed is a request to the test's own local servers.
    if (reply === undefined) return realFetch(input, init);
    if (reply instanceof Error) throw reply;
    return reply instanceof Response ? reply : new Response(reply, { status: 200 });
  }));

  return { commands, urls };
}
