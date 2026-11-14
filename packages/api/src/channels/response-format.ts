export type DeliveryChannel = "web-chat" | "telegram" | "discord" | "proactive";

const RESPONSE_FORMAT_INSTRUCTIONS: Record<DeliveryChannel, string> = {
  "web-chat": [
    "Response formatting target: Chomp web chat.",
    "Use clean GitHub-flavored Markdown for a rich browser UI: headings, lists, tables, fenced code blocks, links, and Canvas blocks when useful.",
    "Do not optimize the prose for Telegram or Discord. Do not use Telegram HTML, emoji-heavy pseudo-bullets, or forced short chat-message line breaks.",
  ].join("\n"),
  telegram: [
    "Response formatting target: Telegram.",
    "Write simple Markdown that can be converted to Telegram HTML at send time: short paragraphs, bullets, bold, inline code, fenced code, and links.",
    "Avoid Canvas blocks, raw HTML, Markdown tables, deeply nested lists, and browser-only layout tricks.",
  ].join("\n"),
  discord: [
    "Response formatting target: Discord.",
    "Use Discord-compatible Markdown: short paragraphs, bullets, bold, inline code, fenced code, links, and compact tables only when they stay readable.",
    "Avoid Canvas blocks, Telegram HTML, and formatting that depends on the web UI renderer.",
  ].join("\n"),
  proactive: [
    "Response formatting target: proactive notification delivered through Telegram/Discord/notifications.",
    "Canvas is disabled. Do not emit `:::canvas` fenced blocks.",
    "Use concise, simple Markdown that survives Telegram and Discord: short paragraphs, bullets, bold, inline code, fenced code, and links.",
    "Avoid raw HTML, Markdown tables, deeply nested lists, and browser-only layout tricks.",
    "If this run has nothing worth telling the user, make your final message exactly `[SILENT]`, and nothing is sent.",
  ].join("\n"),
};

export function getResponseFormatInstruction(channel: DeliveryChannel = "web-chat"): string {
  return RESPONSE_FORMAT_INSTRUCTIONS[channel];
}
