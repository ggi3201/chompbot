import { reportConversationId, reportSchema, reportUrl, saveReport, speakReport } from "../../goodmorning/report.js";
import { sendTelegramVoice } from "../../telegram/bot.js";

/** Stores the day's report, speaks it, and sends the voice note with a link to the page. */
export async function execPublishMorningReport(args: Record<string, unknown>): Promise<string> {
  const { send_voice: sendVoice = true, ...input } = args;
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) {
    return `ERROR: Invalid report: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
  }

  const report = parsed.data;
  saveReport(report);
  const url = reportUrl(report.date);

  // The page is still worth having when speech fails, so the report stays saved.
  let ogg: string;
  try {
    ogg = await speakReport(report);
  } catch (err) {
    return `ERROR: Report saved at ${url}, but the voice note failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (sendVoice === false) return `Report saved, voice note not sent: ${url}`;
  const sent = await sendTelegramVoice(ogg, url, reportConversationId(report.date));
  return sent ? `Report saved and voice note sent: ${url}` : `ERROR: Report saved at ${url}, but Telegram did not take the voice note.`;
}
