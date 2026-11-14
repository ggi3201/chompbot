import { askForApproval } from "../runtime/pool.js";
import { getSecret } from "../../lib/secrets.js";
import { BODY_MAX } from "../../notifications/phone-requests.js";

const MAC_TIMEOUT_MS = 30_000;

type Resolved = { chatId: number; name: string; identifier: string } | { candidates: string[] } | { error: string };

function macConfig() {
  const url = getSecret("IMESSAGE_MAC_URL") ?? process.env.IMESSAGE_MAC_URL;
  const token = getSecret("IMESSAGE_SEND_TOKEN") ?? process.env.IMESSAGE_SEND_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function callMac<T>(path: string, body: unknown, { url, token }: { url: string; token: string }): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MAC_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({ error: `The Mac answered ${res.status}` })) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `The Mac answered ${res.status}`);
  return data;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function execSendImessage(args: { chat?: unknown; text?: unknown }, conversationId: string | undefined): Promise<string> {
  const { chat, text } = args;
  if (typeof chat !== "string" || !chat.trim()) return "ERROR: chat required";
  if (typeof text !== "string" || !text.trim()) return "ERROR: text required";
  if (!conversationId) return "ERROR: Nothing was sent. This run has no chat the user could approve it in.";
  const mac = macConfig();
  if (!mac) return "ERROR: Nothing was sent. IMESSAGE_MAC_URL and IMESSAGE_SEND_TOKEN are not set in Chomp's settings.";

  let resolved: Resolved;
  try {
    resolved = await callMac<Resolved>("/resolve", { chat }, mac);
  } catch (err) {
    return `ERROR: Nothing was sent. Could not reach the user's Mac, which may be asleep: ${reason(err)}`;
  }
  if ("error" in resolved) return `ERROR: Nothing was sent. ${resolved.error}`;
  if ("candidates" in resolved) return `Nothing was sent. "${chat}" matches several chats. Ask the user which one, then call again with its id:\n${resolved.candidates.join("\n")}`;

  const recipient = resolved.name === resolved.identifier ? resolved.name : `${resolved.name} (${resolved.identifier})`;
  const summary = `Send to ${resolved.name}: "${text}"`;
  const fits = summary.length <= BODY_MAX;
  const outcome = await askForApproval(conversationId, {
    title: `Send to ${recipient}`,
    detail: text,
    summary: fits ? summary : `Send a long message to ${resolved.name}. Open Chomp to read it first.`,
    readFirst: !fits,
  });
  if (outcome === "decline") return "Nothing was sent: the user declined.";
  if (outcome === "expired") return "Nothing was sent: nobody approved in time, or the user could not be reached.";

  try {
    await callMac("/send", { chatId: resolved.chatId, text }, mac);
    return `Sent to ${recipient}.`;
  } catch (err) {
    return `ERROR: The user approved, but it may not have been sent: ${reason(err)}. Tell them to check Messages before trying again.`;
  }
}
