import { afterEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { createToken } from "../../src/auth/middleware.js";
import { isValidBridgeToken } from "../../src/device-bridge/server.js";

describe("isValidBridgeToken", () => {
  afterEach(() => {
    delete process.env.DEVICE_BRIDGE_TOKEN;
  });

  it("accepts the login JWT with no shared secret set, and the shared secret when it is set", () => {
    expect(isValidBridgeToken(createToken())).toBe(true);
    process.env.DEVICE_BRIDGE_TOKEN = "shared-secret";
    expect(isValidBridgeToken("shared-secret")).toBe(true);
  });

  it("rejects a missing token even with no shared secret set, a wrong token, and a JWT signed with another secret", () => {
    expect(isValidBridgeToken(null)).toBe(false);
    expect(isValidBridgeToken("")).toBe(false);
    process.env.DEVICE_BRIDGE_TOKEN = "shared-secret";
    expect(isValidBridgeToken("wrong")).toBe(false);
    expect(isValidBridgeToken(jwt.sign({ sub: "x" }, "another-secret"))).toBe(false);
  });
});
