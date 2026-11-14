import type { PortResult, UrlResult, UrlTarget } from "./types.ts";

export const URL_TIMEOUT_MS = 8_000;
export const PORT_TIMEOUT_MS = 3_000;
export const USER_AGENT = "chomp-outside-probe";

// Workers keep at most 6 connections open at once and queue the rest. Staying at the
// limit ourselves keeps queue time out of the latency and out of the timeouts.
export const CONCURRENCY = 6;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SocketLike {
  readonly opened: Promise<unknown>;
  close(): Promise<void>;
}
export type Connect = (address: { hostname: string; port: number }) => SocketLike;

export function describeError(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  return error instanceof Error ? error.message : String(error);
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function checkUrl(target: UrlTarget, doFetch: Fetch, now: () => number): Promise<UrlResult> {
  const started = now();
  try {
    const response = await doFetch(target.url, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(URL_TIMEOUT_MS),
    });
    const latencyMs = now() - started;
    // Only the status matters. Dropping the body frees the connection slot.
    await response.body?.cancel().catch(() => undefined);
    const ok = response.status < 500 || response.status === target.expectedStatus;
    return { key: target.key, ok, statusCode: response.status, latencyMs, error: ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { key: target.key, ok: false, statusCode: null, latencyMs: now() - started, error: describeError(error) };
  }
}

export async function checkPort(
  hostname: string,
  port: number,
  connect: Connect,
  timeoutMs = PORT_TIMEOUT_MS,
): Promise<PortResult> {
  let socket: SocketLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    socket = connect({ hostname, port });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    await Promise.race([socket.opened, timeout]);
    return { port, open: true };
  } catch {
    // Refused, unreachable and timed out all mean the port is closed to us.
    return { port, open: false };
  } finally {
    clearTimeout(timer);
    await socket?.close().catch(() => undefined);
  }
}
