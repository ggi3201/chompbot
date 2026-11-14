import { test, expect } from "vitest";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../src/auth/config.js";
import { createToken } from "../../src/auth/middleware.js";

const DAY = 24 * 60 * 60;

test("default token expires roughly 30 days out", () => {
  const before = Math.floor(Date.now() / 1000);
  const token = createToken();
  const decoded = jwt.verify(token, JWT_SECRET) as { exp: number };
  const ttl = decoded.exp - before;
  expect(ttl).toBeGreaterThan(29 * DAY);
  expect(ttl).toBeLessThan(31 * DAY);
});

test("longLived=true token expires roughly 365 days out", () => {
  const before = Math.floor(Date.now() / 1000);
  const token = createToken({ longLived: true });
  const decoded = jwt.verify(token, JWT_SECRET) as { exp: number };
  const ttl = decoded.exp - before;
  expect(ttl).toBeGreaterThan(364 * DAY);
  expect(ttl).toBeLessThan(366 * DAY);
});
