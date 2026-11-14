import type { PreviewColorScheme } from "@chomp/shared";
import { closedPage, getSession, type ActArgs, type PreviewSession } from "../../preview/session.js";
import { LAUNCH_FILE, listServers, readLaunchConfigs, serverLogs, stopServer } from "../../preview/servers.js";
import { previewDir, previewState, startPreview } from "../../preview/state.js";

const MAX_TEXT = 30_000;
const ERROR_LINE = /error|exception|failed|fatal/i;

const cap = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}\n… cut at ${max} characters` : text);

function sessionOf(conversationId: string): PreviewSession {
  const session = getSession(conversationId);
  if (session) return session;
  throw new Error(["No page is open in this chat's preview.", closedPage(conversationId).because, "Call preview_start first."].filter(Boolean).join(" "));
}

async function pageLine(session: PreviewSession): Promise<string> {
  const { url, title, viewport } = await session.state();
  return `Page: ${title || "(no title)"} at ${url}, ${viewport.width}x${viewport.height} (${viewport.preset}, ${viewport.colorScheme} colours)`;
}

const LAUNCH_EXAMPLE = `{
  "version": "0.0.1",
  "configurations": [
    { "name": "web", "runtimeExecutable": "pnpm", "runtimeArgs": ["dev"], "port": 5173 }
  ]
}`;

export async function execPreviewStart(conversationId: string, args: { name?: string; url?: string }): Promise<string> {
  let { name } = args;
  if (!name && !args.url) {
    const configs = readLaunchConfigs(previewDir(conversationId));
    if (configs.length !== 1) {
      const known = configs.length ? `Configurations: ${configs.map((c) => c.name).join(", ")}.` : `This project has no ${LAUNCH_FILE}. Write one, for example:\n${LAUNCH_EXAMPLE}`;
      throw new Error(`Name a configuration, or give a url. ${known}`);
    }
    name = configs[0].name;
  }
  const { url, server } = await startPreview(conversationId, { name, url: args.url });
  const session = sessionOf(conversationId);
  // The web chat opens its pane on this first line, so its wording is load-bearing.
  return [
    `Preview open at ${url}`,
    ...(server ? [`Server: "${server}". Its output is in preview_logs.`] : []),
    "The user sees this page live in the chat's preview pane and can use it too. You drive the same page: preview_snapshot to read it, preview_act to use it, preview_screenshot to look.",
    await pageLine(session),
  ].join("\n");
}

export async function execPreviewStop(conversationId: string, args: { name: string }): Promise<string> {
  await stopServer(previewDir(conversationId), args.name);
  return `Stopped "${args.name}".`;
}

export async function execPreviewList(conversationId: string): Promise<string> {
  const state = await previewState(conversationId);
  const configs = state.configError ?? (state.configs.map((c) => `${c.name} (port ${c.port})`).join(", ") || `none, no ${LAUNCH_FILE}`);
  const servers = state.servers.map((s) => `${s.name}: ${s.status}${s.status === "exited" ? ` (code ${s.exitCode})` : ""}, ${s.url}`).join("\n") || "none";
  const page = state.page ? `${state.page.title || "(no title)"} at ${state.page.url}` : [`none${state.lastUrl ? `, last at ${state.lastUrl}` : ""}.`, state.closedBecause].filter(Boolean).join(" ");
  return `Configurations: ${configs}\nServers:\n${servers}\nPage: ${page}`;
}

export async function execPreviewLogs(
  conversationId: string,
  args: { source?: "server" | "console" | "network"; name?: string; level?: "error"; search?: string; lines?: number; request_id?: number },
): Promise<string> {
  const { source = "server", level, lines = 50 } = args;
  const search = args.search?.toLowerCase();
  const keep = (text: string, isError: boolean) => (!level || isError) && (!search || text.toLowerCase().includes(search));

  if (source === "server") {
    const dir = previewDir(conversationId);
    const servers = listServers(dir);
    const name = args.name ?? (servers.length === 1 ? servers[0].name : undefined);
    if (!name) throw new Error(`Name the server. Servers: ${servers.map((s) => s.name).join(", ") || "none has run"}.`);
    const out = serverLogs(dir, name).filter((l) => keep(l.text, l.stream === "err" || ERROR_LINE.test(l.text)));
    return cap(out.slice(-lines).map((l) => l.text).join("\n")) || "(no matching lines)";
  }

  const session = sessionOf(conversationId);
  if (source === "console") {
    const out = session.console.filter((e) => keep(`${e.level} ${e.text}`, e.level === "error"));
    return cap(out.slice(-lines).map((e) => `[${e.level}] ${e.text}${e.source ? ` (${e.source})` : ""}`).join("\n")) || "(no matching messages)";
  }

  if (args.request_id !== undefined) return cap(await session.responseBody(args.request_id));
  const out = session.requests.filter((r) => keep(r.url, !!r.failure || (r.status ?? 0) >= 400));
  return (
    cap(out.slice(-lines).map((r) => `#${r.id} ${r.method} ${r.failure ?? r.status ?? "pending"} ${r.url} (${r.type})`).join("\n")) || "(no matching requests)"
  );
}

