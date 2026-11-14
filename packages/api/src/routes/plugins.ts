import { Router, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const router: ReturnType<typeof Router> = Router();

/** `name@marketplace`, as Claude Code names installed plugins. Checked before it reaches the CLI. */
const PLUGIN_ID = /^[a-z0-9][\w.-]*@[a-z0-9][\w.-]*$/i;

interface CliPlugin {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  installPath: string;
}

/** Claude Code's own plugin commands, so the page shows and changes what Claude Code actually uses. */
function claudePlugin(args: string[]) {
  return run("claude", ["plugin", ...args], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CLAUDECODE: undefined } });
}

function description(installPath: string): string {
  try {
    return (JSON.parse(readFileSync(join(installPath, ".claude-plugin", "plugin.json"), "utf8")) as { description?: string }).description ?? "";
  } catch {
    return "";
  }
}

export async function listPlugins() {
  const { stdout } = await claudePlugin(["list", "--json"]);
  return (JSON.parse(stdout) as CliPlugin[]).map((p) => {
    const [name, marketplace] = p.id.split("@");
    return { id: p.id, name, marketplace, version: p.version, scope: p.scope, enabled: p.enabled, description: description(p.installPath) };
  });
}

function fail(res: Response, err: unknown) {
  const stderr = (err as { stderr?: string }).stderr?.trim().split("\n").pop();
  res.status(500).json({ error: stderr || (err instanceof Error ? err.message : "Claude Code plugin command failed") });
}

/** Runs one plugin command on a validated id, then answers with the fresh list. */
function action(args: (id: string, req: Request) => string[]) {
  return async (req: Request, res: Response) => {
    const id = String(req.params.id ?? req.body?.id ?? "").trim();
    if (!PLUGIN_ID.test(id)) {
      res.status(400).json({ error: "Give the plugin as name@marketplace" });
      return;
    }
    try {
      await claudePlugin(args(id, req));
      res.json(await listPlugins());
    } catch (err) {
      fail(res, err);
    }
  };
}

router.get("/", async (_req: Request, res: Response) => {
  try {
    res.json(await listPlugins());
  } catch (err) {
    fail(res, err);
  }
});

router.post("/", action((id) => ["install", id]));
router.put("/:id", action((id, req) => [req.body?.enabled ? "enable" : "disable", id]));
router.delete("/:id", action((id) => ["uninstall", id]));

export { PLUGIN_ID };
export default router;
