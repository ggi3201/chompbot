import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { JWT_SECRET } from "../auth/config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey(): Buffer {
  const keySource = process.env.ENCRYPTION_KEY || JWT_SECRET;
  return createHash("sha256").update(keySource).digest();
}

/** Encrypt plaintext -> "iv:tag:ciphertext" hex string */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

/** Decrypt "iv:tag:ciphertext" hex string -> plaintext */
export function decrypt(encoded: string): string {
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");

  const [ivHex, tagHex, ciphertext] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/** Check if a value looks like an encrypted string (iv:tag:ciphertext hex) */
export function isEncrypted(value: string): boolean {
  return /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(value);
}
