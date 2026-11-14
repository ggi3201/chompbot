/**
 * Site publishing tool implementation.
 * Manages published sites: HTML on disk, served by Chomp under /pub or by your own web server at PREVIEW_DOMAIN.
 *
 * Config: PREVIEW_SITES_DIR (default ~/preview-sites), PREVIEW_DOMAIN (optional)
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { db } from "../../db/index.js";
import { publishedSites } from "../../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  commitAndPushSiteChange,
  formatGitBlock,
  formatGitSummary,
  getSiteDir,
  getSiteGitInfo,
  getSiteSource,
  isSiteParked,
  parkSite,
  renameSiteDir,
  syncSiteGitMetadata,
  unparkSite,
} from "./site-git.js";

/**
 * With PREVIEW_DOMAIN, a web server of your own serves the sites folder there. Without one, Chomp serves it
 * itself under /pub on its own address (CHOMP_DOMAIN), so publishing works with no setup.
 */
export function getSiteUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.PREVIEW_DOMAIN) return `https://${env.PREVIEW_DOMAIN}/${slug}`;
  const base = env.CHOMP_DOMAIN || `http://localhost:${env.PORT ?? "3001"}`;
  return `${base.replace(/\/+$/, "")}/pub/${slug}/`;
}

export function getQrUrl(siteUrl: string, size = 300): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(siteUrl)}&bgcolor=06040e&color=a78bfa`;
}

/**
 * Write a site's HTML to disk. If password is set, wraps content in an auth gate.
 */
export function publishToDisk(
  slug: string,
  htmlContent: string,
  password?: string,
): void {
  const dir = getSiteDir(slug);
  mkdirSync(dir, { recursive: true });

  const finalHtml = password
    ? wrapWithAuthGate(htmlContent, password, slug)
    : htmlContent;

  writeFileSync(join(dir, "index.html"), finalHtml, "utf-8");
}

/**
 * Remove a site's files from disk.
 */
export function unpublishFromDisk(slug: string): void {
  const dir = getSiteDir(slug);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Take a site offline. Only a git site has files worth keeping; the DB holds the rest. */
export function takeSiteOffline(site: { source?: string | null; slug: string }): void {
  if (getSiteSource(site) === "git") parkSite(site.slug);
  else unpublishFromDisk(site.slug);
}

function wrapWithAuthGate(
  htmlContent: string,
  password: string,
  title: string,
): string {
  const passwordHash = createHash("sha256").update(password).digest("hex");
  const encodedContent = Buffer.from(htmlContent).toString("base64");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #06040e; color: #fff; }
    .gate { text-align: center; max-width: 360px; width: 90%; }
    .gate h2 { font-size: 1.4rem; margin-bottom: 0.5rem; color: #a78bfa; }
    .gate p { font-size: 0.85rem; color: rgba(255,255,255,0.5); margin-bottom: 1.5rem; }
    .gate input { width: 100%; padding: 0.75rem 1rem; border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; background: rgba(255,255,255,0.07); color: #fff; font-size: 1rem; outline: none; backdrop-filter: blur(10px); }
    .gate input:focus { border-color: #8b5cf6; }
    .gate button { margin-top: 0.75rem; width: 100%; padding: 0.75rem; border: none; border-radius: 10px; background: linear-gradient(135deg, #8b5cf6, #06b6d4); color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; }
    .gate button:hover { opacity: 0.9; }
    .error { color: #ef4444; font-size: 0.8rem; margin-top: 0.5rem; display: none; }
    #content { display: none; }
  </style>
</head>
<body>
  <div class="gate" id="gate">
    <h2>🔒 Password Required</h2>
    <p>This preview is password-protected.</p>
    <input type="password" id="pw" placeholder="Enter password" autofocus />
    <button onclick="unlock()">Unlock</button>
    <div class="error" id="err">Incorrect password</div>
  </div>
  <div id="content"></div>
  <script>
    const H='${passwordHash}',E='${encodedContent}';
    async function sha256(s){const e=new TextEncoder().encode(s);const h=await crypto.subtle.digest('SHA-256',e);return[...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('');}
    async function unlock(){
      const pw=document.getElementById('pw').value;
      const h=await sha256(pw);
      if(h===H){
        sessionStorage.setItem('preview_auth_${passwordHash.slice(0, 8)}','1');
        show();
      } else {
        document.getElementById('err').style.display='block';
      }
    }
    function show(){
      document.getElementById('gate').style.display='none';
      const d=document.getElementById('content');
      d.style.display='block';
      const bytes=Uint8Array.from(atob(E),c=>c.charCodeAt(0));
      d.innerHTML=new TextDecoder('utf-8').decode(bytes);
      // Execute any scripts in the decoded content
      d.querySelectorAll('script').forEach(s=>{const n=document.createElement('script');n.textContent=s.textContent;s.replaceWith(n);});
    }
    document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')unlock();});
    if(sessionStorage.getItem('preview_auth_${passwordHash.slice(0, 8)}')==='1')show();
  </script>
</body>
</html>`;
}

