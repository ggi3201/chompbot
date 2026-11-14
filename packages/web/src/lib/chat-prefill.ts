/** Router state that opens a new chat with this text already in the composer. Kept out of the URL so a long message is not logged or shared. */
export interface ChatPrefill {
  prompt: string;
}

export const chatPrefill = (prompt: string): ChatPrefill => ({ prompt });

export function readChatPrefill(state: unknown): string | null {
  const prompt = (state as Partial<ChatPrefill> | null)?.prompt;
  return typeof prompt === "string" && prompt ? prompt : null;
}
