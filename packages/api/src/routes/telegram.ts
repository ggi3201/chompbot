import { Router } from "express";
import { sendTelegramMessage, getLinkedChatId, restartBot, telegramTokenSource } from "../telegram/bot.js";

const router: ReturnType<typeof Router> = Router();

/** POST /api/telegram/test — send a test message to the linked Telegram chat */
router.post("/test", async (_req, res) => {
  const chatId = getLinkedChatId();
  if (!chatId) {
    res.status(400).json({ error: "No Telegram chat linked. Send /start to the bot first." });
    return;
  }

  const sent = await sendTelegramMessage("Test message from Chomp! Your Telegram integration is working.");
  if (sent) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: "Failed to send test message. Check bot token and chat link." });
  }
});

/** POST /api/telegram/restart — restart the bot (picks up new token) */
router.post("/restart", async (_req, res) => {
  try {
    const success = await restartBot();
    if (success) {
      res.json({ success: true, message: "Telegram bot restarted" });
    } else {
      res.json({ success: false, message: "No bot token configured" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

/** GET /api/telegram/status — check bot and chat link status */
router.get("/status", (_req, res) => {
  res.json({ tokenSource: telegramTokenSource(), linkedChatId: getLinkedChatId() });
});

export default router;
