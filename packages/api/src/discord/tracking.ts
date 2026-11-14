// Discord message-to-conversation tracking.
// Maps sent Discord message IDs to Chomp conversation IDs so that
// replies in Discord can be routed to the originating conversation.

const MAX_TRACKED_MESSAGES = 500;

/** Discord message ID → conversationId (for routing replies) */
const discordMsgToConv = new Map<string, string>();

/** conversationId → last Discord message ID (for reply threading) */
const convToLastDiscordMsg = new Map<string, string>();

/** Track a sent Discord message for conversation threading */
export function trackSentMessage(discordMsgId: string, conversationId: string): void {
  // FIFO eviction: delete oldest entry if over limit
  if (discordMsgToConv.size >= MAX_TRACKED_MESSAGES) {
    const firstKey = discordMsgToConv.keys().next().value;
    if (firstKey !== undefined) discordMsgToConv.delete(firstKey);
  }
  discordMsgToConv.set(discordMsgId, conversationId);
  convToLastDiscordMsg.set(conversationId, discordMsgId);
}

/** Look up which conversation a Discord message belongs to */
export function getConversationForDiscordMsg(discordMsgId: string): string | undefined {
  return discordMsgToConv.get(discordMsgId);
}

/** Get the last Discord message ID sent for a conversation (for reply threading) */
export function getLastDiscordMsgForConv(conversationId: string): string | undefined {
  return convToLastDiscordMsg.get(conversationId);
}
