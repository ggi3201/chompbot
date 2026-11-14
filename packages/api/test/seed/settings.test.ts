import { test, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { settings } from "../../src/db/schema.js";
import { seedDefaultSettings } from "../../src/seed/settings.js";

beforeEach(() => {
  db.delete(settings).run();
});

test("seeds github_issue_repos with an empty array on a fresh database, once however often it runs", () => {
  seedDefaultSettings();
  seedDefaultSettings();

  const rows = db.select().from(settings).where(eq(settings.key, "github_issue_repos")).all();
  expect(rows).toHaveLength(1);
  expect(rows[0].value).toBe("[]");
});

test("does not clobber an existing github_issue_repos value", () => {
  db.insert(settings).values({
    key: "github_issue_repos",
    value: JSON.stringify(["example-org/chomp"]),
  }).run();

  seedDefaultSettings();

  const row = db.select().from(settings).where(eq(settings.key, "github_issue_repos")).get();
  expect(JSON.parse(row!.value)).toEqual(["example-org/chomp"]);
});
