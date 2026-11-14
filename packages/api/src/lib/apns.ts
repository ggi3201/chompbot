/**
 * Apple Push Notification service sender.
 *
 * Used by the device-bridge to wake the ChompCompanion iOS app with a silent
 * push (`{aps: {content-available: 1}}`) when its WebSocket has been
 * suspended by iOS. The phone re-opens the WS within a couple of seconds,
 * and any pending `phone_call_tool` requests get retried.
 *
 * Auth: ES256 JWT signed with an APNs auth key (.p8) from the Apple
 * Developer Portal. The same key works for all environments and all bundles
 * under the same team. The JWT is cached for ~50 minutes (Apple caps tokens
 * at 60 min, refresh on the safe side).
 */
import { readFileSync } from "fs";
import jwt from "jsonwebtoken";
import http2 from "http2";
import { getSecret } from "./secrets.js";

const APNS_HOST_PRODUCTION = "api.push.apple.com";
const APNS_HOST_DEVELOPMENT = "api.sandbox.push.apple.com";
// The iOS app's bundle id; pushes are only delivered to the app it names.
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.example.chomp";

interface ApnsConfig {
  keyId: string;
  teamId: string;
  keyPath: string;
}

function loadConfig(): ApnsConfig | null {
  const keyId = getSecret("APPLE_APNS_KEY_ID") || process.env.APPLE_APNS_KEY_ID;
  const teamId = getSecret("APPLE_TEAM_ID") || process.env.APPLE_TEAM_ID;
  const keyPath = getSecret("APPLE_APNS_KEY_PATH") || process.env.APPLE_APNS_KEY_PATH
    || `${process.env.HOME}/.config/chomp/appstore/APNsAuthKey.p8`;
  if (!keyId || !teamId) return null;
  return { keyId, teamId, keyPath };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function getApnsJwt(cfg: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.token;
  }
  const key = readFileSync(cfg.keyPath);
  const token = jwt.sign(
    { iss: cfg.teamId, iat: now },
    key,
    { algorithm: "ES256", header: { alg: "ES256", kid: cfg.keyId, typ: "JWT" } },
  );
  // Apple caps tokens at 60 minutes — refresh at 50 min to stay safely under.
  cachedToken = { token, expiresAt: now + 50 * 60 };
  return token;
}

export interface SilentPushResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Send a silent push to wake the iOS app. Apple aggressively throttles
 * silent pushes — typical budget is a few per hour per device, so callers
 * should debounce / coalesce.
 *
 * If the .p8 / config is missing this is a no-op that returns `{ok: false}`,
 * not an exception — the caller falls back to "phone offline" semantics.
 */
export async function sendSilentPush(opts: PushTarget): Promise<SilentPushResult> {
  // Background pushes MUST use priority 5 (Apple rejects 10 for content-available).
  return sendPush(opts, "background", "5", { "content-available": 1 });
}

/**
 * Send a visible notification. It also carries content-available, so the app
 * can fetch fresh data when iOS wakes it for this push.
 */
export async function sendAlertPush(opts: PushTarget & { title: string; body: string; category?: string }): Promise<SilentPushResult> {
  const { title, body, category, ...target } = opts;
  return sendPush(target, "alert", "10", { alert: { title, body }, sound: "default", "content-available": 1, ...(category ? { category } : {}) });
}

export interface PushTarget {
  deviceToken: string;
  environment?: "production" | "development";
  collapseId?: string;
  /** Epoch seconds after which APNs drops the push instead of delivering it late. */
  expiresAt?: number;
  /** Custom keys next to `aps`, for the app to read. */
  data?: Record<string, unknown>;
}

async function sendPush(
  opts: PushTarget,
  pushType: "background" | "alert",
  priority: "5" | "10",
  aps: Record<string, unknown>,
): Promise<SilentPushResult> {
  const cfg = loadConfig();
  if (!cfg) {
    return { ok: false, error: "APNs not configured (missing APPLE_APNS_KEY_ID / APPLE_TEAM_ID / key file)" };
  }

  let bearer: string;
  try {
    bearer = getApnsJwt(cfg);
  } catch (err) {
    return { ok: false, error: `APNs JWT sign failed: ${(err as Error).message}` };
  }

  const host = opts.environment === "development" ? APNS_HOST_DEVELOPMENT : APNS_HOST_PRODUCTION;
  const body = JSON.stringify({ ...opts.data, aps });

  // APNs ONLY speaks HTTP/2 — the https (HTTP/1.1) module fails with
  // "Expected HTTP/, RTSP/ or ICE/" against api.push.apple.com. Use a
  // short-lived http2 session per push (fine for our low volume).
  return new Promise<SilentPushResult>((resolve) => {
    let settled = false;
    const done = (r: SilentPushResult) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch { /* already closing */ }
      resolve(r);
    };

    const client = http2.connect(`https://${host}`);
    client.on("error", (err) => done({ ok: false, error: `APNs connect: ${err.message}` }));

    // Overall safety timeout so a stalled connection can't hang the caller.
    const guard = setTimeout(() => done({ ok: false, error: "APNs request timed out" }), 10_000);
    if (typeof guard.unref === "function") guard.unref();

    const headers: Record<string, string> = {
      ":method": "POST",
      ":path": `/3/device/${opts.deviceToken}`,
      "authorization": `bearer ${bearer}`,
      "apns-topic": BUNDLE_ID,
      "apns-push-type": pushType,
      "apns-priority": priority,
    };
    if (opts.collapseId) headers["apns-collapse-id"] = opts.collapseId;
    if (opts.expiresAt) headers["apns-expiration"] = String(opts.expiresAt);

    const req = client.request(headers);
    let status = 0;
    let data = "";
    req.on("response", (resHeaders) => {
      status = Number(resHeaders[":status"]) || 0;
    });
    req.setEncoding("utf8");
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      clearTimeout(guard);
      if (status >= 200 && status < 300) {
        done({ ok: true, status });
      } else {
        done({ ok: false, status, error: data || `HTTP ${status}` });
      }
    });
    req.on("error", (err) => {
      clearTimeout(guard);
      done({ ok: false, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

/** Cheap "is APNs even configured" probe for status endpoints / health checks. */
export function isApnsConfigured(): boolean {
  return loadConfig() !== null;
}
