import { once } from "events";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { settings } from "../../src/db/schema.js";
import { deleteSecret, saveSecret } from "../../src/lib/secrets.js";
import { SAFE_SETTING_KEYS } from "../../src/lib/setting-keys.js";
import telegramRoutes from "../../src/routes/telegram.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/api/telegram", telegramRoutes);
  server = app.listen(0);
  await once(server, "listening");
  base = `http://localhost:${(server.address() as AddressInfo).port}/api/telegram`;
});

afterAll(() => server.close());

// An empty value counts as unset, so the developer's own .env can't leak into these tests.
beforeEach(() => vi.stubEnv("TELEGRAM_API_KEY", ""));

afterEach(() => {
  deleteSecret("TELEGRAM_API_KEY");
  db.delete(settings).where(eq(settings.key, "telegram_bot_token")).run();
  vi.unstubAllEnvs();
});

const tokenSource = async () => ((await (await fetch(`${base}/status`)).json()) as { tokenSource: string | null }).tokenSource;

test("with no token anywhere, the status says so", async () => {
  expect(await tokenSource()).toBeNull();
});

test("a token in the server's .env shows as coming from there", async () => {
  vi.stubEnv("TELEGRAM_API_KEY", "111:from-env");
  expect(await tokenSource()).toBe("env");
});

test("a token saved in Settings wins over the one in .env", async () => {
  vi.stubEnv("TELEGRAM_API_KEY", "111:from-env");
  saveSecret("TELEGRAM_API_KEY", "222:from-settings");
  expect(await tokenSource()).toBe("settings");
});

test("the old plain telegram_bot_token setting is neither read nor exposed", async () => {
  db.insert(settings).values({ key: "telegram_bot_token", value: "333:plain" }).run();
  expect(await tokenSource()).toBeNull();
  expect(SAFE_SETTING_KEYS).not.toContain("telegram_bot_token");
});
