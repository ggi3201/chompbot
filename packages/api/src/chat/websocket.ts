import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import jwt from "jsonwebtoken";
import { handleChatMessage, steeredMessage, type ChatContext } from "./handler.js";
import { answerPendingQuestion, hasPendingQuestion, getPendingQuestion } from "../mcp/pending-questions.js";
import { onAskUser, onReply } from "../mcp/server.js";
import { getSessionConversationId } from "../mcp/state.js";
import { registerConnection } from "../notifications/web-connections.js";
import { emit } from "../events/bus.js";
import { JWT_SECRET } from "../auth/config.js";
import { saveFeedback } from "./feedback.js";
import { findProject } from "../lib/projects.js";
import { getActiveSessionByConversation } from "../agents/registry.js";
import { db } from "../db/index.js";
import { chatMessages, conversations } from "../db/schema.js";
import { eq, desc, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { APPROVAL_DECISIONS, normalizeAccessMode } from "@chomp/shared";
import { listChatItems, onChatItem } from "../agents/runtime/items.js";
import { activeRuntime, answerApproval, steerConversation } from "../agents/runtime/pool.js";

let sendToConversation: ((conversationId: string, payload: object) => void) | null = null;

/**
 * A chat context for a turn no request started (a turn resumed after a
 * restart): events go to whichever socket shows the conversation, if any.
 * A socket that connects later catches up through sync and the items replay.
 */
export function backgroundContext(conversationId: string): ChatContext {
  return {
    conversationId,
    send: (payload) => sendToConversation?.(conversationId, { conversationId, ...payload }),
  };
}

export function attachWebSocket(server: Server) {
  // `noServer: true` + manual path dispatch: the alternative `path: "/ws"`
  // option makes ws attach an 'upgrade' listener that rejects every request
  // whose path doesn't match (HTTP 400). When a second WebSocketServer is
  // attached to the same http.Server for a different path (e.g. /device-bridge),
  // both listeners fire for every upgrade and one always 400s. Owning the
  // dispatch ourselves avoids the cross-rejection.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);
    if (url.pathname !== "/ws") return; // not ours — leave the socket for other WSSes
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // Map session IDs to WebSocket clients for routing ask_user questions
  const sessionSockets = new Map<string, WebSocket>();

  // Map conversation IDs to current WebSocket — allows re-wiring agent events on reconnect
  const conversationWs = new Map<string, WebSocket>();

  // ── Message buffer for undeliverable WS messages ──
  // When the WebSocket disconnects briefly (mobile, network hiccup), messages
  // sent during the gap are buffered here and replayed on reconnect via sync.
  const pendingMessages = new Map<string, { payload: object; ts: number }[]>();
  const MAX_BUFFER = 100;
  const BUFFER_TTL = 5 * 60 * 1000; // 5 minutes

  function bufferMessage(convId: string, payload: object) {
    if (!convId) return;
    let buf = pendingMessages.get(convId);
    if (!buf) {
      buf = [];
      pendingMessages.set(convId, buf);
    }
    buf.push({ payload, ts: Date.now() });
    if (buf.length > MAX_BUFFER) buf.shift();
  }

  function flushBuffer(convId: string, targetWs: WebSocket) {
    const buf = pendingMessages.get(convId);
    if (!buf || buf.length === 0) return;
    pendingMessages.delete(convId);
    const now = Date.now();
    for (const entry of buf) {
      if (now - entry.ts < BUFFER_TTL && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(entry.payload));
      }
    }
  }

  // Clean up stale buffers every 60s
  const bufferCleanup = setInterval(() => {
    const now = Date.now();
    for (const [convId, buf] of pendingMessages) {
      const live = buf.filter((e) => now - e.ts < BUFFER_TTL);
      if (live.length === 0) pendingMessages.delete(convId);
      else pendingMessages.set(convId, live);
    }
  }, 60_000);
  bufferCleanup.unref();

  // ── WebSocket heartbeat ──
  // Detect zombie connections where TCP silently dropped (NAT timeout, network
  // hiccup, mobile backgrounding). Server pings every 30s; if no pong comes
  // back by the next tick, the connection is terminated so messages get buffered
  // instead of sent into a black hole.
  const HEARTBEAT_INTERVAL = 30_000;
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if ((client as any).__isAlive === false) {
        client.terminate();
        continue;
      }
      (client as any).__isAlive = false;
      client.ping();
      // Send a JSON heartbeat so the browser client can detect server liveness
      // (browsers don't expose protocol-level ping/pong to JS)
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "heartbeat" }));
      }
    }
  }, HEARTBEAT_INTERVAL);
  heartbeat.unref();

  // Track conversations with in-progress requests so sync doesn't prematurely
  // send sync_complete during triage (before the agent session is registered).
  const processingConversations = new Set<string>();

  // The chat request in flight per conversation. "Send now" marks it superseded:
  // its turn is interrupted, and its closing done/error must not reach the client,
  // which is already waiting on the message that replaced it.
  const inFlight = new Map<string, { superseded: boolean }>();

  async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Resolve the socket to push an agent message/question to. Prefer the
  // session socket, but fall back to the conversation socket: when a user hits
  // Stop, the session→socket mapping is deleted while the conversation→socket
  // mapping survives. An in-flight chomp_reply that lands *after* the cancel
  // would otherwise only see the dead session socket and get buffered until the
  // next reconnect — so the user never sees the answer they were waiting for.
  // Routing it to the live conversation socket delivers it immediately instead.
  function resolveClientWs(sessionId: string, convId?: string): WebSocket | undefined {
    const sessionWs = sessionSockets.get(sessionId);
    if (sessionWs && sessionWs.readyState === WebSocket.OPEN) return sessionWs;
    if (convId) {
      const convWs = conversationWs.get(convId);
      if (convWs && convWs.readyState === WebSocket.OPEN) return convWs;
    }
    return undefined;
  }

  // Register callback so MCP ask_user can push questions to the right WS client
  onAskUser((sessionId, question) => {
    const convId = getSessionConversationId(sessionId);
    const payload = { type: "question", sessionId, question, conversationId: convId };
    const ws = resolveClientWs(sessionId, convId);
    if (ws) {
      ws.send(JSON.stringify(payload));
    } else if (convId) {
      bufferMessage(convId, payload);
    }
  });

  onReply((sessionId, reply) => {
    const convId = getSessionConversationId(sessionId);
    const payload = {
      type: "agent_message",
      sessionId,
      turnId: sessionId,
      id: reply.id,
      content: reply.content,
      agentUsed: reply.agentUsed,
      createdAt: reply.createdAt,
      conversationId: convId,
    };
    const ws = resolveClientWs(sessionId, convId);
    if (ws) {
      ws.send(JSON.stringify(payload));
    } else if (convId) {
      bufferMessage(convId, payload);
    }
  });

  sendToConversation = (conversationId, payload) => {
    const ws = conversationWs.get(conversationId);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  // Agent items go to whichever socket shows the conversation. One that misses
  // an item (closed, or looking at another chat) catches up on its next sync
  // with `afterSeq`, so nothing is buffered here.
  onChatItem((item) => {
    const ws = conversationWs.get(item.conversationId);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "item", conversationId: item.conversationId, item }));
    }
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(4001, "Missing token");
      return;
    }

    try {
      jwt.verify(token, JWT_SECRET);
    } catch {
      ws.close(4001, "Invalid token");
      return;
    }

    // Register this connection for notification routing (Web → Telegram fallback)
    const connectionId = Math.random().toString(36).slice(2);
    registerConnection(connectionId, ws);
    emit({ type: "user.active", channel: "web" });

    // Heartbeat tracking — mark alive on connect and on every pong response
    (ws as any).__isAlive = true;
    ws.on("pong", () => { (ws as any).__isAlive = true; });

    let conversationId: string | undefined;
    let activeSessionId: string | undefined;
    let activeAbortController: AbortController | null = null;

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "chat" && msg.conversationId && typeof msg.content === "string" && inFlight.has(msg.conversationId)) {
          const busyConversationId: string = msg.conversationId;
          if (msg.handoff) {
            // A handoff sums up the finished work, so it waits for the running turn instead of steering it.
            await waitUntil(() => !inFlight.has(busyConversationId), 60 * 60_000);
          } else if (msg.interrupt === true) {
            // Send now: end the running turn quietly, then run this as a new turn.
            inFlight.get(busyConversationId)!.superseded = true;
            await waitUntil(() => !!activeRuntime(busyConversationId) || !inFlight.has(busyConversationId), 60_000);
            await activeRuntime(busyConversationId)?.interrupt();
            await waitUntil(() => !inFlight.has(busyConversationId), 30_000);
          } else {
            // Steer: the turn may still be routing or building its context, so
            // wait until the agent runs. If it ends first, this is a new turn.
            await waitUntil(() => !!activeRuntime(busyConversationId) || !inFlight.has(busyConversationId), 60_000);
            const steered = steeredMessage(msg.content, [msg.attachments, msg.images].find(Array.isArray));
            if (activeRuntime(busyConversationId) && await steerConversation(busyConversationId, steered.forAgent)) {
              const steeredAt = new Date().toISOString();
              db.insert(chatMessages).values({
                id: randomUUID(),
                conversationId: busyConversationId,
                role: "user",
                content: steered.stored,
                createdAt: steeredAt,
              }).run();
              db.update(conversations).set({ updatedAt: steeredAt }).where(eq(conversations.id, busyConversationId)).run();
              conversationWs.set(busyConversationId, ws);
              ws.send(JSON.stringify({ type: "steered", conversationId: busyConversationId }));
              return;
            }
          }
        }

        if (msg.type === "chat") {
          // Use the client-provided conversationId directly. When the client sends
          // undefined (new chat), do NOT fall back to the previous conversation —
          // let handleChatMessage create a fresh one. This also scopes send() to
          // THIS request so a sync from a conversation switch can't redirect output.
          let msgConversationId: string | undefined = msg.conversationId || undefined;

          activeAbortController = new AbortController();
          const request = { superseded: false };
          const ctx: ChatContext = {
            conversationId: msgConversationId ?? "",
            abortSignal: activeAbortController.signal,
            isSuperseded: () => request.superseded,
            send: (payload) => {
              // Update tracked IDs before attempting delivery
              if ("conversationId" in payload) {
                msgConversationId = (payload as { conversationId: string }).conversationId;
                conversationId = msgConversationId;
                conversationWs.set(msgConversationId, ws);
                processingConversations.add(msgConversationId);
                inFlight.set(msgConversationId, request);
              }
              if (request.superseded && ["done", "error", "cancelled"].includes((payload as { type?: string }).type ?? "")) return;
              if ("sessionId" in payload) {
                activeSessionId = (payload as { sessionId: string }).sessionId;
                sessionSockets.set(activeSessionId, ws);
              }

              // Route to the latest WS for this conversation (handles reconnects)
              const targetWs = msgConversationId ? (conversationWs.get(msgConversationId) ?? ws) : ws;
              // Tag every event with the conversationId so the client can filter
              const enriched = msgConversationId ? { conversationId: msgConversationId, ...payload } : payload;
              if (targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(JSON.stringify(enriched));
              } else if (msgConversationId) {
                // WS disconnected — buffer for replay on reconnect
                bufferMessage(msgConversationId, enriched);
              }
            },
          };

          if (msgConversationId) {
            processingConversations.add(msgConversationId);
            inFlight.set(msgConversationId, request);
          }
          try {
            // Accept `attachments` (new wire format) or `images` (legacy string[] of URLs).
            // Older clients that haven't reloaded yet may still send `images`.
            const attachments = Array.isArray(msg.attachments)
              ? msg.attachments
              : Array.isArray(msg.images)
                ? msg.images.map((url: string) => ({
                  url,
                  name: url.split("/").pop() ?? "image",
                  mimeType: "image/jpeg",
                }))
                : undefined;
            await handleChatMessage(msg.content, ctx, attachments, {
              ...(msg.provider === "claude" || msg.provider === "codex" ? { provider: msg.provider } : {}),
              model: msg.model,
              effort: typeof msg.effort === "string" ? msg.effort : undefined,
              fast: msg.fast === true,
              access: normalizeAccessMode(msg.access),
              autonomy: msg.autonomy,
              soulId: typeof msg.soulId === "string" && msg.soulId ? msg.soulId : undefined,
              ...(msg.handoff ? { handoff: { goal: typeof msg.handoff.goal === "string" ? msg.handoff.goal : "" } } : {}),
              ...(typeof msg.handoffFrom === "string" && msg.handoffFrom ? { handoffFrom: msg.handoffFrom } : {}),
              ...(typeof msg.projectPath === "string" && findProject(msg.projectPath) ? { projectPath: msg.projectPath } : {}),
              ...(msg.worktree === false ? { worktree: false } : {}),
              channelContext: typeof msg.channelContext === "string" ? msg.channelContext : undefined,
              deliveryChannel: "web-chat",
            });
          } finally {
            if (msgConversationId) {
              processingConversations.delete(msgConversationId);
              if (inFlight.get(msgConversationId) === request) inFlight.delete(msgConversationId);
            }
          }
        } else if (msg.type === "approval") {
          if (typeof msg.conversationId === "string" && typeof msg.requestId === "string" && APPROVAL_DECISIONS.includes(msg.decision)) {
            answerApproval(msg.conversationId, msg.requestId, msg.decision);
          }
        } else if (msg.type === "hurry") {
          // Send now on a message that steered the turn and still waits for the next tool boundary.
          if (typeof msg.conversationId === "string") await activeRuntime(msg.conversationId)?.hurry();
        } else if (msg.type === "answer") {
          // User answering an ask_user question
          const { sessionId, answer } = msg;
          if (sessionId && answer) {
            answerPendingQuestion(sessionId, answer);
          }
        } else if (msg.type === "feedback") {
          // Routing feedback (thumbs up/down)
          saveFeedback(msg);
        } else if (msg.type === "cancel") {
          if (activeAbortController) {
            activeAbortController.abort();
            activeAbortController = null;
          }
          if (activeSessionId) {
            const { killSession } = await import("../agents/registry.js");
            killSession(activeSessionId);
            sessionSockets.delete(activeSessionId);
            activeSessionId = undefined;
          }
          ws.send(JSON.stringify({ type: "cancelled", ...(conversationId ? { conversationId } : {}) }));
        } else if (msg.type === "sync") {
          // Client reconnected or switched conversation — restore agent state
          const syncConvId: string | undefined = msg.conversationId;
          if (syncConvId) {
            conversationId = syncConvId;
            conversationWs.set(syncConvId, ws);

            // Replay any messages that were buffered while the WS was disconnected
            flushBuffer(syncConvId, ws);

            const afterSeq = Number(msg.afterSeq);
            if (Number.isFinite(afterSeq) && afterSeq >= 0) {
              const items = listChatItems(syncConvId, afterSeq);
              if (items.length > 0) ws.send(JSON.stringify({ type: "items", conversationId: syncConvId, items }));
            }

            const active = getActiveSessionByConversation(syncConvId);
            if (active) {
              activeSessionId = active.sessionId;
              sessionSockets.set(activeSessionId, ws);
              ws.send(JSON.stringify({
                type: "agent_progress",
                status: "working",
                elapsedSeconds: Math.round((Date.now() - active.startedAt) / 1000),
                conversationId: syncConvId,
                ...(active.lastActivity ? { activity: active.lastActivity } : {}),
              }));
              if (active.lastActivity) {
                ws.send(JSON.stringify({
                  type: "agent_activity",
                  sessionId: active.sessionId,
                  conversationId: syncConvId,
                  ...active.lastActivity,
                }));
              }
              // Re-send pending question if one exists — handles the case where the
              // original question was sent on a zombie WS (readyState OPEN but TCP dead).
              if (hasPendingQuestion(active.sessionId)) {
                const pending = getPendingQuestion(active.sessionId);
                if (pending) {
                  ws.send(JSON.stringify({
                    type: "question",
                    sessionId: active.sessionId,
                    question: pending.question,
                    conversationId: syncConvId,
                  }));
                }
              }
            } else if (processingConversations.has(syncConvId)) {
              // Request is still being processed (triage / agent dispatch) but the
              // agent session hasn't been registered yet. Don't send sync_complete
              // or we'd kill the client's spinner. Send a progress hint instead.
              ws.send(JSON.stringify({
                type: "agent_progress",
                status: "working",
                elapsedSeconds: 0,
                conversationId: syncConvId,
              }));
            } else {
              // No active session and no in-flight request — tell the client to
              // clear any stuck waiting state. This handles iOS backgrounding where
              // the WS drops, the agent finishes, and the "done" event is lost.
              // Include the last assistant message so the client can reconcile any
              // messages lost to zombie WS connections (e.g. done event sent on
              // a dead socket).
              const lastMsg = db.select()
                .from(chatMessages)
                .where(and(
                  eq(chatMessages.conversationId, syncConvId),
                  eq(chatMessages.role, "assistant"),
                ))
                .orderBy(desc(chatMessages.createdAt))
                .limit(1)
                .get();
              ws.send(JSON.stringify({
                type: "sync_complete",
                conversationId: syncConvId,
                ...(lastMsg ? { lastMessage: { id: lastMsg.id, content: lastMsg.content, agentUsed: lastMsg.agentUsed } } : {}),
              }));
            }
          }
        }
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid message format" }));
      }
    });

    ws.on("close", () => {
      // Clean up socket mappings (only if this ws is still the current one).
      // Guard against removing a newer connection that took over during reconnect.
      if (activeSessionId && sessionSockets.get(activeSessionId) === ws) {
        sessionSockets.delete(activeSessionId);
      }
      if (conversationId && conversationWs.get(conversationId) === ws) {
        conversationWs.delete(conversationId);
      }
      emit({ type: "user.idle", channel: "web" });
    });
  });

  return wss;
}
