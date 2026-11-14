/**
 * Git tracking helpers for static site previews.
 *
 * Filesystem state is authoritative: a preview site is tracked when its
 * published directory contains a .git directory.
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import { db } from "../../db/index.js";
import { publishedSites } from "../../db/schema.js";
import { eq } from "drizzle-orm";

export const SITES_DIR =
  process.env.PREVIEW_SITES_DIR ?? join(homedir(), "preview-sites");

// Unpublished git sites wait here: outside the nginx root, so they are really
// offline, while the repo and assets (which the DB does not hold) survive.
const PARKED_DIR = `${resolve(SITES_DIR)}-parked`;

const gitAuthorArgs = () => [
  "-c",
  `user.email=${process.env.SITE_GIT_AUTHOR_EMAIL || "chomp@example.invalid"}`,
  "-c",
  `user.name=${process.env.SITE_GIT_AUTHOR_NAME || "Chomp"}`,
] as const;

export type SiteGitInfo =
  | { tracked: false }
  | {
      tracked: true;
      remoteUrl: string | null;
      branch: string;
      dirty: boolean;
      ahead: number;
      behind: number;
      lastCommit: { sha: string; subject: string; date: string } | null;
    };

export interface SiteGitCommitResult {
  committed: boolean;
  pushed: boolean;
  sha?: string;
  subject?: string;
  warning?: string;
}

export function isSiteParked(slug: string): boolean {
  return existsSync(join(PARKED_DIR, slug));
}

export function getSiteDir(slug: string): string {
  return join(isSiteParked(slug) ? PARKED_DIR : SITES_DIR, slug);
}

export function parkSite(slug: string): void {
  const dir = join(SITES_DIR, slug);
  if (!existsSync(dir)) return;
  mkdirSync(PARKED_DIR, { recursive: true });
  renameSync(dir, join(PARKED_DIR, slug));
}

/** Bring a parked site back exactly as it was. False if it was not parked. */
export function unparkSite(slug: string): boolean {
  if (!isSiteParked(slug)) return false;
  renameSync(join(PARKED_DIR, slug), join(SITES_DIR, slug));
  return true;
}

/** Rename a site's folder where it stands, so a parked site stays offline. */
export function renameSiteDir(oldSlug: string, newSlug: string): void {
  const dir = getSiteDir(oldSlug);
  if (existsSync(dir)) renameSync(dir, join(dirname(dir), newSlug));
}

function run(
  command: string,
  args: readonly string[],
  cwd?: string,
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runGit(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]);
}

export function getSiteSource(site: { source?: string | null; slug: string }): "db" | "git" {
  if (site.source === "git") return "git";
  return getSiteGitInfo(site.slug).tracked ? "git" : "db";
}

export function getCurrentCommitSha(slug: string): string | null {
  const dir = getSiteDir(slug);
  if (!existsSync(join(dir, ".git"))) return null;
  try {
    return runGit(dir, ["rev-parse", "--short", "HEAD"]);
  } catch {
    return null;
  }
}

export function syncSiteGitMetadata(siteId: string, slug: string): void {
  const info = getSiteGitInfo(slug);
  if (!info.tracked) return;

  db.update(publishedSites)
    .set({
      source: "git",
      repoUrl: info.remoteUrl,
      repoBranch: info.branch,
      lastCommitSha: info.lastCommit?.sha.slice(0, 7) ?? null,
      sourceUpdatedAt: new Date().toISOString(),
    })
    .where(eq(publishedSites.id, siteId))
    .run();
}

