/**
 * Gmail tools — search, read, and draft emails via the Gmail API.
 */

import { googleFetch } from "./google-common.js";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_BODY_SIZE = 8 * 1024; // 8KB

// ── Search Email ────────────────────────────────────────────────

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessageMeta {
  id: string;
  payload: { headers: GmailHeader[] };
  snippet: string;
  internalDate: string;
}

// A type, not an interface, so it passes as JsonValue in gate results.
export type EmailSummary = {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
};

/** Structured Gmail search, newest first. Throws when Gmail answers with an error. */
export async function searchEmailMessages(query: string, maxResults?: number): Promise<EmailSummary[]> {
  const max = Math.min(maxResults ?? 10, 10);
  const params = new URLSearchParams({ q: query, maxResults: String(max) });

  const listRes = await googleFetch(`${GMAIL_BASE}/messages?${params}`);
  if (!listRes.ok) {
    const err = await listRes.text().catch(() => "");
    throw new Error(`Gmail search failed (${listRes.status}): ${err.slice(0, 200)}`);
  }

  const listData = await listRes.json() as { messages?: GmailMessageRef[] };
  if (!listData.messages || listData.messages.length === 0) return [];

  // Fetch metadata in parallel
  const details = await Promise.all(
    listData.messages.slice(0, max).map(async (msg) => {
      const res = await googleFetch(`${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
      if (!res.ok) return null;
      return res.json() as Promise<GmailMessageMeta>;
    })
  );

  return details
    .filter((d): d is GmailMessageMeta => d !== null)
    .map((d) => {
      const headers = Object.fromEntries(d.payload.headers.map((h) => [h.name, h.value]));
      return {
        id: d.id,
        subject: headers["Subject"] ?? "(no subject)",
        from: headers["From"] ?? "unknown",
        date: headers["Date"] ?? new Date(Number(d.internalDate)).toLocaleString(),
        snippet: d.snippet,
      };
    });
}

export async function execSearchEmail(query: string, maxResults?: number): Promise<string> {
  let messages: EmailSummary[];
  try {
    messages = await searchEmailMessages(query, maxResults);
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (messages.length === 0) return `No emails found for "${query}".`;
  return messages
    .map((m) => `ID: ${m.id}\n  Subject: ${m.subject}\n  From: ${m.from}\n  Date: ${m.date}\n  Snippet: ${m.snippet}`)
    .join("\n\n");
}

// ── Read Email ──────────────────────────────────────────────────

interface GmailPart {
  mimeType: string;
  body: { data?: string; size: number };
  parts?: GmailPart[];
}

interface GmailFullMessage {
  id: string;
  payload: GmailPart & { headers: GmailHeader[] };
  snippet: string;
}

function extractBody(part: GmailPart, preferredType: string, depth = 0): string | null {
  if (depth > 2) return null;

  if (part.mimeType === preferredType && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }

  if (part.parts) {
    for (const sub of part.parts) {
      const result = extractBody(sub, preferredType, depth + 1);
      if (result) return result;
    }
  }

  return null;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function execReadEmail(messageId: string): Promise<string> {
  const res = await googleFetch(`${GMAIL_BASE}/messages/${messageId}?format=full`);
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return `ERROR: Failed to read email (${res.status}): ${err.slice(0, 200)}`;
  }

  const msg = await res.json() as GmailFullMessage;
  const headers = Object.fromEntries(msg.payload.headers.map((h) => [h.name, h.value]));

  // Try text/plain first, fall back to text/html with tag stripping
  let body = extractBody(msg.payload, "text/plain");
  if (!body) {
    const html = extractBody(msg.payload, "text/html");
    body = html ? stripHtmlTags(html) : msg.snippet;
  }

  if (body && body.length > MAX_BODY_SIZE) {
    body = body.slice(0, MAX_BODY_SIZE) + "\n... (truncated)";
  }

  return [
    `Subject: ${headers["Subject"] ?? "(no subject)"}`,
    `From: ${headers["From"] ?? "unknown"}`,
    `To: ${headers["To"] ?? "unknown"}`,
    `Date: ${headers["Date"] ?? "unknown"}`,
    ``,
    body || "(empty body)",
  ].join("\n");
}

// ── Mark Emails as Read ─────────────────────────────────────────

export async function execMarkEmailsRead(query?: string): Promise<string> {
  const searchQuery = query ?? "is:unread";
  const allIds: string[] = [];
  let pageToken: string | undefined;

  // Collect all matching message IDs (paginate up to 500 per request)
  do {
    const params = new URLSearchParams({ q: searchQuery, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);

    const listRes = await googleFetch(`${GMAIL_BASE}/messages?${params}`);
    if (!listRes.ok) {
      const err = await listRes.text().catch(() => "");
      return `ERROR: Gmail search failed (${listRes.status}): ${err.slice(0, 200)}`;
    }

    const listData = await listRes.json() as { messages?: GmailMessageRef[]; nextPageToken?: string };
    if (listData.messages) {
      allIds.push(...listData.messages.map((m) => m.id));
    }
    pageToken = listData.nextPageToken;
  } while (pageToken);

  if (allIds.length === 0) {
    return `No unread emails found${query ? ` matching "${query}"` : ""}.`;
  }

  // batchModify removes UNREAD label in one request (max 1000 IDs per call)
  const BATCH_SIZE = 1000;
  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE);
    const res = await googleFetch(`${GMAIL_BASE}/messages/batchModify`, {
      method: "POST",
      body: JSON.stringify({ ids: batch, removeLabelIds: ["UNREAD"] }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return `ERROR: batchModify failed (${res.status}): ${err.slice(0, 200)}`;
    }
  }

  return `Marked ${allIds.length} email${allIds.length === 1 ? "" : "s"} as read.`;
}

// ── Mark Emails as Unread ───────────────────────────────────────

export async function execMarkEmailsUnread(query?: string): Promise<string> {
  const searchQuery = query ?? "in:inbox";
  const allIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ q: searchQuery, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);

    const listRes = await googleFetch(`${GMAIL_BASE}/messages?${params}`);
    if (!listRes.ok) {
      const err = await listRes.text().catch(() => "");
      return `ERROR: Gmail search failed (${listRes.status}): ${err.slice(0, 200)}`;
    }

    const listData = await listRes.json() as { messages?: GmailMessageRef[]; nextPageToken?: string };
    if (listData.messages) {
      allIds.push(...listData.messages.map((m) => m.id));
    }
    pageToken = listData.nextPageToken;
  } while (pageToken);

  if (allIds.length === 0) {
    return `No emails found${query ? ` matching "${query}"` : ""}.`;
  }

  const BATCH_SIZE = 1000;
  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE);
    const res = await googleFetch(`${GMAIL_BASE}/messages/batchModify`, {
      method: "POST",
      body: JSON.stringify({ ids: batch, addLabelIds: ["UNREAD"] }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return `ERROR: batchModify failed (${res.status}): ${err.slice(0, 200)}`;
    }
  }

  return `Marked ${allIds.length} email${allIds.length === 1 ? "" : "s"} as unread.`;
}

// ── Draft Email ─────────────────────────────────────────────────

export async function execDraftEmail(to: string, subject: string, body: string, cc?: string): Promise<string> {
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    body,
  ].filter(Boolean).join("\r\n");

  const encoded = Buffer.from(lines).toString("base64url");

  const res = await googleFetch(`${GMAIL_BASE}/drafts`, {
    method: "POST",
    body: JSON.stringify({ message: { raw: encoded } }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return `ERROR: Failed to create draft (${res.status}): ${err.slice(0, 200)}`;
  }

  const draft = await res.json() as { id: string; message: { id: string } };
  return `Draft created (ID: ${draft.id}). Open Gmail to review and send.`;
}
