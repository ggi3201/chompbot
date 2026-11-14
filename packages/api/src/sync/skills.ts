import { mkdirSync, writeFileSync, unlinkSync, existsSync, rmdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const SKILLS_DIR = join(homedir(), ".claude", "skills");

function ensureDir() {
  mkdirSync(SKILLS_DIR, { recursive: true });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface SkillRow {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
}

/** Write a skill file to ~/.claude/skills/<slug>/SKILL.md */
export function syncSkill(skill: SkillRow) {
  // A test API must not overwrite the real skills in this machine's home directory.
  if (process.env.CHOMP_SKIP_MCP_SYNC === "1") return;
  ensureDir();
  const slug = slugify(skill.name);
  const skillDir = join(SKILLS_DIR, slug);
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, "SKILL.md");

  if (!skill.enabled) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return;
  }

  const frontmatter = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `chomp-managed: true`,
    "---",
    "",
  ].join("\n");

  writeFileSync(filePath, frontmatter + skill.content, "utf-8");
}

/** Remove a skill from ~/.claude/skills/ */
export function removeSkillFile(name: string) {
  if (process.env.CHOMP_SKIP_MCP_SYNC === "1") return;
  const slug = slugify(name);
  // Remove new format (directory)
  const dirPath = join(SKILLS_DIR, slug);
  if (existsSync(join(dirPath, "SKILL.md"))) {
    unlinkSync(join(dirPath, "SKILL.md"));
    try { rmdirSync(dirPath); } catch { /* dir not empty, leave it */ }
  }
  // Remove old flat format
  const flatPath = join(SKILLS_DIR, `${slug}.md`);
  if (existsSync(flatPath)) {
    unlinkSync(flatPath);
  }
}