// ── MCP tool exec functions ──────────────────────────────────────

export async function execCreateSite(
  title: string,
  htmlContent: string,
  slug?: string,
  description?: string,
  password?: string,
): Promise<string> {
  if (!title) return "ERROR: title is required";
  if (!htmlContent) return "ERROR: htmlContent is required";

  const finalSlug =
    slug ??
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);

  const existing = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.slug, finalSlug))
    .get();
  if (existing) return `ERROR: Slug "${finalSlug}" already exists`;

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

  return `Site created: "${title}" (id: ${id}, slug: ${finalSlug}). Status: draft. Call publish_site to deploy it.`;
}

export async function execListSites(
  limit?: number,
): Promise<string> {
  const maxLimit = Math.min(limit ?? 20, 50);
  const sites = db
    .select()
    .from(publishedSites)
    .orderBy(desc(publishedSites.updatedAt))
    .limit(maxLimit)
    .all();

  if (sites.length === 0) return "No sites found.";

  const lines = sites.map(
    (s) => {
      const git = formatGitSummary(getSiteGitInfo(s.slug));
      const source = getSiteSource(s);
      return `- ${s.title} [${s.status}] slug: ${s.slug} | source: ${source}${git ? ` | ${git}` : ""} | id: ${s.id}${s.url ? ` | ${s.url}` : ""}`;
    },
  );
  return `${sites.length} site(s):\n${lines.join("\n")}`;
}

export async function execGetSite(siteId: string): Promise<string> {
  if (!siteId) return "ERROR: site_id is required";

  const site = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, siteId))
    .get();
  if (!site) return `ERROR: Site not found (id: ${siteId})`;

  return [
    `Title: ${site.title}`,
    `Slug: ${site.slug}`,
    `Status: ${site.status}`,
    `Source: ${getSiteSource(site)}`,
    `Description: ${site.description || "(none)"}`,
    `URL: ${site.url || "(not published)"}`,
    `Password: ${site.password ? "set" : "none"}`,
    `Created: ${site.createdAt}`,
    `Published: ${site.publishedAt || "never"}`,
    `---`,
    ...formatGitBlock(getSiteGitInfo(site.slug)),
    `---`,
    `HTML Content Cache (first 500 chars):`,
    site.htmlContent.slice(0, 500),
  ].join("\n");
}

