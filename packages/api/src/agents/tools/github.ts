/**
 * GitHub tools — list, read, update, and create issues via the `gh` CLI.
 */

import { execFile } from "child_process";

function gh(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("gh", args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && "code" in err ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

// ── List Issues ─────────────────────────────────────────────────

export async function execListGithubIssues(
  repos?: string[],
  labels?: string[],
  limit?: number,
): Promise<string> {
  if (!repos || repos.length === 0) {
    return "ERROR: No repositories specified. Configure github_issue_repos in settings.";
  }

  const max = Math.min(limit ?? 10, 25);
  const allIssues: string[] = [];

  for (const repo of repos) {
    const args = ["issue", "list", "--repo", repo, "--json", "number,title,labels,url,createdAt", "--limit", String(max)];
    if (labels && labels.length > 0) {
      for (const label of labels) {
        args.push("--label", label);
      }
    }

    const result = await gh(args);
    if (result.code !== 0) {
      allIssues.push(`[${repo}] ERROR: ${result.stderr.slice(0, 200)}`);
      continue;
    }

    try {
      const issues = JSON.parse(result.stdout) as Array<{
        number: number;
        title: string;
        labels: Array<{ name: string }>;
        url: string;
        createdAt: string;
      }>;

      if (issues.length === 0) {
        allIssues.push(`[${repo}] No matching issues.`);
        continue;
      }

      for (const issue of issues) {
        const labelNames = issue.labels.map((l) => l.name).join(", ");
        allIssues.push(
          `[${repo}] #${issue.number}: ${issue.title}\n  Labels: ${labelNames || "(none)"}\n  URL: ${issue.url}\n  Created: ${issue.createdAt}`,
        );
      }
    } catch {
      allIssues.push(`[${repo}] ERROR: Failed to parse gh output`);
    }
  }

  return allIssues.join("\n\n");
}

// ── Get Issue ───────────────────────────────────────────────────

export async function execGetGithubIssue(
  repo: string,
  issueNumber: number,
): Promise<string> {
  const result = await gh([
    "issue", "view", String(issueNumber),
    "--repo", repo,
    "--json", "number,title,body,labels,comments,url,state,author",
  ]);

  if (result.code !== 0) {
    return `ERROR: Failed to get issue #${issueNumber} from ${repo}: ${result.stderr.slice(0, 200)}`;
  }

  try {
    const issue = JSON.parse(result.stdout) as {
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string }>;
      comments: Array<{ body: string; author: { login: string }; createdAt: string }>;
      url: string;
      state: string;
      author: { login: string };
    };

    const labelNames = issue.labels.map((l) => l.name).join(", ");
    const commentBlock = issue.comments.length > 0
      ? "\n\nComments:\n" + issue.comments.map((c) =>
          `  @${c.author.login} (${c.createdAt}):\n  ${c.body.slice(0, 500)}`,
        ).join("\n\n")
      : "";

    return `#${issue.number}: ${issue.title}\nState: ${issue.state}\nAuthor: @${issue.author.login}\nLabels: ${labelNames || "(none)"}\nURL: ${issue.url}\n\n${issue.body ?? "(no body)"}${commentBlock}`;
  } catch {
    return `ERROR: Failed to parse issue #${issueNumber} from ${repo}`;
  }
}

// ── Update Issue Labels ─────────────────────────────────────────

export async function execUpdateGithubIssueLabels(
  repo: string,
  issueNumber: number,
  addLabels?: string[],
  removeLabels?: string[],
): Promise<string> {
  const args = ["issue", "edit", String(issueNumber), "--repo", repo];

  if (addLabels && addLabels.length > 0) {
    for (const label of addLabels) {
      args.push("--add-label", label);
    }
  }
  if (removeLabels && removeLabels.length > 0) {
    for (const label of removeLabels) {
      args.push("--remove-label", label);
    }
  }

  if (!addLabels?.length && !removeLabels?.length) {
    return "ERROR: No labels specified to add or remove.";
  }

  const result = await gh(args);
  if (result.code !== 0) {
    return `ERROR: Failed to update labels on ${repo}#${issueNumber}: ${result.stderr.slice(0, 200)}`;
  }

  const added = addLabels?.length ? `added [${addLabels.join(", ")}]` : "";
  const removed = removeLabels?.length ? `removed [${removeLabels.join(", ")}]` : "";
  return `Labels updated on ${repo}#${issueNumber}: ${[added, removed].filter(Boolean).join(", ")}`;
}

// ── Create Issue ────────────────────────────────────────────────

export async function execCreateGithubIssue(
  repo: string,
  title: string,
  body: string,
  labels?: string[],
): Promise<string> {
  const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body];

  if (labels && labels.length > 0) {
    for (const label of labels) {
      args.push("--label", label);
    }
  }

  const result = await gh(args);
  if (result.code !== 0) {
    return `ERROR: Failed to create issue in ${repo}: ${result.stderr.slice(0, 200)}`;
  }

  // gh issue create prints the issue URL on success
  return `Issue created: ${result.stdout.trim()}`;
}

// ── Comment on Issue ────────────────────────────────────────────

export async function execCommentOnGithubIssue(
  repo: string,
  issueNumber: number,
  body: string,
): Promise<string> {
  const result = await gh([
    "issue", "comment", String(issueNumber),
    "--repo", repo,
    "--body", body,
  ]);

  if (result.code !== 0) {
    return `ERROR: Failed to comment on ${repo}#${issueNumber}: ${result.stderr.slice(0, 200)}`;
  }

  return `Comment added to ${repo}#${issueNumber}`;
}
