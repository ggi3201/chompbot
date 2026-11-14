import { execFileSync } from "child_process";
import { readFileSync, readdirSync, existsSync, symlinkSync, mkdirSync, lstatSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import { mcpServers } from "../db/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// bridge.mjs is plain JS in src/, not compiled to dist/
const PACKAGE_ROOT = join(__dirname, "../..");
const BRIDGE_PATH = join(PACKAGE_ROOT, "src/mcp/bridge.mjs");

/**
 * Sync chomp MCP servers using `claude mcp add/remove` CLI.
 * This is safe — it only touches chomp-prefixed entries and
 * never directly writes to ~/.claude.json.
 */
export function syncMcpServers() {
  // A test API would otherwise point every agent's global chomp-api tools at itself.
  if (process.env.CHOMP_SKIP_MCP_SYNC === "1") return;
  // Register the chomp-api bridge
  const bridgePath = BRIDGE_PATH;
  const envArgs = ["-e", `CHOMP_PORT=${process.env.PORT ?? "3001"}`, "-e", "CHOMP_HOST=127.0.0.1"];
  if (process.env.CHOMP_MCP_SECRET) {
    envArgs.push("-e", `CHOMP_MCP_SECRET=${process.env.CHOMP_MCP_SECRET}`);
  }

  try {
    // Remove first to avoid "already exists" errors
    execFileSync("claude", ["mcp", "remove", "-s", "user", "chomp-api"], { stdio: "ignore" });
  } catch { /* doesn't exist yet, fine */ }

  try {
    // Note: -e (variadic) must come AFTER the server name, otherwise it consumes it
    execFileSync("claude", ["mcp", "add", "-s", "user", "chomp-api", ...envArgs, "--", "node", bridgePath], {
      stdio: "ignore",
      env: { ...process.env, CLAUDECODE: undefined },
    });
  } catch (err) {
    console.warn("[mcp-sync] Failed to register chomp-api bridge:", err instanceof Error ? err.message : err);
  }

  // Register chomp-api bridge with Codex CLI (non-fatal if codex not installed)
  try {
    execFileSync("codex", ["mcp", "remove", "chomp-api"], { stdio: "ignore" });
  } catch { /* doesn't exist yet, fine */ }
  try {
    const codexEnvArgs = ["--env", `CHOMP_PORT=${process.env.PORT ?? "3001"}`, "--env", "CHOMP_HOST=127.0.0.1"];
    if (process.env.CHOMP_MCP_SECRET) {
      codexEnvArgs.push("--env", `CHOMP_MCP_SECRET=${process.env.CHOMP_MCP_SECRET}`);
    }
    execFileSync("codex", ["mcp", "add", "chomp-api", ...codexEnvArgs, "--", "node", bridgePath], {
      stdio: "ignore",
    });
  } catch (err) {
    console.warn("[mcp-sync] Failed to register chomp-api with Codex:", err instanceof Error ? err.message : err);
  }

  // Add all enabled MCP servers from DB
  const servers = db.select().from(mcpServers).all().filter((s) => s.enabled);
  for (const server of servers) {
    const name = `chomp-${server.name}`;
    const config = JSON.parse(server.config) as Record<string, unknown>;

    try {
      execFileSync("claude", ["mcp", "remove", "-s", "user", name], { stdio: "ignore" });
    } catch { /* fine */ }

    // Note: -e (variadic) must come AFTER the server name, otherwise it consumes it
    const args = ["mcp", "add", "-s", "user", name];
    if (config.env && typeof config.env === "object") {
      for (const [k, v] of Object.entries(config.env as Record<string, string>)) {
        args.push("-e", `${k}=${v}`);
      }
    }
    args.push("--", String(config.command ?? "node"), ...((config.args as string[]) ?? []));

    try {
      execFileSync("claude", args, {
        stdio: "ignore",
        env: { ...process.env, CLAUDECODE: undefined },
      });
    } catch (err) {
      console.warn(`[mcp-sync] Failed to register ${name}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Parse a `claude mcp add` command string and execute it.
 * Also saves to the DB mcpServers table for UI display.
 */
export function parseAndRunMcpAdd(command: string): { name: string; success: boolean; error?: string } {
  // Normalize: strip leading "claude " if present
  let cmd = command.trim();
  if (cmd.startsWith("claude ")) cmd = cmd.slice(7);
  if (!cmd.startsWith("mcp add")) {
    return { name: "", success: false, error: "Command must start with 'claude mcp add'" };
  }

  // Parse the command into args
  const parts = shellSplit(cmd);
  // parts[0] = "mcp", parts[1] = "add", rest = options + name + command + args

  const cliArgs = parts.slice(2); // after "mcp add"
  let scope = "user";
  const envVars: Record<string, string> = {};
  let transport: string | undefined;
  let serverName = "";
  let serverCommand = "";
  const serverArgs: string[] = [];

  let i = 0;
  // Parse options
  while (i < cliArgs.length) {
    const arg = cliArgs[i];
    if (arg === "-s" || arg === "--scope") {
      scope = cliArgs[++i] ?? "user";
    } else if (arg === "-e" || arg === "--env") {
      const envVal = cliArgs[++i] ?? "";
      const eqIdx = envVal.indexOf("=");
      if (eqIdx > 0) envVars[envVal.slice(0, eqIdx)] = envVal.slice(eqIdx + 1);
    } else if (arg === "--transport") {
      transport = cliArgs[++i] ?? "stdio";
    } else if (arg === "--header") {
      i++; // skip header value, will be passed through
    } else if (!arg.startsWith("-")) {
      // Positional args: name, then command/url, then args
      if (!serverName) {
        serverName = arg;
      } else if (!serverCommand) {
        serverCommand = arg;
      } else {
        serverArgs.push(arg);
      }
    }
    i++;
  }

  if (!serverName) {
    return { name: "", success: false, error: "Could not parse server name from command" };
  }

  // Execute the full claude command
  try {
    const fullArgs = ["mcp", "add", ...cliArgs];
    execFileSync("claude", fullArgs, {
      stdio: "ignore",
      env: { ...process.env, CLAUDECODE: undefined },
    });
  } catch (err) {
    return { name: serverName, success: false, error: err instanceof Error ? err.message : "Command failed" };
  }

  // Save to DB
  const existing = db.select().from(mcpServers).all().find((s) => s.name === serverName);
  if (!existing) {
    const config: Record<string, unknown> = {};
    if (transport === "http" || serverCommand.startsWith("http")) {
      config.type = "http";
      config.url = serverCommand;
    } else {
      config.type = "stdio";
      config.command = serverCommand;
      config.args = serverArgs;
    }
    if (Object.keys(envVars).length > 0) config.env = envVars;

    const now = new Date().toISOString();
    db.insert(mcpServers).values({
      id: randomUUID(),
      name: serverName,
      description: `Added via paste: ${command.slice(0, 80)}`,
      config: JSON.stringify(config),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  return { name: serverName, success: true };
}

/** Read registered MCP servers directly from ~/.claude.json */
function readClaudeJsonServers(): Record<string, Record<string, unknown>> {
  try {
    const claudeJsonPath = join(homedir(), ".claude.json");
    const raw = readFileSync(claudeJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mcpServersRaw = parsed.mcpServers ?? (parsed as Record<string, unknown>).projects;
    if (mcpServersRaw && typeof mcpServersRaw === "object" && !Array.isArray(mcpServersRaw)) {
      return mcpServersRaw as Record<string, Record<string, unknown>>;
    }
  } catch { /* file may not exist or be malformed */ }
  return {};
}

/** Get live status for all MCP servers via `claude mcp list` CLI */
export function getMcpLiveStatus(): Array<{ name: string; status: string }> {
  try {
    const output = execFileSync("claude", ["mcp", "list"], {
      encoding: "utf-8",
      // Run from home dir so project-scoped servers relative to ~ are included
      cwd: homedir(),
      env: { ...process.env, CLAUDECODE: undefined },
      timeout: 15000,
    });

    const results: Array<{ name: string; status: string }> = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Checking")) continue;
      // Format: "name: command/url - ✓ Connected" etc.
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx < 0) continue;
      const name = trimmed.slice(0, colonIdx).trim();
      const rest = trimmed.slice(colonIdx + 1);
      let status = "registered";
      if (rest.includes("✓") || rest.includes("Connected")) status = "connected";
      else if (rest.includes("✗") || rest.includes("Failed")) status = "error";
      else if (rest.includes("!") || rest.includes("authentication")) status = "needs-auth";
      results.push({ name, status });
    }
    return results;
  } catch {
    // Fall back to reading ~/.claude.json directly
    const servers = readClaudeJsonServers();
    return Object.keys(servers).map((name) => ({ name, status: "registered" }));
  }
}

/** Import MCP servers from Claude Desktop config */
export function importFromClaudeDesktop(): { imported: number; error?: string } {
  // Snapshot existing names before import
  const before = new Set(Object.keys(readClaudeJsonServers()));

  try {
    execFileSync("claude", ["mcp", "add-from-claude-desktop"], {
      stdio: "ignore",
      env: { ...process.env, CLAUDECODE: undefined },
    });
  } catch (err) {
    return { imported: 0, error: err instanceof Error ? err.message : "Import failed" };
  }

  // Read what was actually added
  const after = readClaudeJsonServers();
  const newNames = Object.keys(after).filter((n) => !before.has(n));

  // Sync newly imported servers into DB (skip chomp-prefixed ones we manage)
  const now = new Date().toISOString();
  let imported = 0;
  for (const name of newNames) {
    if (name.startsWith("chomp-")) continue;
    const existing = db.select().from(mcpServers).all().find((s) => s.name === name);
    if (existing) continue;

    const serverConfig = after[name] as Record<string, unknown>;
    const config: Record<string, unknown> = {};
    if (serverConfig.type === "http" || typeof serverConfig.url === "string") {
      config.type = "http";
      config.url = serverConfig.url;
    } else {
      config.type = "stdio";
      config.command = serverConfig.command;
      config.args = serverConfig.args ?? [];
    }
    if (serverConfig.env) config.env = serverConfig.env;

    db.insert(mcpServers).values({
      id: randomUUID(),
      name,
      description: `Imported from Claude Desktop`,
      config: JSON.stringify(config),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run();
    imported++;
  }

  return { imported };
}

/**
 * Sync skills from ~/.claude/skills/ to ~/.codex/skills/ via symlinks.
 * Both CLIs use identical SKILL.md format, so symlinking works perfectly.
 * Skips skills that already exist in the target directory.
 */
export function syncSkillsToCodex() {
  if (process.env.CHOMP_SKIP_MCP_SYNC === "1") return;
  const claudeSkills = join(homedir(), ".claude", "skills");
  const codexSkills = join(homedir(), ".codex", "skills");

  if (!existsSync(claudeSkills)) return;

  mkdirSync(codexSkills, { recursive: true });

  let synced = 0;
  try {
    const skills = readdirSync(claudeSkills, { withFileTypes: true });
    for (const entry of skills) {
      if (!entry.isDirectory()) continue;
      const target = join(codexSkills, entry.name);
      // Skip if already exists (either a real dir or an existing symlink)
      if (existsSync(target)) continue;
      try {
        symlinkSync(join(claudeSkills, entry.name), target);
        synced++;
      } catch { /* permission error or race condition — skip */ }
    }
  } catch (err) {
    console.warn("[skill-sync] Failed to sync Claude skills to Codex:", err instanceof Error ? err.message : err);
    return;
  }

  if (synced > 0) {
    console.log(`[skill-sync] Synced ${synced} skills from Claude to Codex`);
  }
}

/** Simple shell argument splitting (handles quotes) */
function shellSplit(str: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (c === " " && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += c;
    }
  }
  if (current) args.push(current);
  return args;
}
