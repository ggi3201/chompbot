import { Router, type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "crypto";
import type { AccessMode } from "@chomp/shared";
import { db } from "../db/index.js";
import { chatMessages, conversations } from "../db/schema.js";
import { getAllSecrets } from "../lib/secrets.js";
import { listProjects } from "../lib/projects.js";
import { MCP_TOOLS } from "../mcp/tool-definitions.js";
import { callMcpTool } from "../mcp/registry.js";
import { findChat } from "../chat/references.js";
import { placeholderTitle } from "../chat/handler.js";
import { MAX_MESSAGE, repliesSince, startTurnIn, underCap } from "../agents/tools/message-chat.js";
import { activeRuntime, lastTurnOptions } from "../agents/runtime/pool.js";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * Chomp as an MCP server for agents it did not start: Claude Code on the Mac, Codex, anything that speaks MCP over
 * HTTP. Stateless "streamable HTTP": one JSON-RPC message in, one JSON reply out. It is a narrow door on purpose:
 * reading chats and memories, and talking to chats, whose agents then act with that chat's own access. Never the
 * full tool set, which can text, email and delete.
 */

const TOKEN_PREFIX = "AGENT_TOKEN_";
const MIN_TOKEN = 24;
const WAIT_MS = 5 * 60_000;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SHARED = new Set(["list_conversations", "search_conversations", "get_conversation_messages", "recall_memories", "save_memory"]);

/** The outside agent a bearer token belongs to. Each secret named AGENT_TOKEN_<NAME> is one; deleting it revokes it. */
export function outsideAgent(authorization: string | undefined): string | null {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (token.length < MIN_TOKEN) return null;
  const given = Buffer.from(token);
  for (const [key, value] of Object.entries(getAllSecrets())) {
    if (!key.startsWith(TOKEN_PREFIX) || value.length < MIN_TOKEN) continue;
    const known = Buffer.from(value);
    if (known.length === given.length && timingSafeEqual(known, given)) return key.slice(TOKEN_PREFIX.length).replace(/_/g, " ");
  }
  return null;
}

const MAX_FROM = 120;
const FROM = { type: "string", description: "Which session you are, so the user and the chat's agent can tell your sessions apart: your working folder and task in a few words, e.g. \"chomp worktree preview-pane: PiP window\"" };
const WAIT = { type: "boolean", description: `Wait up to ${WAIT_MS / 60_000} minutes for the chat's answer and return it. Without it the call returns at once with a reply ticket for get_reply.` };
const POLL_MS = 1_000;

const OWN_TOOLS = [
  {
    name: "message_chat",
    description: "Send a message to the agent in one of the user's Chomp chats, as a new turn there. It runs on that chat's own model, with the access the user gave that chat, and the chat shows it under your name. Find chats with list_conversations or search_conversations. Each chat takes at most 5 agent messages per 10 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "The chat's conversation id, or its first 8 characters" },
        message: { type: "string", description: "What to tell its agent. Self-contained: it has not seen your session" },
        from: FROM,
        wait: WAIT,
      },
      required: ["conversationId", "message", "from"],
    },
  },
  {
    name: "start_chat",
    description: "Start a new Chomp chat with a message, to hand Chomp a task. With a project, Chomp's agent works in that repo on Chomp's server, in the chat's own git worktree. The user sees the chat in Chomp.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The task, self-contained" },
        project: { type: "string", description: "A repo under ~/code on Chomp's server, by folder name (e.g. chomp). Omit for a plain chat" },
        from: FROM,
        wait: WAIT,
      },
      required: ["message", "from"],
    },
  },
  {
    name: "get_reply",
    description: "The answer to a message you sent with message_chat or start_chat, by the reply ticket that call returned. Use it when the call did not wait, or its wait ran out, or Chomp restarted: the answer is kept in the chat, so it is never lost. Status is working or answered.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string", description: "The reply ticket, as returned: <conversation id>@<time>" },
        wait: { type: "boolean", description: `Wait up to ${WAIT_MS / 60_000} minutes for a chat that is still working` },
      },
      required: ["ticket"],
    },
  },
  {
    name: "my_chats",
    description: "The chats you (this agent, from any of its sessions) started or messaged, newest first: link, which session wrote last, whether it is still working, and a reply ticket for get_reply. Use it to find your way back to a chat, such as from a new session.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Only chats a session whose from label contains this wrote to, e.g. your worktree name" },
      },
    },
  },
];

