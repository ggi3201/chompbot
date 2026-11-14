import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { proactiveRules } from "../../src/db/schema.js";
import { seedDefaults } from "../../src/seed.js";

const TEMPLATES = [
  "Memory dream: weekly transcript review (Sun 20:00)",
  "Memory review — fresh auto memories (weekly, gated)",
  "Skill review (monthly, own skills)",
  "Tailscale key-expiry watch (weekly)",
];
const byName = (name: string) => db.select().from(proactiveRules).where(eq(proactiveRules.name, name)).all();

beforeEach(() => {
  db.delete(proactiveRules).run();
});

test("a fresh install gets the maintenance rules once, switched off", () => {
  seedDefaults();
  seedDefaults();
  for (const name of TEMPLATES) {
    const rows = byName(name);
    expect(rows, name).toHaveLength(1);
    expect(rows[0].enabled, name).toBe(false);
  }
});

test("the user's own rule with the same name is never overwritten", () => {
  const now = new Date().toISOString();
  db.insert(proactiveRules).values({
    id: "mine", name: TEMPLATES[3], triggerType: "periodic", condition: "{}", actionType: "run_agent",
    actionConfig: JSON.stringify({ prompt: "my own version" }), enabled: true, cooldownMinutes: 60, activeHours: "{}", priority: 0, createdAt: now, updatedAt: now,
  }).run();
  seedDefaults();
  const rows = byName(TEMPLATES[3]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: "mine", enabled: true, condition: "{}", actionConfig: JSON.stringify({ prompt: "my own version" }) });
});
