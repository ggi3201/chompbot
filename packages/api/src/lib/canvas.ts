/**
 * Canvas UI blocks are fenced markdown the web chat renders as rich components
 * (see the chomp-agent skill). They only make sense in the web chat — on
 * Telegram/Discord/email/push they surface as unreadable JSON.
 *
 * This strips any `:::canvas ... :::` fence from outbound text as a safety net,
 * independent of whether the agent was told not to emit them.
 */

const CANVAS_BLOCK_RE = /:::canvas[^\n]*\n[\s\S]*?\n:::[ \t]*/g;

export function stripCanvasBlocks(text: string): string {
  if (!text.includes(":::canvas")) return text;
  return text.replace(CANVAS_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}
