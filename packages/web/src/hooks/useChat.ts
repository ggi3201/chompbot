import { useState, useRef, useCallback, useEffect } from "react";
import type { AccessMode, AgentProvider, ApprovalDecision, ChatItem } from "@chomp/shared";
import { apiFetch, getToken } from "../lib/api";
import { maxSeq, upsertItems } from "../lib/chat-timeline";

let nextMsgKey = 1;
const NO_ITEMS: ChatItem[] = [];

interface Message {
  key: number;
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  agentUsed?: string;
  model?: string;
  isStreaming?: boolean;
  isNotification?: boolean;
  actionPrompt?: string;
  actionLabel?: string;
  createdAt?: string;
  /** Where a user message came from, when it was not the web chat. */
  source?: "telegram" | "discord";
  /** The agent turn that produced this reply; lets the timeline drop it when an item already shows the text. */
  turnId?: string;
  /** A steer the agent has not taken in yet; Send now can hurry it. */
  waiting?: boolean;
}

export type { Message };

type PersistedMessage = Omit<Message, "key" | "isStreaming" | "isNotification" | "actionPrompt" | "actionLabel" | "waiting">;

const settleWaiting = (prev: Message[]) => (prev.some((m) => m.waiting) ? prev.map((m) => (m.waiting ? { ...m, waiting: false } : m)) : prev);

export interface ChatAttachment {
  url: string;
  name: string;
  mimeType: string;
}

