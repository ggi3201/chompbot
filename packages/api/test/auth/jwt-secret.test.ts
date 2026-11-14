import { mkdtempSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "vitest";
import { loadJwtSecret } from "../../src/auth/config.js";

const dbIn = () => join(mkdtempSync(join(tmpdir(), "chomp-jwt-")), "chomp.db");

test("a set JWT_SECRET is used as is", () => {
  expect(loadJwtSecret({ JWT_SECRET: "a-real-secret", DB_PATH: dbIn() })).toBe("a-real-secret");
});

test("without one, a random secret is made once, stored 600 next to the database, and reused", () => {
  const DB_PATH = dbIn();
  const first = loadJwtSecret({ DB_PATH });
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  const file = join(DB_PATH, "..", ".jwt-secret");
  expect(readFileSync(file, "utf8")).toBe(first);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(loadJwtSecret({ DB_PATH, JWT_SECRET: "" })).toBe(first);
});

test("a published example value is never used", () => {
  for (const JWT_SECRET of ["chomp-dev-secret-change-me", "change-me-to-a-random-string"]) {
    expect(loadJwtSecret({ JWT_SECRET, DB_PATH: dbIn() })).toMatch(/^[0-9a-f]{64}$/);
  }
});
