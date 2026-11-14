/**
 * Answers to what a running agent asked, for a client with no WebSocket: the
 * iOS app answers from a lock screen notification while it runs in the
 * background. 409 means the request has ended, so the answer did nothing.
 */
import { Router, type Request, type Response } from "express";
import { APPROVAL_DECISIONS, type ApprovalDecision } from "@chomp/shared";
import { answerApproval } from "../agents/runtime/pool.js";
import { answerPendingQuestion } from "../mcp/pending-questions.js";
import { forgetPhoneOffer } from "../notifications/phone-requests.js";

const router: ReturnType<typeof Router> = Router();

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function respond(res: Response, answered: boolean) {
  if (answered) res.json({ ok: true });
  else res.status(409).json({ error: "This request has ended" });
}

router.post("/approval", (req: Request, res: Response) => {
  const { conversationId, requestId, decision } = req.body ?? {};
  if (!isId(conversationId) || !isId(requestId) || !APPROVAL_DECISIONS.includes(decision)) {
    res.status(400).json({ error: "conversationId, requestId and a valid decision required" });
    return;
  }
  forgetPhoneOffer(requestId);
  respond(res, answerApproval(conversationId, requestId, decision as ApprovalDecision));
});

router.post("/question", (req: Request, res: Response) => {
  const { sessionId, questionId, answer } = req.body ?? {};
  if (!isId(sessionId) || !isId(questionId) || !isId(answer)) {
    res.status(400).json({ error: "sessionId, questionId and answer required" });
    return;
  }
  forgetPhoneOffer(questionId);
  respond(res, answerPendingQuestion(sessionId, answer, questionId));
});

export default router;