function isImageAttachment(attachment: ChatAttachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

function markdownLabel(value: string): string {
  return value.replace(/[\[\]\n]/g, " ").trim() || "attachment";
}

function contentWithAttachments(content: string, attachments?: ChatAttachment[]): string {
  if (!attachments || attachments.length === 0) return content;

  const attachmentMarkdown = attachments
    .map((attachment) => {
      const label = markdownLabel(attachment.name);
      return isImageAttachment(attachment)
        ? `![${label}](${attachment.url})`
        : `[${label}](${attachment.url})`;
    })
    .join("\n");

  return content ? `${content}\n\n${attachmentMarkdown}` : attachmentMarkdown;
}

function hydrateMessage(message: PersistedMessage): Message {
  return {
    ...message,
    key: nextMsgKey++,
    model: message.model ?? message.agentUsed,
  };
}

function messageSignature(message: Pick<Message, "role" | "content" | "createdAt">): string {
  return [message.role, message.content].join("\u0000");
}

function mergePersistedMessages(prev: Message[], persisted: PersistedMessage[]): Message[] {
  if (persisted.length === 0) return prev;

  // A known message keeps its React key: reconcile runs on every window focus, and a new key remounts it.
  const keyById = new Map(prev.map((message) => [message.id, message.key]));
  const persistedMessages = persisted.map((message) => ({
    ...hydrateMessage(message),
    key: keyById.get(message.id) ?? nextMsgKey++,
  }));
  const persistedIds = new Set(persistedMessages.map((message) => message.id).filter(Boolean));
  const persistedSignatures = new Set(persistedMessages.map(messageSignature));
  const localOnly = prev.filter((message) =>
    message.isNotification ||
    message.isStreaming ||
    (!message.id && !persistedSignatures.has(messageSignature(message))) ||
    (!!message.id && !persistedIds.has(message.id))
  );

  return [...persistedMessages, ...localOnly].sort((a, b) => {
    if (!a.createdAt || !b.createdAt) return 0;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

export interface ResearchFacetState {
  label: string;
  description: string;
  status: "pending" | "searching" | "reading" | "analyzing" | "done" | "error";
  summary?: string;
  sourceCount?: number;
  error?: string;
}

export interface ResearchPlanState {
  query: string;
  facets: ResearchFacetState[];
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [waitStatus, setWaitStatus] = useState<"triaging" | "streaming" | "agent_working" | "researching" | null>(null);
  const [agentElapsed, setAgentElapsed] = useState(0);
  const [agentActivity, setAgentActivity] = useState<string | null>(null);
  const [researchPlan, setResearchPlan] = useState<ResearchPlanState | null>(null);
  /** The note a `/handoff` turn wrote; the page opens a new chat with it. */
  const [handoffNote, setHandoffNote] = useState<{ conversationId: string; content: string } | null>(null);
  const clearHandoffNote = useCallback(() => setHandoffNote(null), []);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [pendingQuestion, setPendingQuestion] = useState<{ sessionId: string; question: string } | null>(null);
  // Agent timeline items, kept per conversation so switching back keeps them
  // and a sync only has to ask for what changed since.
  const [itemsByConversation, setItemsByConversation] = useState<Record<string, ChatItem[]>>({});
  // Highest item seq seen per conversation, read when (re)syncing. A ref
  // because the socket callbacks outlive renders.
  const seqRef = useRef<Record<string, number>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef<string>("");
  const pendingModelRef = useRef<string | undefined>(undefined);
  const currentAgentRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref mirrors conversationId state so the connect callback (stable ref) can read the latest value
  const conversationIdRef = useRef<string | undefined>(undefined);
  // Tracks whether we have an active outbound request so that sync_complete
  // (which fires on WS reconnect) doesn't prematurely kill the spinner when
  // the agent session hasn't been registered yet (e.g. during triage).
  const activeRequestRef = useRef(false);
  // Track server heartbeats to detect zombie connections (readyState OPEN but TCP dead)
  const lastHeartbeatRef = useRef<number>(Date.now());

  const applyItems = useCallback((id: string, incoming: ChatItem[]) => {
    if (incoming.length === 0) return;
    seqRef.current[id] = Math.max(seqRef.current[id] ?? 0, maxSeq(incoming));
    setItemsByConversation((prev) => {
      const current = prev[id] ?? [];
      const next = upsertItems(current, incoming);
      return next === current ? prev : { ...prev, [id]: next };
    });
  }, []);

  const syncPayload = useCallback((id: string) => JSON.stringify({
    type: "sync",
    conversationId: id,
    ...(seqRef.current[id] ? { afterSeq: seqRef.current[id] } : {}),
  }), []);

  const reconcileConversation = useCallback(async (id?: string, { messages = true }: { messages?: boolean } = {}) => {
    if (!id) return;
    const loadMessages = async () => {
      const res = await apiFetch(`/conversations/${id}/messages`);
      if (!res.ok) return;
      const persisted = await res.json() as PersistedMessage[];
      if (!mountedRef.current || conversationIdRef.current !== id) return;
      setMessages((prev) => mergePersistedMessages(prev, persisted));
    };
    const loadItems = async () => {
      const res = await apiFetch(`/conversations/${id}/items`);
      if (!res.ok || !mountedRef.current) return;
      applyItems(id, await res.json() as ChatItem[]);
    };
    // WebSocket sync still handles active-session state; REST reconciliation is a safety net.
    await Promise.allSettled([messages ? loadMessages() : undefined, loadItems()]);
  }, [applyItems]);

  function appendAssistantMessage(
    prev: Message[],
    incoming: Pick<Message, "id" | "content" | "agentUsed" | "model" | "createdAt" | "turnId">,
  ): Message[] {
    if (!incoming.content?.trim()) return prev;
    const last = prev[prev.length - 1];
    const hasIt = prev.some((m) => incoming.id && m.id === incoming.id)
      || (!!last && last.role === "assistant" && last.content === incoming.content);
    if (hasIt) return prev;
    return [
      ...prev,
      {
        key: nextMsgKey++,
        role: "assistant",
        ...incoming,
      },
    ];
  }

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const token = getToken();
    if (!token) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${token}`);

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setIsConnected(true);
      lastHeartbeatRef.current = Date.now();
      // Re-attach to active conversation after reconnect so agent replies are routed here
      if (conversationIdRef.current) {
        ws.send(syncPayload(conversationIdRef.current));
        void reconcileConversation(conversationIdRef.current);
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setIsConnected(false);
      reconnectTimerRef.current = setTimeout(connect, 3000);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      const data = JSON.parse(event.data);

      // Ignore events scoped to a different conversation. The server tags all
      // chat events with conversationId so that if the user switches to a new
      // chat while an old agent is still running, its events don't bleed through.
      // Unscoped events (notifications, errors without a conversationId) are
      // always delivered. The "conversation" event is always allowed through
      // because it establishes our conversationId for a new chat.
      if (
        data.conversationId &&
        data.type !== "conversation" &&
        data.conversationId !== conversationIdRef.current
      ) {
        return;
      }

      switch (data.type) {
        case "conversation":
          setConversationId(data.conversationId);
          break;

        case "item":
          applyItems(data.conversationId, [data.item as ChatItem]);
          break;

        case "items":
          applyItems(data.conversationId, data.items as ChatItem[]);
          break;

        case "steered":
          // The server folded the message into the running turn. That turn
          // still ends with its own done/error, so there is nothing to reset.
          break;

        case "steers_taken":
          setMessages(settleWaiting);
          break;

        case "status":
          setWaitStatus(data.status);
          break;

        case "meta":
          // Store model info for the next message
          pendingModelRef.current = data.model;
          setWaitStatus("streaming");
          break;

        case "routing":
          currentAgentRef.current = data.agent;
          setIsWaiting(false);
          setWaitStatus("agent_working");
          setAgentElapsed(0);
          streamingRef.current = "";
          break;

        case "agent_progress":
          setWaitStatus("agent_working");
          setAgentElapsed(data.elapsedSeconds ?? 0);
          // Progress heartbeat carries latest activity as fallback
          if (data.activity?.summary) setAgentActivity(data.activity.summary);
          break;

        case "agent_activity":
          setAgentActivity(data.summary);
          break;

        case "research_plan":
          setResearchPlan({ query: data.query, facets: data.facets });
          setWaitStatus("researching");
          setIsWaiting(false);
          break;

        case "research_facet_update":
          setResearchPlan((prev) => {
            if (!prev) return prev;
            const facets = [...prev.facets];
            if (facets[data.facetIndex]) {
              facets[data.facetIndex] = {
                ...facets[data.facetIndex],
                status: data.status,
                ...(data.summary ? { summary: data.summary } : {}),
                ...(data.sourceCount !== undefined ? { sourceCount: data.sourceCount } : {}),
                ...(data.error ? { error: data.error } : {}),
              };
            }
            return { ...prev, facets };
          });
          break;

        case "chunk":
          setIsWaiting(false);
          setWaitStatus(null);
          streamingRef.current += data.content;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.isStreaming) {
              return [...prev.slice(0, -1), { ...last, content: streamingRef.current }];
            }
            streamingRef.current = data.content;
            return [
              ...prev,
              {
                key: nextMsgKey++,
                role: "assistant",
                content: data.content,
                model: pendingModelRef.current,
                isStreaming: true,
                createdAt: new Date().toISOString(),
              },
            ];
          });
          break;

        case "done":
          setMessages(settleWaiting);
          activeRequestRef.current = false;
          setIsWaiting(false);
          setWaitStatus(null);
          setAgentElapsed(0);
          setAgentActivity(null);
          setPendingQuestion(null);
          setResearchPlan(null);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.isStreaming) {
              // Finalize streaming message
              return [...prev.slice(0, -1), { ...last, id: data.messageId, isStreaming: false }];
            }
            if (data.replyMessage?.content) {
              return appendAssistantMessage(prev, {
                id: data.replyMessage.id,
                content: data.replyMessage.content,
                agentUsed: data.replyMessage.agentUsed ?? data.agentUsed,
                model: data.replyMessage.agentUsed ?? data.agentUsed,
                createdAt: data.replyMessage.createdAt ?? new Date().toISOString(),
                turnId: data.replyMessage.turnId ?? data.turnId,
              });
            }
            // For delegated agents: done includes the final response content
            if (data.content) {
              return appendAssistantMessage(prev, {
                id: data.messageId,
                content: data.content,
                agentUsed: data.agentUsed,
                model: data.agentUsed,
                createdAt: new Date().toISOString(),
                turnId: data.turnId,
              });
            }
            return prev;
          });
          streamingRef.current = "";
          pendingModelRef.current = undefined;
          break;

        case "agent_message": {
          if (!data.content?.trim()) break;
          const agent = data.agentUsed ?? currentAgentRef.current;
          setMessages((prev) => appendAssistantMessage(prev, {
            id: data.id,
            content: data.content,
            agentUsed: agent,
            model: agent,
            createdAt: data.createdAt ?? new Date().toISOString(),
            turnId: data.turnId,
          }));
          break;
        }

        case "question": {
          setPendingQuestion({ sessionId: data.sessionId, question: data.question });
          setIsWaiting(false);
          setWaitStatus(null);
          setAgentElapsed(0);
          setAgentActivity(null);
          const questionAgent = currentAgentRef.current;
          setMessages((prev) => [
            ...prev,
            { key: nextMsgKey++, role: "assistant", content: data.question, agentUsed: questionAgent, model: questionAgent, createdAt: new Date().toISOString() },
          ]);
          break;
        }

        case "notification":
          setMessages((prev) => [
            ...prev,
            {
              key: nextMsgKey++,
              role: "system",
              content: `**${data.title}**\n${data.body}`,
              isNotification: true,
              actionPrompt: typeof data.actionPrompt === "string" ? data.actionPrompt : undefined,
              actionLabel: typeof data.actionLabel === "string" ? data.actionLabel : undefined,
              createdAt: new Date().toISOString(),
            },
          ]);
          break;

        case "cancelled":
          activeRequestRef.current = false;
          setIsWaiting(false);
          setWaitStatus(null);
          setAgentElapsed(0);
          setAgentActivity(null);
          setPendingQuestion(null);
          setResearchPlan(null);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.isStreaming) {
              return [...prev.slice(0, -1), { ...last, isStreaming: false }];
            }
            return prev;
          });
          streamingRef.current = "";
          // A chomp_reply can land in the DB right as the session is killed (the
          // tool call races the teardown). Reconcile from the DB so that answer
          // surfaces instead of vanishing into the cancelled void.
          void reconcileConversation(conversationIdRef.current);
          break;

        case "sync_complete":
          // Server confirmed no active agent and no in-flight request for this
          // conversation. Only clear waiting state if we don't have an active
          // request in this session — a WS reconnect during triage (before the
          // agent is registered) would otherwise kill the spinner.
          if (!activeRequestRef.current) {
            setIsWaiting(false);
            setWaitStatus(null);
            setAgentElapsed(0);
            setAgentActivity(null);
            setPendingQuestion(null);
            streamingRef.current = "";

            // Reconcile last message — if the server includes a lastMessage that
            // the client doesn't have, add it. This catches done events that were
            // lost to zombie WS connections (sent on a dead socket).
            if (data.lastMessage?.content) {
              setMessages((prev) => {
                // Check if we already have this message (by id or matching content in last msg)
                const hasIt = prev.some((m) => m.id === data.lastMessage.id) ||
                  (prev.length > 0 && prev[prev.length - 1].content === data.lastMessage.content);
                if (hasIt) return prev;
                return appendAssistantMessage(prev, {
                  id: data.lastMessage.id,
                  content: data.lastMessage.content,
                  agentUsed: data.lastMessage.agentUsed,
                  model: data.lastMessage.agentUsed,
                  createdAt: new Date().toISOString(),
                });
              });
            }
          }
          break;

        case "handoff":
          if (typeof data.content === "string" && typeof data.conversationId === "string") {
            setHandoffNote({ conversationId: data.conversationId, content: data.content });
          }
          break;

        case "heartbeat":
          lastHeartbeatRef.current = Date.now();
          break;

        case "error":
          setMessages(settleWaiting);
          activeRequestRef.current = false;
          setIsWaiting(false);
          setWaitStatus(null);
          setAgentElapsed(0);
          setAgentActivity(null);
          setPendingQuestion(null);
          setMessages((prev) => [
            ...prev,
            { key: nextMsgKey++, role: "assistant", content: `Error: ${data.error}`, createdAt: new Date().toISOString() },
          ]);
          break;
      }
    };

    wsRef.current = ws;
  }, [applyItems, reconcileConversation, syncPayload]);

  // Keep conversationIdRef in sync so connect() can read the latest value
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    // On mobile, browsers freeze background timers so the WebSocket reconnect
    // timer may never fire. Reconnect immediately when the page becomes visible.
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        const ws = wsRef.current;
        // On iOS, backgrounded timers are frozen, so the 3 s reconnect timer may
        // never fire. Also treat CONNECTING as stale: a background connect attempt
        // often hangs indefinitely on iOS Safari, so close it and try fresh.
        const heartbeatStale = Date.now() - lastHeartbeatRef.current > 45_000;
        const needsReconnect =
          !ws ||
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING ||
          ws.readyState === WebSocket.CONNECTING ||
          heartbeatStale;
        if (needsReconnect) {
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          wsRef.current?.close();
          connect();
        } else if (conversationIdRef.current) {
          ws.send(syncPayload(conversationIdRef.current));
          void reconcileConversation(conversationIdRef.current);
        }
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Periodically check for stale heartbeat — catches zombie connections where
    // readyState is OPEN but TCP silently dropped (the main cause of the
    // "need to refresh to see messages" bug).
    const heartbeatCheck = setInterval(() => {
      const ws = wsRef.current;
      if (
        ws &&
        ws.readyState === WebSocket.OPEN &&
        Date.now() - lastHeartbeatRef.current > 45_000
      ) {
        ws.close();
        // onclose handler will trigger reconnect
      }
    }, 10_000);

    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearInterval(heartbeatCheck);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect, reconcileConversation, syncPayload]);

  function answerQuestion(answer: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!pendingQuestion) return;

    setMessages((prev) => [
      ...prev,
      { key: nextMsgKey++, role: "user", content: answer, createdAt: new Date().toISOString() },
    ]);

    wsRef.current.send(
      JSON.stringify({
        type: "answer",
        sessionId: pendingQuestion.sessionId,
        answer,
      })
    );
    setPendingQuestion(null);
  }

  // Stable between keystrokes: Chat's memoized MessageList gets handlers built on this.
  const sendMessage = useCallback((
    content: string,
    attachments?: ChatAttachment[],
    opts?: {
      provider?: AgentProvider;
      model?: string;
      effort?: string;
      channelContext?: string;
      fast?: boolean;
      access?: AccessMode;
      /** Stop the running turn and run this message as a new one, instead of steering. */
      interrupt?: boolean;
      soulId?: string;
      /** `/handoff`: the session writes a note for a new chat. */
      handoff?: { goal: string };
      /** A new chat's first message after a handoff: the chat it continues. */
      handoffFrom?: string;
      /** A new chat's first message: the repo its agents run in. */
      projectPath?: string;
      /** With projectPath: false works in the repo checkout itself, not the chat's own worktree. */
      worktree?: boolean;
    },
  ) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    // A message sent while a turn runs steers that turn (the server answers
    // "steered"), so it must not start a second working state.
    const steering = isWaiting || waitStatus !== null;
    activeRequestRef.current = true;
    const optimisticContent = contentWithAttachments(content, attachments);
    setMessages((prev) => [
      ...prev,
      { key: nextMsgKey++, role: "user", content: optimisticContent, createdAt: new Date().toISOString(), ...(steering && !opts?.interrupt && !opts?.handoff ? { waiting: true } : {}) },
    ]);
    if (!steering) setIsWaiting(true);

    wsRef.current.send(
      JSON.stringify({
        type: "chat",
        content,
        conversationId,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(opts?.provider ? { provider: opts.provider } : {}),
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.effort ? { effort: opts.effort } : {}),
        ...(opts?.channelContext ? { channelContext: opts.channelContext } : {}),
        ...(opts?.fast !== undefined ? { fast: opts.fast } : {}),
        ...(opts?.interrupt && steering ? { interrupt: true } : {}),
        ...(opts?.soulId ? { soulId: opts.soulId } : {}),
        ...(opts?.access ? { access: opts.access } : {}),
        ...(opts?.handoff ? { handoff: opts.handoff } : {}),
        ...(opts?.handoffFrom ? { handoffFrom: opts.handoffFrom } : {}),
        ...(opts?.projectPath ? { projectPath: opts.projectPath } : {}),
        ...(opts?.worktree === false ? { worktree: false } : {}),
      })
    );
  }, [isWaiting, waitStatus, conversationId]);

  /** Send now on a waiting steer: the agent drops what it is doing and takes the message in. */
  const hurry = useCallback(() => {
    const id = conversationIdRef.current;
    if (!id || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "hurry", conversationId: id }));
    setMessages(settleWaiting);
  }, []);

  const answerApproval = useCallback((requestId: string, decision: ApprovalDecision) => {
    const id = conversationIdRef.current;
    if (!id || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "approval", conversationId: id, requestId, decision }));
    // Show the answer at once; the server's upsert of the item confirms it.
    setItemsByConversation((prev) => {
      const items = prev[id];
      if (!items) return prev;
      return {
        ...prev,
        [id]: items.map((item) =>
          item.kind === "approval" && item.requestId === requestId && item.state === "pending"
            ? { ...item, state: decision }
            : item,
        ),
      };
    });
  }, []);

  /** `fresh`: history was fetched just now, so skip re-fetching it (that re-renders every message). */
  function switchConversation(id: string, history: Message[], { fresh = false }: { fresh?: boolean } = {}) {
    activeRequestRef.current = false;
    setConversationId(id);
    conversationIdRef.current = id;
    setMessages(history);
    setIsWaiting(false);
    setWaitStatus(null);
    setAgentElapsed(0);
    setAgentActivity(null);
    setPendingQuestion(null);
    streamingRef.current = "";

    // Sync with server to restore agent state if one is running
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(syncPayload(id));
    }
    void reconcileConversation(id, { messages: !fresh });
  }

  function prependMessages(history: Message[]) {
    if (history.length === 0) return;
    setMessages((prev) => {
      const existingIds = new Set(prev.map((message) => message.id).filter(Boolean));
      const existingSignatures = new Set(prev.map(messageSignature));
      const older = history.filter((message) => {
        if (message.id && existingIds.has(message.id)) return false;
        return !existingSignatures.has(messageSignature(message));
      });
      return [...older, ...prev];
    });
  }

  function newConversation() {
    activeRequestRef.current = false;
    setConversationId(undefined);
    conversationIdRef.current = undefined;
    setMessages([]);
    setIsWaiting(false);
    setWaitStatus(null);
    setAgentElapsed(0);
    setAgentActivity(null);
    setPendingQuestion(null);
    streamingRef.current = "";
  }

  function sendFeedback(messageId: string, feedbackType: "thumbs_up" | "thumbs_down", correction?: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: "feedback",
      messageId,
      feedbackType,
      ...(correction ? { correction } : {}),
    }));
  }

  const stopResponse = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "cancel" }));
    activeRequestRef.current = false;
    setIsWaiting(false);
    setWaitStatus(null);
    setAgentElapsed(0);
    streamingRef.current = "";
  }, []);

  return {
    messages,
    items: (conversationId && itemsByConversation[conversationId]) || NO_ITEMS,
    answerApproval,
    hurry,
    sendMessage,
    sendFeedback,
    stopResponse,
    answerQuestion,
    pendingQuestion,
    isConnected,
    isWaiting,
    waitStatus,
    agentElapsed,
    agentActivity,
    researchPlan,
    conversationId,
    switchConversation,
    prependMessages,
    reconcileConversation,
    newConversation,
    handoffNote,
    clearHandoffNote,
  };
}
