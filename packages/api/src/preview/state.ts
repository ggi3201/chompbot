import { eq } from "drizzle-orm";
import type { PreviewState } from "@chomp/shared";
import { db } from "../db/index.js";
import { conversations } from "../db/schema.js";
import { DEFAULT_AGENT_CWD } from "../agents/runtime/claude.js";
import { listServers, readLaunchConfigs, startServer, stopUnshownServers } from "./servers.js";
import { closeIdleSessions, closedPage, getSession, openSession, shownPorts } from "./session.js";

const SWEEP_MS = 60_000;

// What the preview holds on to is let go when unused: idle pages close first, then servers no page shows stop.
setInterval(() => {
  closeIdleSessions();
  stopUnshownServers(shownPorts());
}, SWEEP_MS).unref();

/** Where the chat's agents run, read only: the agent's first turn creates a worktree, the pane must not. */
export function previewDir(conversationId: string): string {
  const row = db.select({ projectPath: conversations.projectPath, worktreePath: conversations.worktreePath }).from(conversations).where(eq(conversations.id, conversationId)).get();
  return row?.worktreePath ?? row?.projectPath ?? DEFAULT_AGENT_CWD;
}

export async function previewState(conversationId: string): Promise<PreviewState> {
  const dir = previewDir(conversationId);
  let configs: PreviewState["configs"] = [];
  let configError: string | null = null;
  try {
    configs = readLaunchConfigs(dir).map(({ name, port }) => ({ name, port }));
  } catch (e) {
    configError = e instanceof Error ? e.message : String(e);
  }
  const closed = closedPage(conversationId);
  return {
    page: (await getSession(conversationId)?.state()) ?? null,
    lastUrl: closed.url,
    closedBecause: closed.because,
    configs,
    configError,
    servers: listServers(dir),
  };
}

/** Starts a launch config if named, then shows its page, or the url, in the chat's preview. */
export async function startPreview(conversationId: string, target: { name?: string; url?: string }): Promise<{ url: string; server: string | null }> {
  if (target.name) {
    const server = await startServer(previewDir(conversationId), target.name);
    const session = await openSession(conversationId);
    await session.goto(target.url ?? server.url);
    return { url: target.url ?? server.url, server: server.name };
  }
  if (!target.url) throw new Error("Give the name of a configuration in .claude/launch.json, or a url.");
  await (await openSession(conversationId)).goto(target.url);
  return { url: target.url, server: null };
}
