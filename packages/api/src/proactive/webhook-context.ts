/**
 * In-memory store for recent webhook payloads.
 * Agents dispatched in response to a webhook can call get_webhook_payload
 * via the MCP tool to retrieve the triggering body.
 */

export interface WebhookPayloadEntry {
  webhookId: string;
  webhookName: string;
  payload: unknown;
  receivedAt: string;
}

/** Keyed by webhookId — stores the most recent payload per webhook */
const recentPayloads = new Map<string, WebhookPayloadEntry>();

/** The globally most recent webhook payload received */
let lastPayload: WebhookPayloadEntry | null = null;

/** Record a webhook payload when it arrives */
export function storeWebhookPayload(webhookId: string, webhookName: string, payload: unknown): void {
  const entry: WebhookPayloadEntry = {
    webhookId,
    webhookName,
    payload,
    receivedAt: new Date().toISOString(),
  };
  recentPayloads.set(webhookId, entry);
  lastPayload = entry;
}

/**
 * Retrieve a webhook payload.
 * If webhookId is provided, returns the last payload for that webhook.
 * Otherwise returns the globally most-recent payload.
 */
export function getWebhookPayload(webhookId?: string): WebhookPayloadEntry | null {
  if (webhookId) {
    return recentPayloads.get(webhookId) ?? null;
  }
  return lastPayload;
}