function listTools() {
  const shared = MCP_TOOLS.filter((tool) => SHARED.has(tool.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return [...shared, ...OWN_TOOLS];
}

const text = (body: string, isError = false) => ({ content: [{ type: "text", text: body }], isError });

/** The chat as the outside agent should name it to the user: title, id and a link that opens it in Chomp. */
function chatLabel(conversationId: string, title: string, origin: string): string {
  return `"${title}" (chat ${conversationId}, ${origin}/chat/${conversationId})`;
}

/** Chats running a turn this process started from outside: covers the moment before the agent runtime reports busy. */
const inFlight = new Map<string, number>();

/**
 * A reply ticket names a message by its chat and the time it was sent. All it needs is in the database, so it still
 * works after Chomp restarts in the middle of the answer.
 */
export function parseTicket(ticket: string): { conversationId: string; sentAt: string } | null {
  const at = ticket.trim().lastIndexOf("@");
  if (at <= 0) return null;
  const conversationId = ticket.trim().slice(0, at);
  const sentAt = ticket.trim().slice(at + 1);
  return Number.isNaN(Date.parse(sentAt)) ? null : { conversationId, sentAt };
}

/** Whether the chat is still on it: a turn running, or one a restart interrupted and will resume. */
function stillWorking(conversationId: string): boolean {
  if ((inFlight.get(conversationId) ?? 0) > 0 || activeRuntime(conversationId)) return true;
  const row = db.select({ resumeTurn: conversations.resumeTurn }).from(conversations).where(eq(conversations.id, conversationId)).get();
  return Boolean(row?.resumeTurn);
}

type ReplyState = { status: "working" | "answered"; reply: string };

function replyState(conversationId: string, sentAt: string): ReplyState {
  if (stillWorking(conversationId)) return { status: "working", reply: "" };
  return { status: "answered", reply: repliesSince(conversationId, sentAt) || "(no text: open the chat to see what it did)" };
}

async function waitForReply(conversationId: string, sentAt: string): Promise<ReplyState> {
  const until = Date.now() + WAIT_MS;
  let state = replyState(conversationId, sentAt);
  while (state.status === "working" && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    state = replyState(conversationId, sentAt);
  }
  return state;
}

function stateResult(label: string, ticket: string, state: ReplyState) {
  const body = state.status === "answered"
    ? `${label} answered:\n\n${state.reply}`
    : `${label} is still working. Its answer stays in the chat: get the answer later with get_reply, ticket ${ticket}.`;
  return { ...text(body), structuredContent: { status: state.status, ticket, reply: state.reply } };
}

/** Runs the message in the chat, and with `wait` returns its answer. A turn that outlasts the wait keeps going. */
async function deliver(conversationId: string, label: string, content: string, extra: { access?: AccessMode; projectPath?: string }, wait: boolean) {
  const sentAt = new Date().toISOString();
  const ticket = `${conversationId}@${sentAt}`;
  inFlight.set(conversationId, (inFlight.get(conversationId) ?? 0) + 1);
  startTurnIn(conversationId, content, extra)
    .catch((err) => console.error(`[outside-mcp] Turn in ${conversationId} failed:`, err))
    .finally(() => {
      const left = (inFlight.get(conversationId) ?? 1) - 1;
      if (left > 0) inFlight.set(conversationId, left);
      else inFlight.delete(conversationId);
    });
  if (!wait) {
    return { ...text(`Sent to ${label}. Its agent answers there. Reply ticket: ${ticket} (get the answer with get_reply), and give the user the link.`), structuredContent: { status: "working", ticket, reply: "" } };
  }
  return stateResult(label, ticket, await waitForReply(conversationId, sentAt));
}

async function getReply(args: Record<string, unknown>, origin: string) {
  const parsed = parseTicket(typeof args.ticket === "string" ? args.ticket : "");
  if (!parsed) return text("ticket is not a reply ticket: pass it as message_chat or start_chat returned it, <conversation id>@<time>.", true);
  const chat = findChat(parsed.conversationId);
  if (!chat || chat.id !== parsed.conversationId) return text(`No chat with id ${parsed.conversationId}.`, true);
  const ticket = `${chat.id}@${parsed.sentAt}`;
  const state = args.wait === true ? await waitForReply(chat.id, parsed.sentAt) : replyState(chat.id, parsed.sentAt);
  return stateResult(chatLabel(chat.id, chat.title ?? "Untitled", origin), ticket, state);
}

const MY_CHATS_LIMIT = 20;
const LABEL_END = "), outside Chomp:**";

/** The chats this agent's messages went to, found by the label every message from outside carries. */
function myChats(args: Record<string, unknown>, agent: string, origin: string) {
  const prefix = `**From ${agent} (`;
  const filter = typeof args.from === "string" ? args.from.trim().toLowerCase() : "";
  const sent = db.select({ conversationId: chatMessages.conversationId, content: chatMessages.content, createdAt: chatMessages.createdAt, title: conversations.title })
    .from(chatMessages)
    .innerJoin(conversations, eq(conversations.id, chatMessages.conversationId))
    // substr, not LIKE: the agent's name is matched exactly, with no wildcards to escape.
    .where(and(eq(chatMessages.role, "user"), sql`substr(${chatMessages.content}, 1, ${prefix.length}) = ${prefix}`))
    .orderBy(desc(chatMessages.createdAt))
    .all();

  const latest = new Map<string, { title: string; from: string; sentAt: string }>();
  for (const row of sent) {
    const end = row.content.indexOf(LABEL_END);
    const from = end > prefix.length ? row.content.slice(prefix.length, end) : "";
    if (latest.has(row.conversationId) || (filter && !from.toLowerCase().includes(filter))) continue;
    latest.set(row.conversationId, { title: row.title ?? "Untitled", from, sentAt: row.createdAt });
  }
  if (latest.size === 0) return text(filter ? `None of your chats had a message from a session matching "${args.from}".` : "You have not started or messaged any chat yet.");

  const chats = [...latest].slice(0, MY_CHATS_LIMIT).map(([id, chat]) => ({ conversationId: id, ...chat, ticket: `${id}@${chat.sentAt}`, status: stillWorking(id) ? "working" : "answered" }));
  const lines = chats.map((c) => `- ${chatLabel(c.conversationId, c.title, origin)}: last message ${c.sentAt} from "${c.from}", ${c.status}, reply ticket ${c.ticket}`);
  const more = latest.size > chats.length ? `\n(${latest.size - chats.length} older not shown)` : "";
  return { ...text(`${lines.join("\n")}${more}`), structuredContent: { chats } };
}

async function callOwnTool(name: string, args: Record<string, unknown>, agent: string, origin: string) {
  if (name === "get_reply") return getReply(args, origin);
  if (name === "my_chats") return myChats(args, agent, origin);
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) return text("message is empty.", true);
  if (message.length > MAX_MESSAGE) return text(`message is longer than ${MAX_MESSAGE} characters.`, true);
  const from = typeof args.from === "string" ? args.from.replace(/\s+/g, " ").trim().slice(0, MAX_FROM) : "";
  if (!from) return text("from is missing: say which session you are, e.g. your working folder and task in a few words.", true);
  const content = `**From ${agent} (${from}), outside Chomp:** ${message}`;
  const wait = args.wait === true;

  if (name === "message_chat") {
    const target = findChat(String(args.conversationId ?? ""));
    if (!target) return text(`No chat with id ${args.conversationId}. Find ids with list_conversations.`, true);
    if (!underCap(target.id)) return text(`"${target.title ?? "Untitled"}" already got 5 agent messages in the last 10 minutes. Wait, or tell the user.`, true);
    const access = lastTurnOptions(target.id)?.access as AccessMode | undefined;
    return await deliver(target.id, chatLabel(target.id, target.title ?? "Untitled", origin), content, access ? { access } : {}, wait);
  }

  const projects = listProjects();
  const project = typeof args.project === "string" && args.project ? projects.find((p) => p.name === args.project || p.path === args.project) : undefined;
  if (args.project && !project) return text(`No project "${args.project}". Projects: ${projects.map((p) => p.name).join(", ")}.`, true);
  const id = randomUUID();
  const now = new Date().toISOString();
  // Tagged with the agent's name, so the user can see in the sidebar which chats came from outside, and filter them.
  db.insert(conversations).values({ id, tags: JSON.stringify([agent.toLowerCase()]), createdAt: now, updatedAt: now }).run();
  return await deliver(id, chatLabel(id, placeholderTitle(message), origin), content, project ? { projectPath: project.path } : {}, wait);
}

/**
 * Chomp's web address as this caller reaches it. shortcut: outside agents only come in through Tailscale's HTTPS
 * (tailscale serve), so anything but a local caller gets https; read a configured URL if another entrance appears.
 */
function chatOrigin(req: Request): string {
  const host = req.headers.host ?? "localhost";
  return `${/^(localhost|127\.)/.test(host) ? "http" : "https"}://${host}`;
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: Record<string, unknown> };

const router: ReturnType<typeof Router> = Router();

router.post("/", async (req: Request, res: Response) => {
  const agent = outsideAgent(req.headers.authorization);
  if (!agent) {
    res.status(401).json({ error: "A valid outside-agent token is required" });
    return;
  }
  const rpc = (req.body ?? {}) as Rpc;
  if (typeof rpc.method !== "string") {
    res.status(400).json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32600, message: "Invalid request" } });
    return;
  }
  // Notifications (no id) need no answer.
  if (rpc.id === undefined) {
    res.status(202).end();
    return;
  }
  const reply = (result: unknown) => res.json({ jsonrpc: "2.0", id: rpc.id, result });
  const params = rpc.params ?? {};

  switch (rpc.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "chomp", version: "0.1.0" },
        instructions: "Chomp is the user's personal assistant, running on their home server. Read their chats and memories, and talk to the agents in their chats.",
      });
      return;
    }
    case "ping":
      reply({});
      return;
    case "tools/list":
      reply({ tools: listTools() });
      return;
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        if (OWN_TOOLS.some((tool) => tool.name === name)) reply(await callOwnTool(name, args, agent, chatOrigin(req)));
        else if (SHARED.has(name)) reply(await callMcpTool(name, args));
        else reply(text(`Unknown tool: ${name}`, true));
      } catch (err) {
        reply(text(err instanceof Error ? err.message : "The tool failed", true));
      }
      return;
    }
    default:
      res.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `Method not found: ${rpc.method}` } });
  }
});

export default router;
