import { expect, test } from "vitest";
import { issueOAuthState, takeOAuthState } from "../../src/lib/oauth-state.js";

test("a state this Chomp issued gives back its origin, once", () => {
  const state = issueOAuthState("https://chomp.example.com");
  expect(takeOAuthState(state)).toBe("https://chomp.example.com");
  expect(takeOAuthState(state)).toBeNull();
});

test("a forged, missing or old state is refused", () => {
  // The old scheme: the origin itself, base64url-encoded, which anyone can make.
  expect(takeOAuthState(Buffer.from("https://evil.example").toString("base64url"))).toBeNull();
  expect(takeOAuthState(undefined)).toBeNull();
  expect(takeOAuthState(["a", "b"])).toBeNull();
  const now = Date.now();
  const state = issueOAuthState("https://chomp.example.com", now);
  expect(takeOAuthState(state, now + 11 * 60_000)).toBeNull();
});