function getTrackedRemoteCounts(
  dir: string,
  branch: string,
  remoteUrl: string | null,
): { ahead: number; behind: number } {
  if (!remoteUrl) return { ahead: 0, behind: 0 };

  try {
    const output = runGit(dir, [
      "rev-list",
      "--left-right",
      "--count",
      `${branch}...origin/${branch}`,
    ]);
    const [aheadRaw, behindRaw] = output.split(/\s+/);
    return {
      ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
      behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

export function getSiteGitInfo(slug: string): SiteGitInfo {
  const dir = getSiteDir(slug);
  if (!existsSync(join(dir, ".git"))) return { tracked: false };

  try {
    let remoteUrl: string | null = null;
    try {
      remoteUrl = runGit(dir, ["remote", "get-url", "origin"]);
    } catch {
      remoteUrl = null;
    }

    const branch = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
    const dirty = runGit(dir, ["status", "--porcelain"]).length > 0;
    const { ahead, behind } = getTrackedRemoteCounts(dir, branch, remoteUrl);

    let lastCommit: {
      sha: string;
      subject: string;
      date: string;
    } | null = null;
    try {
      const log = runGit(dir, ["log", "-1", "--pretty=format:%H%x09%s%x09%cI"]);
      const [sha, subject, date] = log.split("\t");
      if (sha && subject && date) lastCommit = { sha, subject, date };
    } catch {
      lastCommit = null;
    }

    return { tracked: true, remoteUrl, branch, dirty, ahead, behind, lastCommit };
  } catch {
    return { tracked: false };
  }
}

export function formatGitSummary(info: SiteGitInfo): string | null {
  if (!info.tracked) return null;
  const label = info.remoteUrl ? remoteLabel(info.remoteUrl) : "local-only";
  const status = [];
  if (info.dirty) status.push("dirty");
  if (info.ahead > 0) status.push(`ahead ${info.ahead}`);
  if (info.behind > 0) status.push(`behind ${info.behind}`);
  if (status.length === 0) status.push("clean");
  return `git: ${label} (${status.join(", ")})`;
}

export function formatGitBlock(info: SiteGitInfo): string[] {
  if (!info.tracked) return ["Git: not tracked"];

  const status = [];
  if (info.dirty) status.push("dirty");
  if (info.ahead > 0) status.push(`ahead ${info.ahead}`);
  if (info.behind > 0) status.push(`behind ${info.behind}`);
  if (status.length === 0) status.push("clean");

  return [
    "Git: tracked",
    `Remote: ${info.remoteUrl ?? "(none)"}`,
    `Branch: ${info.branch}`,
    `Status: ${status.join(", ")}`,
    info.lastCommit
      ? `Last commit: ${info.lastCommit.sha.slice(0, 7)} ${info.lastCommit.subject} (${info.lastCommit.date})`
      : "Last commit: none",
  ];
}

export function commitAndPushSiteChange(
  slug: string,
  title: string,
): SiteGitCommitResult {
  const dir = getSiteDir(slug);
  const info = getSiteGitInfo(slug);
  if (!info.tracked) return { committed: false, pushed: false };

  runGit(dir, ["add", "-A"]);
  try {
    runGit(dir, ["diff", "--cached", "--quiet"]);
    return { committed: false, pushed: false };
  } catch {
    // git diff --quiet exits 1 when staged changes exist.
  }

  const subject = `Update: ${title}`;
  run("git", ["-C", dir, ...gitAuthorArgs(), "commit", "-m", subject]);
  const sha = runGit(dir, ["rev-parse", "--short", "HEAD"]);

  if (!info.remoteUrl) {
    return { committed: true, pushed: false, sha, subject };
  }

  try {
    runGit(dir, ["push"]);
    return { committed: true, pushed: true, sha, subject };
  } catch (e) {
    return {
      committed: true,
      pushed: false,
      sha,
      subject,
      warning: e instanceof Error ? e.message : "git push failed",
    };
  }
}

export async function execTrackSiteInGit(
  siteId: string,
  opts?: {
    private?: boolean;
    repoName?: string;
    inviteCollaborator?: string | null;
  },
): Promise<string> {
  if (!siteId) return "ERROR: site_id is required";

  const site = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, siteId))
    .get();
  if (!site) return `ERROR: Site not found (id: ${siteId})`;

  const dir = getSiteDir(site.slug);
  if (!existsSync(dir)) {
    return `ERROR: Site files not found at ${dir}. Publish the site first.`;
  }
  if (existsSync(join(dir, ".git"))) {
    return `ERROR: Site "${site.title}" is already tracked in git.`;
  }

  try {
    run("gh", ["auth", "status"]);
  } catch {
    return "ERROR: gh CLI is not authenticated. Run `gh auth login` on the host running Chomp API.";
  }

  const repoName = opts?.repoName || site.slug;
  const visibility = opts?.private === false ? "--public" : "--private";
  // Not given: the installation's default (none on a fresh install). Explicit null: no invite.
  const inviteCollaborator =
    opts?.inviteCollaborator === undefined ? process.env.SITE_GIT_INVITE_COLLABORATOR?.trim() || null : opts.inviteCollaborator;

  try {
    run("git", ["init", "-b", "main"], dir);
    runGit(dir, ["add", "-A"]);
    run("git", [
      "-C",
      dir,
      ...gitAuthorArgs(),
      "commit",
      "-m",
      `Initial commit: ${site.title}`,
    ]);

    run("gh", ["repo", "create", repoName, visibility, "--source=.", "--push"], dir);

    const remoteUrl = runGit(dir, ["remote", "get-url", "origin"]);
    const commitSha = getCurrentCommitSha(site.slug);
    const owner = run("gh", ["api", "user", "--jq", ".login"]);
    let inviteStatus = "No collaborator invited.";
    if (inviteCollaborator) {
      run("gh", [
        "api",
        "-X",
        "PUT",
        `repos/${owner}/${basename(repoName)}/collaborators/${inviteCollaborator}`,
        "-f",
        "permission=admin",
      ]);
      inviteStatus = `Invited ${inviteCollaborator} as admin.`;
    }

    db.update(publishedSites)
      .set({
        source: "git",
        repoUrl: remoteUrl,
        repoBranch: "main",
        lastCommitSha: commitSha,
        sourceUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(publishedSites.id, site.id))
      .run();

    return [
      `Git tracking enabled for "${site.title}".`,
      `Repo: ${remoteUrl}`,
      inviteStatus,
    ].join("\n");
  } catch (e) {
    return `ERROR: Failed to track site in git: ${formatExecError(e)}`;
  }
}

export async function execUntrackSiteFromGit(
  siteId: string,
  opts?: { deleteRemote?: boolean },
): Promise<string> {
  if (!siteId) return "ERROR: site_id is required";

  const site = db
    .select()
    .from(publishedSites)
    .where(eq(publishedSites.id, siteId))
    .get();
  if (!site) return `ERROR: Site not found (id: ${siteId})`;

  const dir = getSiteDir(site.slug);
  if (!existsSync(join(dir, ".git"))) {
    return `ERROR: Site "${site.title}" is not tracked in git.`;
  }

  let remoteDeleteMessage = "";
  if (opts?.deleteRemote) {
    const info = getSiteGitInfo(site.slug);
    if (info.tracked && info.remoteUrl) {
      const repo = parseGithubRepo(info.remoteUrl);
      if (repo) {
        try {
          run("gh", ["repo", "delete", `${repo.owner}/${repo.name}`, "--yes"]);
          remoteDeleteMessage = ` Deleted remote ${repo.owner}/${repo.name}.`;
        } catch (e) {
          remoteDeleteMessage = ` Remote delete failed: ${formatExecError(e)}`;
        }
      }
    }
  }

  rmSync(join(dir, ".git"), { recursive: true, force: true });
  db.update(publishedSites)
    .set({
      source: "db",
      repoUrl: null,
      repoBranch: "main",
      lastCommitSha: null,
      sourceUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(publishedSites.id, site.id))
    .run();
  return `Git tracking removed for "${site.title}".${remoteDeleteMessage}`;
}

function remoteLabel(remoteUrl: string): string {
  const repo = parseGithubRepo(remoteUrl);
  return repo ? `${repo.owner}/${repo.name}` : remoteUrl;
}

function parseGithubRepo(remoteUrl: string): { owner: string; name: string } | null {
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (ssh) return { owner: ssh[1], name: ssh[2].replace(/\.git$/, "") };

  try {
    const url = new URL(remoteUrl);
    if (url.hostname !== "github.com") return null;
    const [owner, rawName] = url.pathname.replace(/^\/|\/$/g, "").split("/");
    if (!owner || !rawName) return null;
    return { owner, name: rawName.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

function formatExecError(e: unknown): string {
  if (
    e &&
    typeof e === "object" &&
    "stderr" in e &&
    Buffer.isBuffer((e as { stderr?: unknown }).stderr)
  ) {
    const stderr = ((e as { stderr: Buffer }).stderr.toString("utf-8") || "").trim();
    if (stderr) return stderr;
  }
  return e instanceof Error ? e.message : String(e);
}
