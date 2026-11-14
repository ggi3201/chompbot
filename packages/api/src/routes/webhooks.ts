import { Router, type Request, type Response } from "express";
import type { IncomingMessage } from "http";
import { db } from "../db/index.js";
import { webhooks } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { emit } from "../events/bus.js";
import { authMiddleware, hasValidToken } from "../auth/middleware.js";
import { PHONE_CALENDAR_WEBHOOK, savePhoneCalendar } from "../lib/phone-calendar.js";
import { storeWebhookPayload } from "../proactive/webhook-context.js";

const router: ReturnType<typeof Router> = Router();

type Delivery = IncomingMessage & { rawBody?: Buffer };

/** For express.json's `verify`: keeps a delivery's exact bytes, because the sender signed those and not our re-serialised JSON. */
export function keepRawBody(req: Delivery, _res: unknown, buf: Buffer): void {
  if (req.url?.startsWith("/api/webhooks/receive/")) req.rawBody = buf;
}

function safeEqual(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

// shortcut: the iPhone Shortcut sends no proof yet, so its webhook still takes bare requests; empty this once it sends x-webhook-secret.
const UNSIGNED_ALLOWED = new Set([PHONE_CALENDAR_WEBHOOK]);

/**
 * A caller proves it knows the webhook's secret with an HMAC of the raw body, or with the secret itself
 * in x-webhook-secret when it cannot compute one (an iPhone Shortcut). The web UI's Test button is logged in instead.
 */
function isTrusted(req: Request, webhook: { name: string; secret: string }): boolean {
  const signature = req.header("x-hub-signature-256") ?? req.header("x-webhook-signature");
  if (signature) {
    const body = (req as Delivery).rawBody ?? "";
    return safeEqual(signature, "sha256=" + createHmac("sha256", webhook.secret).update(body).digest("hex"));
  }
  const secret = req.header("x-webhook-secret");
  if (secret) return safeEqual(secret, webhook.secret);
  if (hasValidToken(req)) return true;
  console.warn(`[webhooks] unsigned request to "${webhook.name}"`);
  return UNSIGNED_ALLOWED.has(webhook.name);
}

// ── Public endpoint: receive webhook (no auth) ──────────────────

router.post("/receive/:id", (req: Request, res: Response) => {
  const webhook = db.select().from(webhooks).where(eq(webhooks.id, req.params.id as string)).get();
  if (!webhook || !webhook.enabled) {
    res.status(404).json({ error: "Webhook not found" });
    return;
  }

  if (!isTrusted(req, webhook)) {
    res.status(401).json({ error: "Missing or invalid signature" });
    return;
  }

  // Update stats
  db.update(webhooks).set({
    lastReceivedAt: new Date().toISOString(),
    receiveCount: webhook.receiveCount + 1,
    updatedAt: new Date().toISOString(),
  }).where(eq(webhooks.id, webhook.id)).run();

  // Capture useful headers for condition matching (e.g. X-GitHub-Event)
  const forwardHeaders: Record<string, string> = {};
  const headerKeys = [
    "x-github-event", "x-github-delivery", "x-github-hook-id",
    "x-gitlab-event", "x-linear-event", "x-stripe-event",
    "x-vercel-signature", "x-slack-signature",
    "content-type", "user-agent",
  ];
  for (const key of headerKeys) {
    const val = req.headers[key];
    if (typeof val === "string") forwardHeaders[key] = val;
  }

  // Persist the payload BEFORE emitting, so it is readable by whatever the
  // event wakes up.
  //
  // This used to live in proactive/engine.ts, which meant only the proactive
  // path stored anything. An agent delegated by an *event trigger* would call
  // get_webhook_payload and get nothing back — the tool was fine, it was
  // reading a store that path never wrote to. Storing on receipt makes it
  // unconditional rather than a side effect of one particular consumer.
  storeWebhookPayload(webhook.id, webhook.name, req.body);
  if (webhook.name === PHONE_CALENDAR_WEBHOOK) savePhoneCalendar(req.body);

  // Fire event on bus
  emit({
    type: "webhook.received",
    webhookId: webhook.id,
    webhookName: webhook.name,
    payload: req.body,
    headers: forwardHeaders,
  });

  res.json({ status: "ok" });
});

// ── Protected CRUD endpoints ────────────────────────────────────

router.use(authMiddleware);

router.get("/", (_req: Request, res: Response) => {
  const result = db.select().from(webhooks).all();
  res.json(result);
});

router.get("/:id", (req: Request, res: Response) => {
  const result = db.select().from(webhooks).where(eq(webhooks.id, req.params.id as string)).get();
  if (!result) {
    res.status(404).json({ error: "Webhook not found" });
    return;
  }
  res.json(result);
});

router.post("/", (req: Request, res: Response) => {
  const { name, description, eventType } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const id = randomUUID();
  const secret = randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();

  db.insert(webhooks).values({
    id,
    name,
    description: description ?? "",
    secret,
    eventType: eventType ?? "webhook.received",
    enabled: true,
    receiveCount: 0,
    createdAt: now,
    updatedAt: now,
  }).run();

  const created = db.select().from(webhooks).where(eq(webhooks.id, id)).get()!;
  res.status(201).json(created);
});

router.put("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(webhooks).where(eq(webhooks.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Webhook not found" });
    return;
  }

  const { name, description, eventType, enabled } = req.body;
  db.update(webhooks).set({
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(eventType !== undefined && { eventType }),
    ...(enabled !== undefined && { enabled }),
    updatedAt: new Date().toISOString(),
  }).where(eq(webhooks.id, req.params.id as string)).run();

  const updated = db.select().from(webhooks).where(eq(webhooks.id, req.params.id as string)).get()!;
  res.json(updated);
});

router.delete("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(webhooks).where(eq(webhooks.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Webhook not found" });
    return;
  }
  db.delete(webhooks).where(eq(webhooks.id, req.params.id as string)).run();
  res.status(204).send();
});

export default router;
