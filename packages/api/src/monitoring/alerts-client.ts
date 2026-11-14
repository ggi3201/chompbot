import { Bot } from "grammy";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { getSecret } from "../lib/secrets.js";
import { redactTokenFromErrors } from "../telegram/redact-token.js";

/** The alerts bot is not Chomp's chat bot: it has its own token and chat, and only the monitoring files read them. */
export interface AlertsConfig {
  token: string;
  /** Where alerts go. Null until the person sets it. */
  chatId: number | null;
  /** The only Telegram user the Diagnose button answers. Null until set. */
  ownerId: number | null;
}

function numberSetting(key: string): number | null {
  const value = Number(db.select().from(settings).where(eq(settings.key, key)).get()?.value.trim());
  return Number.isSafeInteger(value) && value !== 0 ? value : null;
}

export function alertsConfig(): AlertsConfig | null {
  const token = getSecret("TELEGRAM_ALERTS_BOT_TOKEN");
  if (!token) return null;
  return { token, chatId: numberSetting("telegram_alerts_chat_id"), ownerId: numberSetting("telegram_alerts_owner_id") };
}

let cached: Bot | null = null;

/** One Bot per token. It sends without polling; polling is started separately by alerts-bot.ts. */
export function alertsBot(token: string): Bot {
  if (cached?.token !== token) {
    cached = new Bot(token);
    redactTokenFromErrors(cached);
  }
  return cached;
}

/** The API to send through and the chat to send to. Null when alerts are not configured: callers log and skip. */
export function alertsTarget(): { api: Bot["api"]; chatId: number } | null {
  const config = alertsConfig();
  return config?.chatId ? { api: alertsBot(config.token).api, chatId: config.chatId } : null;
}
