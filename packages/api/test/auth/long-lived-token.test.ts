import { test, expect } from "vitest";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../src/auth/config.js";
import { createToken } from "../../src/auth/middleware.js";

const DAY = 24 * 60 * 60;

test("a default token expires roughly 30 days out, a longLived one roughly 365", () => {
  const ttl = (token: string) => (jwt.verify(token, JWT_SECRET) as { exp: number }).exp - Math.floor(Date.now() / 1000);
  for (const [token, days] of [[createToken(), 30], [createToken({ longLived: true }), 365]] as const) {
    expect(ttl(token)).toBeGreaterThan((days - 1) * DAY);
    expect(ttl(token)).toBeLessThan((days + 1) * DAY);
  }
});
