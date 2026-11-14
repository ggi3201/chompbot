/**
 * GitHub Issue Triage — scans configured repos for `chomp:ready` issues,
 * claims each by relabeling to `chomp:in-progress`, and returns enriched
 * prompts for agent dispatch (one per issue).
 */

import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";

export interface TriagedIssue {
  prompt: string;
  issueRef: string;
}

export interface TriageResult {
  issues: TriagedIssue[];
}

export async function triageGithubIssues(): Promise<TriageResult> {
  // 1. Read configured repos
  const row = db.select().from(settings).where(eq(settings.key, "github_issue_repos")).get();
  if (!row) {
    console.log("[github-issues] No github_issue_repos setting found");
    return { issues: [] };
  }

  let repos: string[];
  try {
    repos = JSON.parse(row.value) as string[];
  } catch {
    console.error("[github-issues] Invalid github_issue_repos JSON:", row.value);
    return { issues: [] };
  }

  if (repos.length === 0) {
    console.log("[github-issues] No repos configured");
    return { issues: [] };
  }

  // 2. Find chomp:ready issues across all repos
  const { execListGithubIssues } = await import("../agents/tools/github.js");
  const listing = await execListGithubIssues(repos, ["chomp:ready"], 10);

  // 3. Parse ALL issues from the listing
  const issuePattern = /\[([^\]]+)\] #(\d+): (.+)/g;
  const matches = [...listing.matchAll(issuePattern)];

  if (matches.length === 0) {
    console.log("[github-issues] No chomp:ready issues found");
    return { issues: [] };
  }

  // 4. Claim and build prompts for each issue
  const { execUpdateGithubIssueLabels, execCommentOnGithubIssue, execGetGithubIssue } =
    await import("../agents/tools/github.js");

  const issues: TriagedIssue[] = [];

  for (const match of matches) {
    const repo = match[1];
    const issueNumber = parseInt(match[2], 10);
    const issueTitle = match[3];
    const issueRef = `${repo}#${issueNumber}`;

    console.log(`[github-issues] Claiming issue: ${issueRef} — ${issueTitle}`);

    // Atomically relabel: chomp:ready → chomp:in-progress
    const labelResult = await execUpdateGithubIssueLabels(
      repo, issueNumber,
      ["chomp:in-progress"],
      ["chomp:ready"],
    );

    if (labelResult.startsWith("ERROR:")) {
      console.error(`[github-issues] Failed to relabel ${issueRef}:`, labelResult);
      continue;
    }

    // Comment that Chomp is working on it
    await execCommentOnGithubIssue(
      repo, issueNumber,
      "🤖 Chomp is picking up this issue. Working on a fix...",
    );

    // Get full issue details for the prompt
    const issueDetails = await execGetGithubIssue(repo, issueNumber);

    // Build enriched prompt (GitHub identity is injected globally by dispatch.ts)
    const prompt = `You are fixing a GitHub issue that has been assigned to you.

## Issue Details

Repository: ${repo}
Issue: #${issueNumber}

${issueDetails}

## Instructions

Use the "github-issue-autofix" skill (call get_skills with name "github-issue-autofix") for the full workflow.

Key requirements:
- **Sync trunk first**: fetch and pull latest main before starting
- **Use worktree isolation**: create a git worktree at /tmp/chomp-fix-${issueNumber} — never modify the main checkout directly
- Create a branch named \`chomp/issue-${issueNumber}-<short-slug>\`
- Implement the fix in the worktree
- Create a PR with \`gh pr create\` referencing "Fixes #${issueNumber}"
- On success: run \`gh issue edit ${issueNumber} --repo ${repo} --remove-label chomp:in-progress --add-label chomp:done\`
- On failure: comment on the issue explaining what went wrong, leave the chomp:in-progress label
- **Always clean up the worktree** when done (success or failure)
- NEVER push directly to main/master — always create a PR`;

    issues.push({ prompt, issueRef });
  }

  console.log(`[github-issues] Triaged ${issues.length} issue(s)`);
  return { issues };
}
