import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { publishedSites } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  commitAndPushSiteChange,
  getSiteGitInfo,
  getSiteSource,
  isSiteParked,
  renameSiteDir,
  syncSiteGitMetadata,
  unparkSite,
} from "../agents/tools/site-git.js";

const router: ReturnType<typeof Router> = Router();

function withGitInfo<T extends { slug: string; source?: string }>(site: T) {
  return { ...site, source: getSiteSource(site), git: getSiteGitInfo(site.slug) };
}

// List all sites
router.get("/", (_req: Request, res: Response) => {
  const result = db
    .select()
    .from(publishedSites)
    .orderBy(desc(publishedSites.updatedAt))
    .all();
  res.json(result.map(withGitInfo));
});

// Get one site
router.get("/:id", (req: Request, res: Response) => {
  const result = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, req.params.id as string))
    .get();
  if (!result) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  res.json(withGitInfo(result));
});

// Create site
router.post("/", (req: Request, res: Response) => {
  const { title, slug, description, htmlContent, password } = req.body;
  if (!title || !htmlContent) {
    res.status(400).json({ error: "title and htmlContent are required" });
    return;
  }

  const finalSlug =
    slug ??
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);

  // Check slug uniqueness
  const existing = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.slug, finalSlug))
    .get();
  if (existing) {
    res.status(409).json({ error: `Slug "${finalSlug}" already exists` });
    return;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(publishedSites)
    .values({
      id,
      slug: finalSlug,
      title,
      description: description ?? "",
      htmlContent,
      password: password ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const created = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, id))
    .get()!;
  res.status(201).json(withGitInfo(created));
});

// Update site
router.put("/:id", async (req: Request, res: Response) => {
  const existing = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, req.params.id as string))
    .get();
  if (!existing) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const { title, slug, description, htmlContent, password, status, skipGit } = req.body;

  // If slug is changing, check uniqueness
  if (slug !== undefined && slug !== existing.slug) {
    const slugExists = db
      .select()
      .from(publishedSites)
      .where(eq(publishedSites.slug, slug))
      .get();
    if (slugExists) {
      res.status(409).json({ error: `Slug "${slug}" already exists` });
      return;
    }
  }

  const source = getSiteSource(existing);
  const next = {
    title: title ?? existing.title,
    slug: slug ?? existing.slug,
    description: description ?? existing.description,
    htmlContent: htmlContent ?? existing.htmlContent,
    password: password !== undefined ? password || null : existing.password,
    status: status ?? existing.status,
  };

  if (source === "git") {
    try {
      const { publishToDisk } = await import("../agents/tools/sites.js");
      if (slug !== undefined && slug !== existing.slug) {
        renameSiteDir(existing.slug, next.slug);
      }
      if (next.status === "published" || isSiteParked(next.slug)) {
        publishToDisk(next.slug, next.htmlContent, next.password ?? undefined);
      }
      if (!skipGit) commitAndPushSiteChange(next.slug, next.title);
    } catch (e) {
      res
        .status(500)
        .json({ error: e instanceof Error ? e.message : "Update publish failed" });
      return;
    }

    db.update(publishedSites)
      .set({
        title: next.title,
        slug: next.slug,
        description: next.description,
        htmlContent: next.htmlContent,
        password: next.password,
        status: next.status,
        source: "git",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(publishedSites.id, req.params.id as string))
      .run();
    syncSiteGitMetadata(req.params.id as string, next.slug);

    const updated = db
      .select()
      .from(publishedSites)
      .where(eq(publishedSites.id, req.params.id as string))
      .get()!;
    res.json(withGitInfo(updated));
    return;
  }

  db.update(publishedSites)
    .set({
      ...(title !== undefined && { title }),
      ...(slug !== undefined && { slug }),
      ...(description !== undefined && { description }),
      ...(htmlContent !== undefined && { htmlContent }),
      ...(password !== undefined && { password: password || null }),
      ...(status !== undefined && { status }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(publishedSites.id, req.params.id as string))
    .run();

  const updated = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, req.params.id as string))
    .get()!;

  if (updated.status === "published") {
    try {
      const { publishToDisk, unpublishFromDisk } = await import(
        "../agents/tools/sites.js"
      );
      if (slug !== undefined && slug !== existing.slug) {
        unpublishFromDisk(existing.slug);
      }
      publishToDisk(
        updated.slug,
        updated.htmlContent,
        updated.password ?? undefined,
      );
    } catch (e) {
      res
        .status(500)
        .json({ error: e instanceof Error ? e.message : "Update publish failed" });
      return;
    }
  }

  res.json(withGitInfo(updated));
});

