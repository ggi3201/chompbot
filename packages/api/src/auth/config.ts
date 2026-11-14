import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/** Values that were ever published as examples. Running on one would let anyone sign in. */
const PUBLISHED_PLACEHOLDERS = new Set(["chomp-dev-secret-change-me", "change-me-to-a-random-string"]);

/**
 * A secret from the environment, else a random one made on first start and kept next to the database
 * (mode 600), so a fresh install never runs on a known or missing value.
 */
export function loadSecret(name: string, file: string, env: NodeJS.ProcessEnv = process.env): string {
  const set = env[name]?.trim();
  if (set && !PUBLISHED_PLACEHOLDERS.has(set)) return set;
  const path = join(dirname(env.DB_PATH || "./data/chomp.db"), file);
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  if (set) console.warn(`[auth] ${name} is an example value; using a generated secret instead`);
  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

export const loadJwtSecret = (env: NodeJS.ProcessEnv = process.env) => loadSecret("JWT_SECRET", ".jwt-secret", env);

export const JWT_SECRET: string = loadJwtSecret();

/**
 * Guards the MCP tool bridge and the internal endpoints. Put in the environment so every agent, bridge and
 * MCP registration Chomp starts carries it.
 */
export const MCP_SECRET: string = loadSecret("CHOMP_MCP_SECRET", ".mcp-secret");
process.env.CHOMP_MCP_SECRET = MCP_SECRET;