export async function execUpdateSite(
  siteId: string,
  title?: string,
  htmlContent?: string,
  description?: string,
  password?: string,
  slug?: string,
  skipGit?: boolean,
): Promise<string> {
  if (!siteId) return "ERROR: site_id is required";

  const site = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, siteId))
    .get();
  if (!site) return `ERROR: Site not found (id: ${siteId})`;

  if (slug !== undefined && slug !== site.slug) {
    const slugExists = db
      .select()
      .from(publishedSites)
      .where(eq(publishedSites.slug, slug))
      .get();
    if (slugExists) return `ERROR: Slug "${slug}" already exists`;
  }

  const source = getSiteSource(site);
  const next = {
    title: title ?? site.title,
    htmlContent: htmlContent ?? site.htmlContent,
    description: description ?? site.description,
    password: password !== undefined ? password || null : site.password,
    slug: slug ?? site.slug,
  };

  if (source === "git") {
    if (slug !== undefined && slug !== site.slug) {
      renameSiteDir(site.slug, next.slug);
    }

    if (site.status === "published" || isSiteParked(next.slug)) {
      publishToDisk(next.slug, next.htmlContent, next.password ?? undefined);
    }

    let gitMessage = "";
    if (!skipGit) {
      const gitResult = commitAndPushSiteChange(next.slug, next.title);
      if (gitResult.committed) {
        gitMessage = gitResult.pushed
          ? ` Committed and pushed: ${gitResult.sha} ${gitResult.subject}.`
          : ` Committed locally: ${gitResult.sha} ${gitResult.subject}.`;
        if (gitResult.warning) gitMessage += ` Push warning: ${gitResult.warning}`;
      }
    }

    db.update(publishedSites)
      .set({
        title: next.title,
        htmlContent: next.htmlContent,
        description: next.description,
        password: next.password,
        slug: next.slug,
        source: "git",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(publishedSites.id, siteId))
      .run();
    syncSiteGitMetadata(siteId, next.slug);

    return `Site updated: "${next.title}" (slug: ${next.slug})${site.status === "published" ? " — deployed from git source" : ""}.${gitMessage}`;
  }

  db.update(publishedSites)
    .set({
      ...(title !== undefined && { title }),
      ...(htmlContent !== undefined && { htmlContent }),
      ...(description !== undefined && { description }),
      ...(password !== undefined && { password: password || null }),
      ...(slug !== undefined && { slug }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(publishedSites.id, siteId))
    .run();

  // If site is published and content/password/slug changed, re-publish
  const updated = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, siteId))
    .get()!;
  if (updated.status === "published") {
    if (slug !== undefined && slug !== site.slug) {
      const oldDir = getSiteDir(site.slug);
      const newDir = getSiteDir(updated.slug);
      if (getSiteGitInfo(site.slug).tracked && existsSync(oldDir)) {
        renameSync(oldDir, newDir);
      } else {
        unpublishFromDisk(site.slug);
      }
    }
    publishToDisk(
      updated.slug,
      updated.htmlContent,
      updated.password ?? undefined,
    );
  }

  let gitMessage = "";
  if (updated.status === "published" && !skipGit) {
    const gitResult = commitAndPushSiteChange(updated.slug, updated.title);
    if (gitResult.committed) {
      gitMessage = gitResult.pushed
        ? ` Committed and pushed: ${gitResult.sha} ${gitResult.subject}.`
        : ` Committed locally: ${gitResult.sha} ${gitResult.subject}.`;
      if (gitResult.warning) gitMessage += ` Push warning: ${gitResult.warning}`;
    }
  }

  return `Site updated: "${updated.title}" (slug: ${updated.slug})${updated.status === "published" ? " — re-published to disk" : ""}.${gitMessage}`;
}

export async function execDeleteSite(siteId: string): Promise<string> {
  if (!siteId) return "ERROR: site_id is required";

  const site = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, siteId))
    .get();
  if (!site) return `ERROR: Site not found (id: ${siteId})`;

  if (site.status === "published" || isSiteParked(site.slug)) {
    unpublishFromDisk(site.slug);
  }

  db.delete(publishedSites).where(eq(publishedSites.id, siteId)).run();
  return `Deleted site "${site.title}" (slug: ${site.slug})`;
}

export async function execPublishSite(siteId: string): Promise<string> {
  if (!siteId) return "ERROR: site_id is required";

  const site = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, siteId))
    .get();
  if (!site) return `ERROR: Site not found (id: ${siteId})`;

  try {
    if (!unparkSite(site.slug)) {
      publishToDisk(site.slug, site.htmlContent, site.password ?? undefined);
    }
  } catch (e) {
    return `ERROR: Failed to write files: ${(e as Error).message}`;
  }

  const url = getSiteUrl(site.slug);
  const now = new Date().toISOString();
  const source = getSiteSource(site);
  db.update(publishedSites)
    .set({
      status: "published",
      url,
      publishedAt: now,
      updatedAt: now,
      ...(source === "git" && { source: "git" }),
    })
    .where(eq(publishedSites.id, site.id))
    .run();
  if (source === "git") syncSiteGitMetadata(site.id, site.slug);

  const qrUrl = getQrUrl(url);
  return [
    `✅ Site published!`,
    ``,
    `🔗 URL: ${url}`,
    `📱 QR Code: ${qrUrl}`,
    `${site.password ? "🔒 Password-protected" : "🌐 Public"}`,
    ``,
    `Share the URL or QR code — it's live now.`,
  ].join("\n");
}

export async function execUnpublishSite(siteId: string): Promise<string> {
  if (!siteId) return "ERROR: site_id is required";

  const site = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, siteId))
    .get();
  if (!site) return `ERROR: Site not found (id: ${siteId})`;

  takeSiteOffline(site);

  const now = new Date().toISOString();
  db.update(publishedSites)
    .set({ status: "draft", url: null, updatedAt: now })
    .where(eq(publishedSites.id, site.id))
    .run();

  return `Site "${site.title}" unpublished and taken offline.`;
}
