import type { ApprovalDecision } from "@chomp/shared";
import { offerToPhones, withdrawFromPhones } from "../../notifications/phone-requests.js";
import type { TurnRequest } from "./types.js";

export type ApprovalOutcome = ApprovalDecision | "expired";

/** An approval a tool asks for itself, whatever the turn's access level. */
export interface ApprovalQuestion {
  title: string;
  detail: string;
  /** What the lock screen shows. */
  summary: string;
  /** No lock screen buttons: the summary could not show what would be approved. */
  readFirst?: boolean;
}

/** A turn waiting on an approval holds its conversation's queue, so the wait has an end. */
export const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Wait for the user to answer an approval that is on the timeline, and offer
 * it to their phones. Only a turn from web chat outlives a phone that cannot
 * be reached: the web client may come back. Anywhere else nobody can answer,
 * so the request expires at once. A one-off run has no conversation for
 * `answerApproval` to find it by.
 */
export function waitForApproval(
  request: TurnRequest,
  requestId: string,
  summary: string,
  register: (resolve: (outcome: ApprovalOutcome) => void) => void,
  { readFirst = false }: { readFirst?: boolean } = {},
): Promise<ApprovalOutcome> {
  let timer: NodeJS.Timeout;
  const outcome = new Promise<ApprovalOutcome>((resolve) => {
    register(resolve);
    timer = setTimeout(() => resolve("expired"), APPROVAL_TIMEOUT_MS);
    timer.unref();
    if (!request.conversationId) return resolve("expired");
    const webChat = request.deliveryChannel === "web-chat";
    void offerToPhones({
      id: requestId,
      category: readFirst ? "CHOMP_READ_FIRST" : "CHOMP_APPROVAL",
      title: `${request.agentName} needs approval`,
      body: summary,
      answerWith: { kind: "approval", conversationId: request.conversationId, requestId },
      expiresInMs: APPROVAL_TIMEOUT_MS,
    }, { webFirst: webChat }).then((failure) => {
      if (failure && !webChat) resolve("expired");
    });
  });
  return outcome.finally(() => {
    clearTimeout(timer);
    withdrawFromPhones(requestId);
  });
}
