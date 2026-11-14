import { USER_AGENT, describeError, type Fetch } from "./checks.ts";
import type { Outcome, Report } from "./types.ts";

export const REPORT_TIMEOUT_MS = 10_000;

const encoder = new TextEncoder();

/** Hex HMAC-SHA256 of `<timestamp>.<body>`. */
export async function sign(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sendReport(
  doFetch: Fetch,
  url: string,
  secret: string,
  report: Report,
  nowMs: number,
): Promise<Outcome> {
  const body = JSON.stringify(report);
  const timestamp = Math.floor(nowMs / 1000);
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Chomp-Timestamp": String(timestamp),
        "X-Chomp-Signature": `sha256=${await sign(secret, timestamp, body)}`,
      },
      body,
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
