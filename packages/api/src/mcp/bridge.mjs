#!/usr/bin/env node
// Chomp MCP stdio bridge — zero-dependency, speaks MCP JSON-RPC over stdin/stdout.
// Claude Code spawns this as an MCP server subprocess.
// It translates tool calls into HTTP requests against the Chomp REST API.

import { createInterface } from "readline";
import http from "http";
import fs from "fs";

const CHOMP_PORT = process.env.CHOMP_PORT || "3001";
const CHOMP_HOST = process.env.CHOMP_HOST || "127.0.0.1";
const SESSION_ID = process.env.CHOMP_SESSION_ID || "";
const CC_SESSION_ID = process.env.CHOMP_CC_SESSION_ID || "";
const MCP_SECRET = process.env.CHOMP_MCP_SECRET || "";

/**
 * Get session ID for the current request.
 * Priority:
 *   1. Per-cc-session pointer file (lingering PTY case — claude-runner rewrites
 *      this before each bracket-paste). MUST take precedence over env vars
 *      because the env is baked at PTY spawn time and is stale for turns ≥2 of
 *      a reused PTY. Without this, turn-N replies route to turn-1's session.
 *   2. env var CHOMP_SESSION_ID (set by Claude Code at spawn for the first
 *      turn — and the only signal pipe-mode runs have).
 *   3. temp file keyed by Codex ancestor PID (set by codex-runner). Codex
 *      doesn't inherit parent env to MCP servers, so codex-runner writes a
 *      temp file at /tmp/chomp-mcp-session-{codexPid}. The bridge's ppid
 *      should be the Codex process. If a shell wrapper sits between Codex
 *      and this bridge, walk the process parent chain and look for an
 *      ancestor's session file. Never fall back to the newest session file:
 *      overlapping Codex chats can otherwise route replies into the wrong
 *      conversation.
 */
function getSessionId() {
  if (CC_SESSION_ID) {
    try {
      const pointed = fs.readFileSync(`/tmp/chomp-pty-current-session-${CC_SESSION_ID}`, "utf-8").trim();
      if (pointed) return pointed;
    } catch {}
  }
  if (SESSION_ID) return SESSION_ID;
  for (const pid of getAncestorPids(process.ppid)) {
    try {
      const session = fs.readFileSync(`/tmp/chomp-mcp-session-${pid}`, "utf-8").trim();
      if (session) return session;
    } catch {}
  }
  return "";
}

function getAncestorPids(startPid) {
  const pids = [];
  const seen = new Set();
  let pid = Number(startPid);
  for (let depth = 0; Number.isFinite(pid) && pid > 1 && depth < 12 && !seen.has(pid); depth++) {
    pids.push(pid);
    seen.add(pid);
    const parent = getParentPid(pid);
    if (!parent) break;
    pid = parent;
  }
  return pids;
}

function getParentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const endOfComm = stat.lastIndexOf(") ");
    if (endOfComm === -1) return null;
    const fields = stat.slice(endOfComm + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

// Fallback tools if the API is unavailable during init
const FALLBACK_TOOLS = [
  {
    name: "reply",
    description:
      "Send a message to the Chomp chat UI without expecting a response. Use for progress updates or interim results.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to display in the chat" },
      },
      required: ["message"],
    },
  },
  {
    name: "ask_user",
    description: "Ask the user a question via Chomp chat UI and wait for their response.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask the user" },
      },
      required: ["question"],
    },
  },
  {
    name: "save_memory",
    description: "Save information to Chomp persistent memory (survives across sessions).",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The content to remember" },
        category: {
          type: "string",
          enum: ["preferences", "project-context", "facts", "instructions"],
          description: "Category for the memory",
        },
      },
      required: ["content", "category"],
    },
  },
  {
    name: "recall_memories",
    description: "Search previously saved Chomp memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for" },
        category: {
          type: "string",
          enum: ["preferences", "project-context", "facts", "instructions"],
        },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "read_user_profile",
    description: "Read the user's full user.md profile on demand.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_google_token",
    description:
      "Get a fresh Google OAuth2 access token. Returns null if Google is not connected.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Cached tools fetched from the API on init */
let cachedTools = null;

/** Fetch the full tool list from the Chomp API (GET /mcp/tools/list) */
function fetchTools() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: CHOMP_HOST,
        port: parseInt(CHOMP_PORT, 10),
        path: "/mcp/tools/list",
        method: "GET",
        timeout: 3000,
        headers: {
          ...(MCP_SECRET ? { "X-Chomp-MCP-Secret": MCP_SECRET } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.tools ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

function callChompApi(toolName, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: toolName, arguments: args });
    const sessionId = getSessionId();

    const req = http.request(
      {
        hostname: CHOMP_HOST,
        port: parseInt(CHOMP_PORT, 10),
        path: "/mcp/tools/call",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Chomp-Session-Id": sessionId,
          ...(MCP_SECRET ? { "X-Chomp-MCP-Secret": MCP_SECRET } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ content: [{ type: "text", text: data }] });
          }
        });
      },
    );

    req.on("error", (err) => {
      resolve({
        content: [{ type: "text", text: `Connection error: ${err.message}` }],
        isError: true,
      });
    });

    req.write(body);
    req.end();
  });
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return; // Ignore malformed input
  }

  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      // Fetch tools from the API on init (fall back to hardcoded list)
      cachedTools = await fetchTools();
      if (cachedTools) {
        process.stderr.write(
          `[chomp-mcp] Loaded ${cachedTools.length} tools from API\n`,
        );
      } else {
        process.stderr.write(
          `[chomp-mcp] API unreachable, using ${FALLBACK_TOOLS.length} fallback tools\n`,
        );
      }

      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "chomp-api", version: "0.2.0" },
        },
      });
      break;

    case "notifications/initialized":
      // Client acknowledges init — no response needed
      break;

    case "tools/list":
      send({
        jsonrpc: "2.0",
        id,
        result: { tools: cachedTools ?? FALLBACK_TOOLS },
      });
      break;

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      // Forward the tool name directly to the API — server handles normalization
      const result = await callChompApi(toolName, args);
      send({ jsonrpc: "2.0", id, result });
      break;
    }

    default:
      // Return method not found for unknown methods
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
  }
});

rl.on("close", () => process.exit(0));
