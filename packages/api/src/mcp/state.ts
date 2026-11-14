// Shared MCP state — callback registries and session tracking.
// Extracted from server.ts so tool-handlers.ts can import without circular deps.

type MessageCallback = (sessionId: string, message: string) => void;

export interface SessionReply {
  id: string;
  content: string;
  createdAt: string;
  agentUsed: string;
}

type ReplyCallback = (sessionId: string, reply: SessionReply) => void;

export const questionCallbacks: MessageCallback[] = [];
export const replyCallbacks: ReplyCallback[] = [];

/** Map sessionId → conversationId so we can persist agent replies */
export const sessionConversations = new Map<string, string>();

/** Track which sessions have sent at least one reply via chomp_reply */
const sessionReplied = new Set<string>();
const sessionReplyMeta = new Map<string, SessionReply>();

export function markSessionReplied(sessionId: string, reply: SessionReply) {
  sessionReplied.add(sessionId);
  sessionReplyMeta.set(sessionId, reply);
}

export function hasSessionReplied(sessionId: string): boolean {
  return sessionReplied.has(sessionId);
}

/** Sessions whose most recent tool call was chomp_reply. */
const sessionEndedOnReply = new Set<string>();

/** Matches the reply tool as Claude Code names it (`mcp__chomp-api__reply`,
 *  `mcp__chomp__chomp_reply`), but not ask_user or other chomp tools. */
export function isChompReplyTool(toolName: string): boolean {
  return /^mcp__chomp[\w-]*__(chomp_)?reply$/.test(toolName);
}

/** Record a runner tool call so we know whether the turn ended on a reply. */
export function markSessionToolUse(sessionId: string, toolName: string) {
  if (isChompReplyTool(toolName)) sessionEndedOnReply.add(sessionId);
  else sessionEndedOnReply.delete(sessionId);
}

/** True when chomp_reply was the last tool the agent called. Any trailing
 *  runner text is then a recap of what the user has already seen. */
export function hasSessionEndedOnReply(sessionId: string): boolean {
  return sessionEndedOnReply.has(sessionId);
}

export function getSessionReply(sessionId: string): SessionReply | undefined {
  return sessionReplyMeta.get(sessionId);
}

export function clearSessionState(sessionId: string) {
  sessionConversations.delete(sessionId);
  sessionReplied.delete(sessionId);
  sessionReplyMeta.delete(sessionId);
  sessionEndedOnReply.delete(sessionId);
}

export function registerSessionConversation(sessionId: string, conversationId: string) {
  sessionConversations.set(sessionId, conversationId);
}

export function getSessionConversationId(sessionId: string): string | undefined {
  return sessionConversations.get(sessionId);
}

export function onAskUser(cb: MessageCallback) {
  questionCallbacks.push(cb);
}

export function onReply(cb: ReplyCallback) {
  replyCallbacks.push(cb);
}
