import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import * as schema from "./schema.js";

const DB_PATH = process.env.DB_PATH ?? "./data/chomp.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

// Run migrations — use the API package's drizzle folder
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "../../api/drizzle");
try {
  migrate(db, { migrationsFolder });
} catch (err) {
  console.warn("[worker] Migration warning:", err instanceof Error ? err.message : err);
}
