import { Bot, type Context } from "grammy";
import { redactTokenFromErrors } from "../telegram/redact-token.js";
import { alertsConfig } from "./alerts-client.js";
import { startDiagnosis } from "./diagnose.js";

const DIAGNOSE_BUTTON = /^diag:(.+)$/;

/**
 * A tap on an alert's Diagnose button. Only the owner is answered: anyone else who finds the bot gets nothing,
 * not even a refusal.
 */
export async function handleDiagnoseButton(ctx: Context): Promise<void> {
  const ownerId = alertsConfig()?.ownerId;
  if (!ownerId || ctx.from?.id !== ownerId) return;
  const incidentId = DIAGNOSE_BUTTON.exec(ctx.callbackQuery?.data ?? "")?.[1];
  const start = incidentId ? startDiagnosis(incidentId) : null;
  const text = start?.started
    ? "Diagnosing. The answer comes as a reply."
    : start?.reason === "running" ? "A diagnosis is already running." : "That incident is gone.";
  await ctx.answerCallbackQuery({ text });
}

let polling: { token: string; bot: Bot } | null = null;

/**
 * Keeps one long-polling bot on the alerts token that handles the Diagnose button and nothing else.
 * Called every tick: it starts the bot once the token and the owner are set, and restarts it when the token changes.
 * Nothing else polls this bot, so there is no update conflict.
 */
export function syncAlertsBot(): void {
  const config = alertsConfig();
  const token = config?.ownerId ? config.token : null;
  if (polling?.token === token) return;
  if (polling) void polling.bot.stop().catch(() => undefined);
  polling = null;
  if (!token) return;

  // Its own Bot: this one polls and is thrown away on a new token, while sending uses the instance in alerts-client.
  const bot = new Bot(token);
  redactTokenFromErrors(bot);
  bot.callbackQuery(DIAGNOSE_BUTTON, handleDiagnoseButton);
  bot.catch((err) => console.error("[monitoring] Alerts bot error:", err.message));
  polling = { token, bot };
  // A failed start (a wrong token, a second poller) is logged once. It is tried again when the token changes.
  bot.start({ allowed_updates: ["callback_query"], onStart: () => console.log("[monitoring] Alerts bot is listening for Diagnose taps") })
    .catch((err) => console.error("[monitoring] Alerts bot stopped:", err instanceof Error ? err.message : err));
}
