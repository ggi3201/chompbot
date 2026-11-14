import { readFileSync } from "fs";
import { dirname, join } from "path";

/** The header the API's internal endpoints require: CHOMP_MCP_SECRET, or the secret the API generated next to the database. */
function secret(): string {
  if (process.env.CHOMP_MCP_SECRET) return process.env.CHOMP_MCP_SECRET;
  try {
    return readFileSync(join(dirname(process.env.DB_PATH || "./data/chomp.db"), ".mcp-secret"), "utf8").trim();
  } catch {
    return "";
  }
}

export const internalAuth: Record<string, string> = { "X-Chomp-MCP-Secret": secret() };
