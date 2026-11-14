import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { settings } from "../../src/db/schema.js";
import { isAllowedDiscordUser } from "../../src/discord/bot.js";

afterEach(() => {
  db.delete(settings).where(eq(settings.key, "discord_user_names")).run();
});

test("a stranger is never allowed, even before the owner is known", () => {
  expect(isAllowedDiscordUser("999")).toBe(false);
});

test("people named in discord_user_names are allowed", () => {
  db.insert(settings).values({ key: "discord_user_names", value: JSON.stringify({ "123": "Sam" }) }).run();
  expect(isAllowedDiscordUser("123")).toBe(true);
  expect(isAllowedDiscordUser("124")).toBe(false);
  expect(isAllowedDiscordUser("__proto__")).toBe(false);
});
