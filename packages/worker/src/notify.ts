/**
 * Lightweight notification from the worker process.
 * Calls the API's notification endpoint via HTTP since the worker
 * is a separate process and can't import API modules directly.
 */
const API_URL = process.env.API_URL ?? "http://localhost:3001";

export async function notifyScheduleResult(title: string, body: string): Promise<void> {
  try {
    // Use the API's internal health endpoint to check if it's up,
    // then call Telegram directly since we have DB access
    const { db } = await import("./db.js");
    const { settings } = await import("./schema.js");
    const { eq } = await import("drizzle-orm");

    const tokenRow = db.select().from(settings).where(eq(settings.key, "telegram_bot_token")).get();
    const chatIdRow = db.select().from(settings).where(eq(settings.key, "telegram_chat_id")).get();

    // Bot token can come from DB settings OR from env var (TELEGRAM_API_KEY)
    const token = tokenRow?.value || process.env.TELEGRAM_API_KEY;
    if (!token || !chatIdRow?.value) return;

    const chatId = chatIdRow.value;
    const text = `*${title}*\n${body}`;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.warn("[worker-notify] Failed to send notification:", err instanceof Error ? err.message : err);
  }
}
