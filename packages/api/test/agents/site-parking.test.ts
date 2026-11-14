import { beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";

const { SITES, PARKED } = vi.hoisted(() => {
  const SITES = `/tmp/chomp-sites-${process.pid}-${Date.now()}`;
  process.env.PREVIEW_SITES_DIR = SITES;
  return { SITES, PARKED: `${SITES}-parked` };
});

import { db } from "../../src/db/index.js";
import { publishedSites } from "../../src/db/schema.js";
import {
  execDeleteSite,
  execPublishSite,
  execUnpublishSite,
  execUpdateSite,
} from "../../src/agents/tools/sites.js";

const row = (id: string) =>
  db.select().from(publishedSites).where(eq(publishedSites.id, id)).get()!;

function makeSite(slug: string, tracked: boolean): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(publishedSites)
    .values({ id, slug, title: slug, htmlContent: "<h1>db</h1>", status: "published", createdAt: now, updatedAt: now })
    .run();
  const dir = join(SITES, slug);
  mkdirSync(join(dir, "img"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<h1>disk</h1>");
  writeFileSync(join(dir, "img", "hero.jpg"), "jpg");
  if (tracked) {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "init");
  }
  return id;
}

describe("unpublishing a git-source site", () => {
  beforeEach(() => {
    db.delete(publishedSites).run();
    rmSync(SITES, { recursive: true, force: true });
    rmSync(PARKED, { recursive: true, force: true });
  });

  test("goes offline with repo and assets intact, and comes back untouched", async () => {
    const id = makeSite("g", true);

    expect(await execUnpublishSite(id)).not.toMatch(/^ERROR/);
    expect(existsSync(join(SITES, "g"))).toBe(false);
    expect(existsSync(join(PARKED, "g", ".git"))).toBe(true);
    expect(row(id).status).toBe("draft");

    expect(await execPublishSite(id)).not.toMatch(/^ERROR/);
    expect(existsSync(join(PARKED, "g"))).toBe(false);
    expect(existsSync(join(SITES, "g", "img", "hero.jpg"))).toBe(true);
    // The repo's file wins over the DB copy, so a toggle cannot dirty the repo.
    expect(readFileSync(join(SITES, "g", "index.html"), "utf-8")).toBe("<h1>disk</h1>");
    expect(row(id).status).toBe("published");
  });

  test("edits and renames while offline stay offline but reach the files", async () => {
    const id = makeSite("g", true);
    await execUnpublishSite(id);

    await execUpdateSite(id, undefined, "<h1>new</h1>", undefined, undefined, "g2", true);

    expect(existsSync(join(SITES, "g2"))).toBe(false);
    expect(readFileSync(join(PARKED, "g2", "index.html"), "utf-8")).toBe("<h1>new</h1>");
  });

  test("deleting a parked site removes its files", async () => {
    const id = makeSite("g", true);
    await execUnpublishSite(id);

    await execDeleteSite(id);

    expect(existsSync(join(PARKED, "g"))).toBe(false);
  });

  test("a DB-source site is still just removed", async () => {
    const id = makeSite("d", false);

    await execUnpublishSite(id);

    expect(existsSync(join(SITES, "d"))).toBe(false);
    expect(existsSync(join(PARKED, "d"))).toBe(false);
  });
});
