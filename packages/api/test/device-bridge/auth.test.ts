import { afterEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { createToken } from "../../src/auth/middleware.js";
import { isValidBridgeToken } from "../../src/device-bridge/server.js";

describe("isValidBridgeToken", () => {
  afterEach(() => {
    delete process.env.DEVICE_BRIDGE_TOKEN;
  });

  it("accepts the login JWT with no shared secret set", () => {
    expect(isValidBridgeToken(createToken())).toBe(true);
  });

  it("accepts the shared secret when it is set", () => {
    process.env.DEVICE_BRIDGE_TOKEN = "shared-secret";
    expect(isValidBridgeToken("shared-secret")).toBe(true);
  });

  it("rejects a missing token, even with no shared secret set", () => {
    expect(isValidBridgeToken(null)).toBe(false);
    expect(isValidBridgeToken("")).toBe(false);
  });

  it("rejects a wrong token and a JWT signed with another secret", () => {
    process.env.DEVICE_BRIDGE_TOKEN = "shared-secret";
    expect(isValidBridgeToken("wrong")).toBe(false);
    expect(isValidBridgeToken(jwt.sign({ sub: "x" }, "another-secret"))).toBe(false);
  });
});
