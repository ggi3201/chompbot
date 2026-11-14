import { Router, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { verifyPassword, setupPassword } from "../auth/password.js";
import { isOllamaReady, ollama } from "../ollama/client.js";
import { PROVIDER_SECRET_KEYS } from "../chat/providers.js";
import { getSecret } from "../lib/secrets.js";
import { SAFE_SETTING_KEYS, isSafeSettingKey, validateSettingValue } from "../lib/setting-keys.js";

const router: ReturnType<typeof Router> = Router();

router.get("/", (_req: Request, res: Response) => {
  const result = db.select().from(settings).all();
  const filtered = result.filter((s) => isSafeSettingKey(s.key));
  const map: Record<string, string> = {};
  for (const s of filtered) {
    map[s.key] = s.value;
  }
  res.json(map);
});

// Update a setting
router.put("/:key", (req: Request, res: Response) => {
  const key = req.params.key as string;
  if (!isSafeSettingKey(key)) {
    res.status(400).json({ error: `Invalid setting key: ${key}. Allowed: ${SAFE_SETTING_KEYS.join(", ")}` });
    return;
  }

  const { value } = req.body;
  if (value === undefined) {
    res.status(400).json({ error: "value is required" });
    return;
  }

  const validationError = validateSettingValue(key, value);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const existing = db.select().from(settings).where(eq(settings.key, key)).get();
  if (existing) {
    db.update(settings).set({ value: String(value) }).where(eq(settings.key, key)).run();
  } else {
    db.insert(settings).values({ key, value: String(value) }).run();
  }

  // A new embedding model makes the stored vectors incomparable: re-embed them in the background.
  if (key === "embedding_model") {
    void import("../db/memories.js")
      .then(({ backfillEmbeddings }) => backfillEmbeddings())
      .then((r) => console.log(`[embeddings] re-embedded ${r.embedded}, failed ${r.failed}, kept ${r.skipped}`))
      .catch((err) => console.warn("[embeddings] backfill failed:", err instanceof Error ? err.message : err));
  }

  res.json({ key, value: String(value) });
});

// Change password
router.post("/change-password", async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "currentPassword and newPassword are required" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
    return;
  }

  const valid = await verifyPassword(currentPassword);
  if (!valid) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  // Delete old and set new
  db.delete(settings).where(eq(settings.key, "password_hash")).run();
  await setupPassword(newPassword);
  res.json({ status: "ok" });
});

// Ollama status and model list
router.get("/ollama/status", async (_req: Request, res: Response) => {
  const ready = await isOllamaReady();
  if (!ready) {
    res.json({ ready: false, models: [] });
    return;
  }

  try {
    const list = await ollama.list();
    const models = list.models.map((m) => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at,
    }));
    res.json({ ready: true, models });
  } catch {
    res.json({ ready: false, models: [] });
  }
});

/** GET /api/settings/configured-providers — list providers that have API keys stored */
router.get("/configured-providers", (_req: Request, res: Response) => {
  const configured: string[] = [];
  for (const [provider, envKey] of Object.entries(PROVIDER_SECRET_KEYS)) {
    if (getSecret(envKey) ?? process.env[envKey]) {
      configured.push(provider);
    }
  }
  // Always include ollama as available (local)
  configured.unshift("ollama");
  res.json({ providers: configured });
});

const run = promisify(execFile);

/** The agent runtimes chats run on, and how each CLI reports its own login (exit code 0 = logged in). */
const RUNTIMES = [
  { provider: "claude", bin: "claude", statusArgs: ["auth", "status"], loginCommand: "claude auth login" },
  { provider: "codex", bin: "codex", statusArgs: ["login", "status"], loginCommand: "codex login" },
] as const;

/** GET /api/settings/runtimes — whether Claude Code and Codex are installed and logged in on this machine */
router.get("/runtimes", async (_req: Request, res: Response) => {
  res.json(await Promise.all(RUNTIMES.map(async ({ provider, bin, statusArgs, loginCommand }) => {
    const version = await run(bin, ["--version"], { timeout: 10_000 }).then((r) => r.stdout.trim().split("\n")[0], () => null);
    if (version === null) return { provider, installed: false, loggedIn: false, loginCommand };
    const loggedIn = await run(bin, [...statusArgs], { timeout: 15_000 }).then(() => true, () => false);
    return { provider, installed: true, loggedIn, version, loginCommand };
  })));
});

export default router;
