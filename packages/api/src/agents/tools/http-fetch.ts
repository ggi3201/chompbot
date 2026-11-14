/**
 * Generic HTTP-fetch tool for dashboard refreshers.
 *
 * Designed to make widgets config-driven: the recipe (URL, auth, transform)
 * lives in the widget's refresher payload, not in chomp source. New widget
 * = new payload, no PR.
 *
 * Secret syntax: `{{secrets.KEY_NAME}}` in URL/headers/body resolves via
 * getSecret(). Secret values never appear in responses or error messages.
 *
 * SSRF guards: only public https URLs allowed. Localhost, private nets,
 * .local TLDs all rejected before any fetch happens.
 *
 * Output: raw response body as a string. The widget refresher pipeline
 * either parses it directly as canvas blocks (fast path) or passes it
 * through the format-LLM step.
 */

import { getSecret } from "../../lib/secrets.js";
import https from "node:https";

const SECRET_REF_RE = /\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g;

/**
 * Replace {{secrets.X}} occurrences with the resolved secret value.
 * Returns either the substituted string OR an ERROR string if any referenced
 * secret is missing. Caller must check for "ERROR:" prefix.
 *
 * Important: never include the secret name in the success path output, only
 * the substituted value (which is the user's real key, not echoed elsewhere).
 */
function expandSecrets(input: string): string | { error: string } {
  let missing: string | null = null;
  const out = input.replace(SECRET_REF_RE, (_match, key: string) => {
    const value = getSecret(key);
    if (value == null || value === "") {
      missing ??= key;
      return "";
    }
    return value;
  });
  if (missing) return { error: `Secret ${missing} not configured` };
  return out;
}

function expandHeaders(
  headers: Record<string, string>,
): Record<string, string> | { error: string } {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") continue;
    const expanded = expandSecrets(v);
    if (typeof expanded === "object") return expanded;
    out[k] = expanded;
  }
  return out;
}

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "::",
]);

function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (PRIVATE_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".local")) return true;

  // IPv4 private ranges (best-effort string match — not parsing CIDR)
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(h)) return true;
  // 172.16.0.0 - 172.31.255.255
  const m172 = h.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;

  // IPv6 private (rough): fe80::, fc00::, fd00::
  if (h.startsWith("fe80:") || h.startsWith("fc00:") || h.startsWith("fd00:")) return true;

  return false;
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT"]);
const TIMEOUT_MS = 8000;
const IPV4_HEDGE_DELAY_MS = 750;
const MAX_RESPONSE_BYTES = 256 * 1024; // 256 KB cap

export interface HttpFetchArgs {
  url?: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
}

export async function execHttpFetchUrl(args: HttpFetchArgs): Promise<string> {
  if (!args.url || typeof args.url !== "string") return "ERROR: url is required";

  const method = (args.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return `ERROR: method must be one of ${[...ALLOWED_METHODS].join(", ")}`;
  }

  // Expand secrets in URL.
  const urlExpanded = expandSecrets(args.url);
  if (typeof urlExpanded === "object") return `ERROR: ${urlExpanded.error}`;

  // Parse and gate.
  let parsed: URL;
  try {
    parsed = new URL(urlExpanded);
  } catch {
    return "ERROR: url is not a valid URL";
  }
  if (parsed.protocol !== "https:") {
    return "ERROR: only https:// URLs are allowed";
  }
  if (isPrivateHostname(parsed.hostname)) {
    return `ERROR: hostname ${parsed.hostname} is private/local and not allowed`;
  }

  // Expand headers.
  let headers: Record<string, string> = {};
  if (args.headers && typeof args.headers === "object") {
    const expanded = expandHeaders(args.headers as Record<string, string>);
    if ("error" in expanded) return `ERROR: ${expanded.error}`;
    headers = expanded;
  }

  // Expand body if present (POST/PUT only).
  let body: string | undefined;
  if (typeof args.body === "string" && (method === "POST" || method === "PUT")) {
    const expanded = expandSecrets(args.body);
    if (typeof expanded === "object") return `ERROR: ${expanded.error}`;
    body = expanded;
  }

  try {
    const result = await fetchWithIpv4Hedge(parsed, method, headers, body);
    const truncated = result.text.length > MAX_RESPONSE_BYTES ? result.text.slice(0, MAX_RESPONSE_BYTES) : result.text;
    if (!result.ok) return `ERROR: HTTP ${result.status} — ${truncated.slice(0, 200)}`;
    return truncated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "request failed";
    if (msg === "timeout" || (err instanceof Error && err.name === "AbortError")) {
      return `ERROR: request timed out after ${TIMEOUT_MS / 1000}s`;
    }
    return `ERROR: ${msg}`;
  }
}

async function fetchWithIpv4Hedge(
  parsed: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  let fallback: Promise<FetchResult> | undefined;
  const startFallback = () => {
    fallback ??= requestHttpsIpv4(parsed, method, headers, body, 3);
    return fallback;
  };

  const primary = fetch(parsed.toString(), {
    method,
    headers,
    body,
    signal: controller.signal,
  })
    .then(async (resp): Promise<FetchResult> => ({
      ok: resp.ok,
      status: resp.status,
      text: await resp.text(),
    }))
    .catch(() => startFallback());

  const hedged = new Promise<FetchResult>((resolve, reject) => {
    hedgeTimer = setTimeout(() => {
      startFallback().then(resolve, reject);
    }, IPV4_HEDGE_DELAY_MS);
  });

  try {
    return await Promise.race([primary, hedged]);
  } finally {
    controller.abort();
    clearTimeout(timeout);
    if (hedgeTimer) clearTimeout(hedgeTimer);
  }
}

function requestHttpsIpv4(
  parsed: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  redirectsLeft: number,
): Promise<FetchResult> {
  return retryHttpsIpv4(parsed, method, headers, body, redirectsLeft, 3);
}

async function retryHttpsIpv4(
  parsed: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  redirectsLeft: number,
  attempts: number,
): Promise<FetchResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestHttpsIpv4Once(parsed, method, headers, body, redirectsLeft);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("request failed");
}

function requestHttpsIpv4Once(
  parsed: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  redirectsLeft: number,
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      parsed,
      {
        method,
        headers,
        family: 4,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
          res.resume();
          let next: URL;
          try {
            next = new URL(location, parsed);
          } catch {
            reject(new Error("redirect location is not a valid URL"));
            return;
          }
          if (next.protocol !== "https:") {
            reject(new Error("redirect target must use https://"));
            return;
          }
          if (isPrivateHostname(next.hostname)) {
            reject(new Error(`redirect target hostname ${next.hostname} is private/local and not allowed`));
            return;
          }
          const redirectMethod = status === 303 ? "GET" : method;
          const redirectBody = status === 303 ? undefined : body;
          requestHttpsIpv4(next, redirectMethod, headers, redirectBody, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          if (bytes >= MAX_RESPONSE_BYTES) return;
          const remaining = MAX_RESPONSE_BYTES - bytes;
          const next = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(next);
          bytes += next.length;
        });
        res.on("end", () => {
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
