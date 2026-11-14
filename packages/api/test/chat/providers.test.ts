import { expect, test } from "vitest";
import { PROVIDER_SECRET_KEYS } from "../../src/chat/providers.js";

test("PROVIDER_SECRET_KEYS uses uppercase env-style names", () => {
  for (const key of Object.values(PROVIDER_SECRET_KEYS)) expect(key).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$/);
});
