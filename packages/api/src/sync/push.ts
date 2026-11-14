import { db } from "../db/index.js";
import { skills } from "../db/schema.js";
import { syncSkill } from "./skills.js";
import { syncMcpServers } from "./mcp.js";

export function pushAllToFilesystem(): { skills: number; mcpSynced: boolean } {
  // Only push user-created skills — never marketplace/external skills
  const allSkills = db.select().from(skills).all();
  let skillsPushed = 0;
  for (const skill of allSkills) {
    if (skill.source === "user") {
      syncSkill(skill);
      skillsPushed++;
    }
  }

  // Sync MCP servers via CLI
  // Plugins are managed by Claude Code — Chomp only reads, never writes
  syncMcpServers();

  return { skills: skillsPushed, mcpSynced: true };
}
