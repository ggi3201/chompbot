export type MessageRole = "user" | "assistant" | "system";

export interface RoutingDecision {
  action: "direct" | "delegate";
  agent?: string;
  prompt?: string;
  reason?: string;
  response?: string;
  /** Set when the message @mentioned a soul: run the agent with that soul. */
  soulId?: string;
  /** Set when the message @mentioned a provider (@claude, @codex). */
  provider?: "claude" | "codex";
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  routing?: RoutingDecision;
  agentUsed?: string;
  /** Dispatch session id of the agent turn that produced this message. The web
   *  timeline hides an assistant message whose text a `chat_items` row of the
   *  same turn already shows. */
  turnId?: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}