export async function execPreviewSnapshot(conversationId: string): Promise<string> {
  const session = sessionOf(conversationId);
  return `${await pageLine(session)}\n\n${cap(await session.snapshot())}`;
}

export async function execPreviewScreenshot(conversationId: string): Promise<{ imageBase64: string; mimeType: string; page: string }> {
  const session = sessionOf(conversationId);
  const image = await session.screenshot();
  return { imageBase64: image.toString("base64"), mimeType: "image/jpeg", page: await pageLine(session) };
}

export async function execPreviewAct(conversationId: string, args: ActArgs): Promise<string> {
  const session = sessionOf(conversationId);
  const seen = session.console.length;
  await session.act(args);
  const errors = session.console.slice(seen).filter((e) => e.level === "error");
  const said = errors.length ? `\nNew console errors:\n${cap(errors.map((e) => e.text).join("\n"), 4_000)}` : "";
  return `Done: ${args.action}.\n${await pageLine(session)}${said}`;
}

export async function execPreviewNavigate(conversationId: string, args: { url: string }): Promise<string> {
  const session = sessionOf(conversationId);
  if (args.url === "back" || args.url === "forward" || args.url === "reload") await session.history(args.url);
  else await session.goto(args.url);
  return await pageLine(session);
}

export async function execPreviewEval(conversationId: string, args: { expression: string }): Promise<string> {
  const value = await sessionOf(conversationId).evaluate(args.expression);
  return cap(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "undefined", 20_000);
}

export async function execPreviewResize(
  conversationId: string,
  args: { preset?: "desktop" | "tablet" | "mobile"; width?: number; height?: number; color_scheme?: PreviewColorScheme },
): Promise<string> {
  const session = sessionOf(conversationId);
  await session.resize({ preset: args.preset, width: args.width, height: args.height, colorScheme: args.color_scheme });
  return await pageLine(session);
}

const WINDOW_VIEWS = ["open", "close", "docked", "floating", "full", "pop_out", "browser_tab"] as const;
export type PreviewWindowView = (typeof WINDOW_VIEWS)[number];

/** Nothing happens here: the web chat reads this call's output and changes its pane, as it does for preview_start. */
export async function execPreviewWindow(conversationId: string, args: { view: PreviewWindowView }): Promise<string> {
  const { view } = args;
  if (!WINDOW_VIEWS.includes(view)) throw new Error(`view must be one of ${WINDOW_VIEWS.join(", ")}.`);
  if (view === "pop_out" || view === "browser_tab") sessionOf(conversationId);
  // The web chat follows the first line, so its wording is load-bearing.
  return [
    `Preview window: ${view}`,
    view === "pop_out" || view === "browser_tab"
      ? "Browsers only open a window or a tab on the user's own tap, so the pane now shows a button for it. Tell the user to tap it."
      : "The user's web chat follows this as soon as it shows this chat. Telegram and Discord have no pane.",
  ].join("\n");
}
