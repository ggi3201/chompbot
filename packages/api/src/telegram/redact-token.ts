import type { Bot } from "grammy";

/**
 * A failed API call's error keeps fetch's own error, whose message and stack
 * hold the request URL, and that URL holds the bot token. Logging it would leak
 * the token, so strip it from every error before any caller can see it.
 */
export function redactTokenFromErrors(bot: Bot): void {
  const token = bot.token;
  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      return await prev(method, payload, signal);
    } catch (err) {
      for (let e: unknown = err; e instanceof Error; e = (e as { error?: unknown }).error ?? e.cause) {
        e.message = e.message.replaceAll(token, "<token>");
        e.stack = e.stack?.replaceAll(token, "<token>");
      }
      throw err;
    }
  });
}
