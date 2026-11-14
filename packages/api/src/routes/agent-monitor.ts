import { Router } from "express";
import { getActiveSessions, getSessionHistory, killSession, killAllSessions } from "../agents/registry.js";

const router: ReturnType<typeof Router> = Router();

/** GET /api/agent-monitor/active — list active agent sessions */
router.get("/active", (_req, res) => {
  const sessions = getActiveSessions().map((s) => ({
    sessionId: s.sessionId,
    ccSessionId: s.ccSessionId,
    agentName: s.agentName,
    agentType: s.agentType,
    conversationId: s.conversationId,
    pid: s.pid,
    prompt: s.prompt,
    userPrompt: s.userPrompt,
    label: s.label,
    model: s.model,
    lastActivity: s.lastActivity,
    startedAt: new Date(s.startedAt).toISOString(),
    runtimeSeconds: Math.round((Date.now() - s.startedAt) / 1000),
    outputBytes: s.outputBytes,
    outputChunks: s.outputChunks,
    lastOutputSecondsAgo: Math.round((Date.now() - s.lastOutputAt) / 1000),
  }));

  res.json({ sessions, count: sessions.length });
});

/** GET /api/agent-monitor/history — paginated agent session history */
router.get("/history", (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const offset = (page - 1) * limit;
  const search = (req.query.search as string) || undefined;
  const status = (req.query.status as string) || undefined;
  const agent = (req.query.agent as string) || undefined;

  const { rows, total } = getSessionHistory({ limit, offset, search, status, agent });
  const totalPages = Math.ceil(total / limit);

  res.json({
    history: rows,
    total,
    page,
    limit,
    totalPages,
  });
});

/** POST /api/agent-monitor/kill/:sessionId — kill a specific agent session */
router.post("/kill/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const killed = killSession(sessionId);
  if (killed) {
    res.json({ success: true, message: `Session ${sessionId} killed` });
  } else {
    res.status(404).json({ error: `Session ${sessionId} not found or already completed` });
  }
});

/** POST /api/agent-monitor/kill-all — emergency kill all running agents */
router.post("/kill-all", (_req, res) => {
  const killed = killAllSessions();
  res.json({ success: true, killed });
});

export default router;
