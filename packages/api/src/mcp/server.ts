import { Router } from "express";
import { callMcpTool, getMcpTool, listMcpTools, normalizeToolName } from "./registry.js";
import { hasSessionReplied } from "./state.js";

// Re-export state for backwards compatibility (dispatch.ts, websocket.ts, telegram/handlers.ts)
export {
  registerSessionConversation,
  getSessionConversationId,
  onAskUser,
  onReply,
} from "./state.js";

const router: ReturnType<typeof Router> = Router();

// GET /mcp/tools/list — for bridge.mjs dynamic fetch (returns bare array)
router.get("/tools/list", (_req, res) => {
  res.json({ tools: listMcpTools() });
});

// POST /mcp/tools/list — legacy MCP protocol endpoint
router.post("/tools/list", (_req, res) => {
  res.json({ tools: listMcpTools() });
});

// POST /mcp/tools/call — call a tool
router.post("/tools/call", async (req, res) => {
  const { name: rawName, arguments: args } = req.body;
  const sessionId = req.headers["x-chomp-session-id"] as string | undefined;
  const name = normalizeToolName(rawName);

  const def = getMcpTool(name);
  if (!def) {
    res.status(404).json({
      content: [{ type: "text", text: `Unknown tool: ${rawName}` }],
      isError: true,
    });
    return;
  }

  // Only require sessionId for session-bound tools
  if (def.requiresSession && !sessionId) {
    res.status(400).json({
      content: [{ type: "text", text: "Missing X-Chomp-Session-Id header (required for this tool)" }],
      isError: true,
    });
    return;
  }

  res.json(await callMcpTool(name, args ?? {}, sessionId));
});

// GET /mcp/sessions/:sessionId/replied — used by Claude PTY Stop hooks.
router.get("/sessions/:sessionId/replied", (req, res) => {
  res.json({ replied: hasSessionReplied(req.params.sessionId) });
});

export default router;
