import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { db } from "../db/index.js";
import { skills, mcpServers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const CLAUDE_DIR = join(homedir(), ".claude");
const SKILLS_DIR = join(CLAUDE_DIR, "skills");
const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");

interface ParsedFrontmatter {
  name: string;
  description: string;
  content: string;
  chompManaged: boolean;
}

/** The folded text of a YAML `>` or `|` value: the indented lines right after its key. */
function readBlockScalar(lines: string[]): string {
  const end = lines.findIndex((line) => line.trim() && !/^\s/.test(line));
  return lines.slice(0, end === -1 ? undefined : end).map((line) => line.trim()).filter(Boolean).join(" ");
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { name: "", description: "", content: raw, chompManaged: false };
  }

  const frontmatter = match[1];
  const content = match[2].trim();

  let name = "";
  let description = "";
  let chompManaged = false;
  const lines = frontmatter.split("\n");
  for (const [i, line] of lines.entries()) {
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) {
      const value = descMatch[1].trim();
      description = /^[>|][-+]?$/.test(value)
        ? readBlockScalar(lines.slice(i + 1))
        : value.replace(/^["']|["']$/g, "");
    }
    if (line.match(/^chomp-managed:\s*true/)) chompManaged = true;
  }

  return { name, description, content, chompManaged };
}

export interface ImportResult {
  skills: { imported: number; updated: number; skipped: number };
  mcpServers: { imported: number; updated: number; skipped: number };
}

export function importFromFilesystem(): ImportResult {
  return {
    skills: importSkills(),
    mcpServers: importMcpServers(),
  };
}

/** Legacy export for backward compat */
export function importSkillsFromFilesystem() {
  return importSkills();
}

export function importSkills(): { imported: number; updated: number; skipped: number } {
  if (!existsSync(SKILLS_DIR)) {
    return { imported: 0, updated: 0, skipped: 0 };
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    let skillPath: string;

    if (entry.isDirectory()) {
      skillPath = join(SKILLS_DIR, entry.name, "SKILL.md");
    } else if (entry.name.endsWith(".md")) {
      skillPath = join(SKILLS_DIR, entry.name);
    } else {
      continue;
    }

    if (!existsSync(skillPath)) {
      skipped++;
      continue;
    }

    const raw = readFileSync(skillPath, "utf-8");
    const parsed = parseFrontmatter(raw);

    if (!parsed.name) {
      parsed.name = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/, "");
    }

    // chomp-managed → "user", everything else → "marketplace"
    const source = parsed.chompManaged ? "user" : "marketplace";

    const existing = db
      .select()
      .from(skills)
      .all()
      .find((s) => s.name.toLowerCase() === parsed.name.toLowerCase());

    const now = new Date().toISOString();

    if (existing) {
      db.update(skills)
        .set({
          description: parsed.description || existing.description,
          content: parsed.content,
          source,
          updatedAt: now,
        })
        .where(eq(skills.id, existing.id))
        .run();
      updated++;
    } else {
      db.insert(skills)
        .values({
          id: randomUUID(),
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          source,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      imported++;
    }
  }

  return { imported, updated, skipped };
}

function importMcpServers(): { imported: number; updated: number; skipped: number } {
  if (!existsSync(CLAUDE_JSON_PATH)) {
    return { imported: 0, updated: 0, skipped: 0 };
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  try {
    const claudeJson = JSON.parse(readFileSync(CLAUDE_JSON_PATH, "utf-8"));
    const servers = claudeJson.mcpServers as Record<string, unknown> | undefined;
    if (!servers) return { imported, updated, skipped };

    for (const [name, config] of Object.entries(servers)) {
      // Skip chomp-managed entries (we created those via push)
      if (name.startsWith("chomp-") || name.startsWith("chomp-svc:")) {
        skipped++;
        continue;
      }

      const existing = db
        .select()
        .from(mcpServers)
        .all()
        .find((s) => s.name.toLowerCase() === name.toLowerCase());

      const now = new Date().toISOString();

      if (existing) {
        db.update(mcpServers)
          .set({
            config: JSON.stringify(config),
            updatedAt: now,
          })
          .where(eq(mcpServers.id, existing.id))
          .run();
        updated++;
      } else {
        db.insert(mcpServers)
          .values({
            id: randomUUID(),
            name,
            description: `Imported from ~/.claude.json`,
            config: JSON.stringify(config),
            enabled: true,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        imported++;
      }
    }
  } catch {
    // malformed .claude.json
  }

  return { imported, updated, skipped };
}

