/**
 * Device push-token registration. The iOS ChompCompanion app POSTs its APNs
 * token here after registering for remote notifications, and the server
 * uses that token to wake the device with a silent push when the bridge's
 * WebSocket has been suspended by iOS.
 */
import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { devicePushTokens } from "../db/schema.js";
import { sendSilentPush, isApnsConfigured } from "../lib/apns.js";

const router: ReturnType<typeof Router> = Router();

/**
 * POST /device-tokens
 * Body: { deviceId, apnsToken, platform?, environment? }
 *
 * Upserts the device's current APNs token. Called by the iOS app on every
 * launch (tokens are stable but can rotate after restore / reinstall).
 */
router.post("/", (req: Request, res: Response) => {
  const { deviceId, apnsToken, platform = "ios", environment = "production" } = req.body ?? {};
  if (typeof deviceId !== "string" || !deviceId) {
    res.status(400).json({ error: "deviceId required" });
    return;
  }
  if (typeof apnsToken !== "string" || !apnsToken) {
    res.status(400).json({ error: "apnsToken required" });
    return;
  }
  if (environment !== "production" && environment !== "development") {
    res.status(400).json({ error: "environment must be 'production' or 'development'" });
    return;
  }
  const now = new Date().toISOString();
  db.insert(devicePushTokens)
    .values({ deviceId, apnsToken, platform, environment, updatedAt: now })
    .onConflictDoUpdate({
      target: devicePushTokens.deviceId,
      set: { apnsToken, platform, environment, updatedAt: now },
    })
    .run();
  res.json({ ok: true, configured: isApnsConfigured() });
});

/**
 * DELETE /device-tokens/:deviceId
 * Forget a device. Called by the iOS app on sign-out, or by the server when
 * APNs returns BadDeviceToken (status 410).
 */
router.delete("/:deviceId", (req: Request, res: Response) => {
  db.delete(devicePushTokens).where(eq(devicePushTokens.deviceId, req.params.deviceId as string)).run();
  res.json({ ok: true });
});

/**
 * POST /device-tokens/:deviceId/wake
 * Manually fire a silent push. Mostly for debugging — the device-bridge
 * dispatcher will normally do this transparently when a tool call targets
 * an offline device.
 */
router.post("/:deviceId/wake", async (req: Request, res: Response) => {
  const deviceId = String(req.params.deviceId);
  const row = db.select().from(devicePushTokens).where(eq(devicePushTokens.deviceId, deviceId)).get();
  if (!row) {
    res.status(404).json({ error: "Device not registered" });
    return;
  }
  const result = await sendSilentPush({
    deviceToken: row.apnsToken,
    environment: row.environment === "development" ? "development" : "production",
    collapseId: "wake",
  });
  res.json(result);
});

export default router;
