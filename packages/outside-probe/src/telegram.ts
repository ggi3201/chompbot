import type { Fetch } from "./checks.ts";
import type { Notify } from "./alarm.ts";

export function telegramNotifier(doFetch: Fetch, botToken: string, chatId: string): Notify {
  return async (text) => {
    try {
      const response = await doFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    }
  };
}
