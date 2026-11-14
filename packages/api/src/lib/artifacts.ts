// Artifacts: agent-written HTML pages, stored as files and served by unguessable id.
// Shown in chat inside a sandboxed iframe (see web Artifact.tsx) and openable in a tab.

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? "./data/artifacts";
mkdirSync(ARTIFACTS_DIR, { recursive: true });

export const ARTIFACT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_BYTES = 2 * 1024 * 1024;

const pathFor = (id: string) => join(ARTIFACTS_DIR, `${id}.html`);

/** Create (no id) or replace (existing id) an artifact. Returns its id. */
export function saveArtifact(html: string, id?: string): string {
  if (!html.trim()) throw new Error("html is required");
  if (Buffer.byteLength(html) > MAX_BYTES) throw new Error("html is over 2 MB");
  if (id !== undefined && (!ARTIFACT_ID_RE.test(id) || !existsSync(pathFor(id)))) {
    throw new Error(`No artifact with id ${id}`);
  }
  const finalId = id ?? randomUUID();
  writeFileSync(pathFor(finalId), html);
  return finalId;
}

// Gives every page a mobile viewport and `chomp.send(text)`, which posts text into the chat as the user's next message.
const SHIM =
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<script>window.chomp={send:function(t){parent.postMessage({chompSend:String(t)},"*")}}</script>';

/** The stored page with the shim injected, or null when the id is unknown. */
export function readArtifact(id: string): string | null {
  if (!ARTIFACT_ID_RE.test(id) || !existsSync(pathFor(id))) return null;
  const html = readFileSync(pathFor(id), "utf8");
  const head = html.match(/<head[^>]*>/i);
  return head ? html.replace(head[0], head[0] + SHIM) : SHIM + html;
}

/** The canvas fence the agent pastes into its reply. */
export function artifactFence(id: string, title: string): string {
  return `:::canvas\n${JSON.stringify({ type: "artifact", id, title })}\n:::`;
}
