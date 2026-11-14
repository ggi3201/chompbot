import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import * as schema from "./schema.js";
import { mkdirSync } from "fs";
import { dirname } from "path";

export const DB_PATH = process.env.DB_PATH ?? "./data/chomp.db";

// ── Production-DB open guard ────────────────────────────────────────────────
// History: vitest `beforeEach` hooks (db.delete(agents)/db.delete(settings))
// wiped the real prod DB more than once. The previous guard only fired when
// NODE_ENV==="test", so a test process that ran WITHOUT NODE_ENV set skipped it
// entirely and silently truncated production tables.
//
// New rule, independent of NODE_ENV: a DB under /tmp/ is always ephemeral and
// safe to open. ANY other path is treated as production and may only be opened
// by a process that explicitly opts in via CHOMP_ALLOW_PROD_DB=1 — which only
// the real server (systemd EnvironmentFile) and `pnpm dev` set. Tests use a
// /tmp DB so they pass freely; a stray test/script that resolves DB_PATH to a
// real database without the flag throws here instead of wiping it.
const IS_EPHEMERAL_DB = DB_PATH.startsWith("/tmp/");
const ALLOW_PROD_DB = process.env.CHOMP_ALLOW_PROD_DB === "1";

if (process.env.NODE_ENV === "test" && !IS_EPHEMERAL_DB) {
  throw new Error(
    `[db] Refusing to open ${DB_PATH} in test environment — DB_PATH must be inside /tmp/. ` +
    `Tests must never touch a non-tmp database. Check vitest.config.ts.`,
  );
}

if (!IS_EPHEMERAL_DB && !ALLOW_PROD_DB) {
  throw new Error(
    `[db] Refusing to open non-ephemeral database ${DB_PATH} without CHOMP_ALLOW_PROD_DB=1. ` +
    `Only the real server process (and 'pnpm dev') may open a production DB. ` +
    `If you are running tests, point DB_PATH at a /tmp path; if this is the server, ` +
    `set CHOMP_ALLOW_PROD_DB=1 in its environment.`,
  );
}

// Ensure data directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export function runMigrations() {
  migrate(db, { migrationsFolder: "./drizzle" });
}
