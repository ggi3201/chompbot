import { afterEach, expect, test } from "vitest";
import { like } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { settings } from "../../src/db/schema.js";
import { getAllSecrets, getSecret, saveSecret } from "../../src/lib/secrets.js";

const put = (key: string, value: string) => db.insert(settings).values({ key, value }).run();
afterEach(() => db.delete(settings).where(like(settings.key, "secret:TEST_%")).run());

test("secrets are encrypted at rest, old plaintext ones still read, and an unreadable one is skipped, not fatal", () => {
  saveSecret("TEST_NEW", "s3cret-value");
  const stored = db.select().from(settings).all().find((r) => r.key === "secret:TEST_NEW")!;
  expect(stored.value).not.toContain("s3cret-value");

  put("secret:TEST_LEGACY", "plain-old-value");
  put("secret:TEST_BROKEN", `${"0".repeat(24)}:${"0".repeat(32)}:abcd`); // encrypted format, but not decryptable

  expect(getSecret("TEST_NEW")).toBe("s3cret-value");
  expect(getSecret("TEST_LEGACY")).toBe("plain-old-value");
  expect(getSecret("TEST_BROKEN")).toBeNull();
  const all = getAllSecrets();
  expect(all).toMatchObject({ TEST_NEW: "s3cret-value", TEST_LEGACY: "plain-old-value" });
  expect(all).not.toHaveProperty("TEST_BROKEN");
});
