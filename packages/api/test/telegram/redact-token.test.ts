import { inspect } from "util";
import { Bot } from "grammy";
import { expect, test } from "vitest";
import { redactTokenFromErrors } from "../../src/telegram/redact-token.js";

const TOKEN = "123456:SECRET-test-token";

// Nothing listens on this port, so the call fails the way a network error does.
const unreachableBot = () => new Bot(TOKEN, { client: { apiRoot: "http://127.0.0.1:9" } });

test("a failed API call carries the token, and with the redaction logs without it but still says what failed", async () => {
  const raw = await unreachableBot().api.getMe().catch((e: unknown) => e);
  expect(inspect(raw)).toContain(TOKEN);

  const bot = unreachableBot();
  redactTokenFromErrors(bot);

  const err = await bot.api.getMe().catch((e: unknown) => e);

  expect(inspect(err)).not.toContain(TOKEN);
  expect(inspect(err)).toContain("getMe");
  expect(inspect(err)).toContain("<token>");
});
