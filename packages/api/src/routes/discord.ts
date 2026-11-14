import { Router } from "express";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { sendDiscordMessage, getLinkedChannelId, restartBot } from "../discord/bot.js";
import { getSecret } from "../lib/secrets.js";

const router: ReturnType<typeof Router> = Router();

/** POST /api/discord/test — send a test message to the linked Discord channel */
router.post("/test", async (_req, res) => {
  const channelId = getLinkedChannelId();
  if (!channelId) {
    res.status(400).json({ error: "No Discord channel linked. Send '!chomp link' in a channel first." });
    return;
  }

  const sent = await sendDiscordMessage("Test message from Chomp! Your Discord integration is working.");
  if (sent) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: "Failed to send test message. Check bot token and channel link." });
  }
});

/** POST /api/discord/restart — restart the bot (picks up new token) */
router.post("/restart", async (_req, res) => {
  try {
    const success = await restartBot();
    if (success) {
      res.json({ success: true, message: "Discord bot restarted" });
    } else {
      res.json({ success: false, message: "No bot token configured" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

/** GET /api/discord/status — check bot and channel link status */
router.get("/status", (_req, res) => {
  const token = getSecret("DISCORD_BOT_TOKEN");
  const channelId = getLinkedChannelId();

  res.json({
    hasToken: !!token,
    linkedChannelId: channelId,
  });
});

export default router;
