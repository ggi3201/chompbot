import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { encrypt, decrypt, isEncrypted } from "./crypto.js";

const SECRET_PREFIX = "secret:";

/** Save an encrypted secret to the settings table */
export function saveSecret(key: string, value: string): void {
  const dbKey = `${SECRET_PREFIX}${key}`;
  const encrypted = encrypt(value);

  const existing = db.select().from(settings).where(eq(settings.key, dbKey)).get();
  if (existing) {
    db.update(settings).set({ value: encrypted }).where(eq(settings.key, dbKey)).run();
  } else {
    db.insert(settings).values({ key: dbKey, value: encrypted }).run();
  }
}

/** Get a decrypted secret by key (returns null if not found) */
export function getSecret(key: string): string | null {
  const dbKey = `${SECRET_PREFIX}${key}`;
  const row = db.select().from(settings).where(eq(settings.key, dbKey)).get();
  if (!row) return null;

  try {
    return isEncrypted(row.value) ? decrypt(row.value) : row.value;
  } catch {
    console.error(`[secrets] Failed to decrypt secret: ${key}`);
    return null;
  }
}

/** Get all decrypted secrets as Record<string, string> (prefix stripped) */
export function getAllSecrets(): Record<string, string> {
  const rows = db.select().from(settings).all()
    .filter((r) => r.key.startsWith(SECRET_PREFIX));

  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.slice(SECRET_PREFIX.length);
    try {
      result[key] = isEncrypted(row.value) ? decrypt(row.value) : row.value;
    } catch {
      console.error(`[secrets] Failed to decrypt secret: ${key}`);
    }
  }
  return result;
}

/** List all secret keys with masked values (last 4 chars visible) */
export function listSecrets(): Array<{ key: string; masked: string }> {
  const rows = db.select().from(settings).all()
    .filter((r) => r.key.startsWith(SECRET_PREFIX));

  return rows.map((row) => {
    const key = row.key.slice(SECRET_PREFIX.length);
    let masked = "****";
    try {
      const value = isEncrypted(row.value) ? decrypt(row.value) : row.value;
      if (value.length > 4) {
        masked = "****" + value.slice(-4);
      }
    } catch {
      // Can't decrypt — show nothing
    }
    return { key, masked };
  });
}

/** Delete a secret */
export function deleteSecret(key: string): boolean {
  const dbKey = `${SECRET_PREFIX}${key}`;
  const existing = db.select().from(settings).where(eq(settings.key, dbKey)).get();
  if (!existing) return false;
  db.delete(settings).where(eq(settings.key, dbKey)).run();
  return true;
}
