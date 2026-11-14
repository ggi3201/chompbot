import { afterEach, expect, test, vi } from "vitest";
import { deleteSecret, saveSecret } from "../../src/lib/secrets.js";
import { credentials } from "../../src/monitoring/cloudflare.js";

const accounts = (ids: string[]) =>
  vi.fn(async () => new Response(JSON.stringify({ success: true, result: ids.map((id) => ({ id })) })));

afterEach(() => {
  vi.unstubAllGlobals();
  deleteSecret("CLOUDFLARE_API_TOKEN");
  deleteSecret("CLOUDFLARE_ACCOUNT_ID");
});

test("without an account id, the token's only account is used, and it is looked up once", async () => {
  saveSecret("CLOUDFLARE_API_TOKEN", "token-one");
  const fetch = accounts(["account-1"]);
  vi.stubGlobal("fetch", fetch);
  expect(await credentials()).toEqual({ token: "token-one", account: "account-1" });
  expect(await credentials()).toEqual({ token: "token-one", account: "account-1" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("a token that sees several accounts asks for the account id", async () => {
  saveSecret("CLOUDFLARE_API_TOKEN", "token-two");
  vi.stubGlobal("fetch", accounts(["a", "b"]));
  await expect(credentials()).rejects.toThrow("The token sees 2 accounts. Set CLOUDFLARE_ACCOUNT_ID in Settings.");
});

test("a set account id is used without a lookup", async () => {
  saveSecret("CLOUDFLARE_API_TOKEN", "token-three");
  saveSecret("CLOUDFLARE_ACCOUNT_ID", "set-account");
  const fetch = accounts(["other"]);
  vi.stubGlobal("fetch", fetch);
  expect(await credentials()).toEqual({ token: "token-three", account: "set-account" });
  expect(fetch).not.toHaveBeenCalled();
});

test("no token means not configured", async () => {
  await expect(credentials()).rejects.toThrow("Not configured");
});
