import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";

const DB_PATH = process.env.DB_PATH ?? "./data/chomp.db";
const BACKUP_DIR = join(dirname(DB_PATH), "backups");

interface BackupFile {
  name: string;
  sizeBytes: number;
  mtime: string;
}

interface BackupResult {
  path: string;
  sizeBytes: number;
  retentionDays: number;
  pruned: string[];
}

function readRetentionDays(): number {
  const row = db.select().from(settings).where(eq(settings.key, "backup_retention_days")).get();
  const value = Number(row?.value);
  if (!Number.isFinite(value) || value < 1) return 30;
  return Math.min(value, 365);
}

/** A one-off copy before a data migration, kept once under its own name. */
export function backupBeforeMigration(name: string): void {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const path = join(BACKUP_DIR, `before-${name}.db`);
  if (existsSync(path)) return;
  db.run(sql.raw(`VACUUM INTO '${path.replaceAll("'", "''")}'`));
}

export async function runBackup(): Promise<BackupResult> {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const retentionDays = readRetentionDays();

  const date = new Date().toISOString().slice(0, 10);
  const backupPath = join(BACKUP_DIR, `chomp-${date}.db`);

  const source = new Database(DB_PATH, { readonly: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }

  const cutoffMs = Date.now() - retentionDays * 86_400_000;
  const pruned: string[] = [];
  for (const file of readdirSync(BACKUP_DIR)) {
    if (!file.startsWith("chomp-") || !file.endsWith(".db")) continue;
    const filepath = join(BACKUP_DIR, file);
    if (statSync(filepath).mtimeMs < cutoffMs) {
      unlinkSync(filepath);
      pruned.push(file);
    }
  }

  return { path: backupPath, sizeBytes: statSync(backupPath).size, retentionDays, pruned };
}

export function listBackups(): BackupFile[] {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("chomp-") && f.endsWith(".db"))
    .map((name) => {
      const stat = statSync(join(BACKUP_DIR, name));
      return { name, sizeBytes: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export function startDailyBackups(): void {
  const tick = () => runBackup().then(
    (r) => console.log(`[backup] done: ${r.path} (${(r.sizeBytes / 1e6).toFixed(1)} MB), pruned ${r.pruned.length}`),
    (e: unknown) => console.error("[backup] failed:", e instanceof Error ? e.message : e),
  );

  const next = new Date();
  next.setHours(3, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);

  setTimeout(() => {
    tick();
    setInterval(tick, 86_400_000);
  }, next.getTime() - Date.now());

  console.log(`[backup] daily scheduled for ${next.toISOString()}`);
}
