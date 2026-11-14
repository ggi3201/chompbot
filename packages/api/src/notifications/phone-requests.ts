import { pushToPhones } from "../agents/tools/phone-cards.js";
import { sendAlertPush, sendSilentPush } from "../lib/apns.js";
import { hasActiveWebConnection } from "./web-connections.js";

/** Someone at an open web client gets this long to answer before their phone buzzes too. */
const WEB_FIRST_MS = 30_000;
export const BODY_MAX = 180;
/** A withdrawal that arrives after this is pointless: the notification's request has long ended. */
const WITHDRAWAL_TTL_MS = 10 * 60 * 1000;

export interface PhoneRequest {
  /** The approval's request id or the question's id. */
  id: string;
  /** Decides which buttons the notification shows. The app registers none for `CHOMP_READ_FIRST`, so a tap opens it. */
  category: "CHOMP_APPROVAL" | "CHOMP_QUESTION" | "CHOMP_READ_FIRST";
  title: string;
  /** Shown on the lock screen, so it must never hold command arguments, paths or secrets. A message the user is asked to send is the exception. */
  body: string;
  /** What the app sends back to `POST /api/agent-requests`. */
  answerWith: { kind: "approval"; conversationId: string; requestId: string } | { kind: "question"; sessionId: string; questionId: string };
  expiresInMs: number;
}

/** What is out with the phones or about to be: null once pushed, the timer while the web goes first. */
const offers = new Map<string, NodeJS.Timeout | null>();

const epochSeconds = (ms: number) => Math.floor(ms / 1000);

async function deliver(request: PhoneRequest): Promise<string | null> {
  const { id, category, title, body, answerWith, expiresInMs } = request;
  offers.set(id, null);
  const failure = await pushToPhones((phone) => sendAlertPush({
    ...phone,
    title,
    body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 1)}…` : body,
    category,
    collapseId: id,
    expiresAt: epochSeconds(Date.now() + expiresInMs),
    data: { chomp: { id, ...answerWith } },
  })).catch((err: Error) => err.message);
  if (failure) {
    offers.delete(id);
    console.warn(`[phone-requests] ${category} did not reach a phone: ${failure}`);
  }
  return failure;
}

/**
 * Ask the phones. Resolves with why none was reached, or null when one was or
 * will be. With `webFirst` and a web client open, the push waits a moment and
 * a failure from then on is only logged: the web client can still answer.
 */
export async function offerToPhones(request: PhoneRequest, { webFirst }: { webFirst: boolean }): Promise<string | null> {
  if (!webFirst || !hasActiveWebConnection()) return deliver(request);
  const timer = setTimeout(() => void deliver(request), WEB_FIRST_MS);
  timer.unref();
  offers.set(request.id, timer);
  return null;
}

/** The request ended elsewhere: take the notification off the phones. */
export function withdrawFromPhones(id: string) {
  const offer = offers.get(id);
  if (offer === undefined) return;
  offers.delete(id);
  if (offer) {
    clearTimeout(offer);
    return;
  }
  void pushToPhones((phone) => sendSilentPush({
    ...phone,
    expiresAt: epochSeconds(Date.now() + WITHDRAWAL_TTL_MS),
    data: { chomp: { withdrawn: id } },
  })).then((failure) => {
    if (failure) console.warn(`[phone-requests] withdrawal did not reach a phone: ${failure}`);
  });
}

/** The phone answered and iOS already removed the notification. Silent pushes are rationed, so none is spent on it. */
export function forgetPhoneOffer(id: string) {
  const offer = offers.get(id);
  if (offer) clearTimeout(offer);
  offers.delete(id);
}