// Delete site
router.delete("/:id", async (req: Request, res: Response) => {
  const existing = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, req.params.id as string))
    .get();
  if (!existing) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  // Remove files from disk if published or parked
  if (existing.status === "published" || isSiteParked(existing.slug)) {
    try {
      const { unpublishFromDisk } = await import("../agents/tools/sites.js");
      unpublishFromDisk(existing.slug);
    } catch {
      // Best-effort cleanup
    }
  }

  db.delete(publishedSites)
    .where(eq(publishedSites.id, req.params.id as string))
    .run();
  res.status(204).send();
});

// Publish site (write to disk)
router.post("/:id/publish", async (req: Request, res: Response) => {
  const site = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, req.params.id as string))
    .get();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  try {
    const { publishToDisk, getSiteUrl } = await import(
      "../agents/tools/sites.js"
    );
    if (!unparkSite(site.slug)) {
      publishToDisk(site.slug, site.htmlContent, site.password ?? undefined);
    }
    const url = getSiteUrl(site.slug);

    const now = new Date().toISOString();
    db.update(publishedSites)
      .set({
        status: "published",
        url,
        publishedAt: now,
        updatedAt: now,
        ...(getSiteSource(site) === "git" && { source: "git" }),
      })
      .where(eq(publishedSites.id, site.id))
      .run();
    if (getSiteSource(site) === "git") syncSiteGitMetadata(site.id, site.slug);

    const updated = db
      .select()
      .from(publishedSites)
      .where(eq(publishedSites.id, site.id))
      .get()!;
    res.json(withGitInfo(updated));
  } catch (e) {
    res
      .status(500)
      .json({ error: e instanceof Error ? e.message : "Publish failed" });
  }
});

// Unpublish site (take offline)
router.post("/:id/unpublish", async (req: Request, res: Response) => {
  const site = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, req.params.id as string))
    .get();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  try {
    const { takeSiteOffline } = await import("../agents/tools/sites.js");
    takeSiteOffline(site);

    const now = new Date().toISOString();
    db.update(publishedSites)
      .set({ status: "draft", url: null, updatedAt: now })
      .where(eq(publishedSites.id, site.id))
      .run();

    const updated = db
      .select()
      .from(publishedSites)
      .where(eq(publishedSites.id, site.id))
      .get()!;
    res.json(withGitInfo(updated));
  } catch (e) {
    res
      .status(500)
      .json({ error: e instanceof Error ? e.message : "Unpublish failed" });
  }
});

// Track site in git
router.post("/:id/git/track", async (req: Request, res: Response) => {
  try {
    const { execTrackSiteInGit } = await import("../agents/tools/site-git.js");
    const result = await execTrackSiteInGit(req.params.id as string, {
      private: req.body.private,
      repoName: req.body.repoName,
      inviteCollaborator:
        req.body.inviteCollaborator === null
          ? null
          : req.body.inviteCollaborator,
    });
    if (result.startsWith("ERROR:")) {
      res.status(400).json({ error: result.replace(/^ERROR:\s*/, "") });
      return;
    }
    res.json({ message: result });
  } catch (e) {
    res
      .status(500)
      .json({ error: e instanceof Error ? e.message : "Track git failed" });
  }
});

// Untrack site from git
router.post("/:id/git/untrack", async (req: Request, res: Response) => {
  try {
    const { execUntrackSiteFromGit } = await import("../agents/tools/site-git.js");
    const result = await execUntrackSiteFromGit(req.params.id as string, {
      deleteRemote: req.body.deleteRemote,
    });
    if (result.startsWith("ERROR:")) {
      res.status(400).json({ error: result.replace(/^ERROR:\s*/, "") });
      return;
    }
    res.json({ message: result });
  } catch (e) {
    res
      .status(500)
      .json({ error: e instanceof Error ? e.message : "Untrack git failed" });
  }
});

// QR code for a site
router.get("/:id/qr", (req: Request, res: Response) => {
  const site = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, req.params.id as string))
    .get();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  if (!site.url) {
    res.status(400).json({ error: "Site is not published yet" });
    return;
  }

  const size = parseInt((req.query.size as string) ?? "300", 10);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(site.url)}&bgcolor=06040e&color=a78bfa`;
  res.json({ url: site.url, qrImageUrl: qrUrl });
});

export default router;
