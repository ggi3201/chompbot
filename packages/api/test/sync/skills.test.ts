import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

let home: string;
const skillFile = () => join(home, ".claude", "skills", "demo", "SKILL.md");
const demo = { name: "demo", description: "d", content: "c", enabled: true };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chomp-skills-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test("writes the skill file", async () => {
  vi.stubEnv("CHOMP_SKIP_MCP_SYNC", "");
  const { syncSkill } = await import("../../src/sync/skills.js");
  syncSkill(demo);
  expect(existsSync(skillFile())).toBe(true);
});

test("a test API leaves the real skills alone", async () => {
  vi.stubEnv("CHOMP_SKIP_MCP_SYNC", "1");
  const { syncSkill, removeSkillFile } = await import("../../src/sync/skills.js");
  syncSkill(demo);
  expect(existsSync(skillFile())).toBe(false);

  vi.stubEnv("CHOMP_SKIP_MCP_SYNC", "");
  syncSkill(demo);
  vi.stubEnv("CHOMP_SKIP_MCP_SYNC", "1");
  removeSkillFile("demo");
  expect(existsSync(skillFile())).toBe(true);
});
