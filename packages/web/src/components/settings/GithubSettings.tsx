import type { Dispatch, SetStateAction } from "react";
import { Github, Plus, X } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { Badge, Button, IconButton, Input } from "../ui";
import { SettingsPanel, SettingsRow, SettingsSection, ValueRow } from "./SettingsSection";

interface GithubSettingsProps {
  settings: Record<string, string>;
  setSettings: Dispatch<SetStateAction<Record<string, string>>>;
  newRepoInput: string;
  setNewRepoInput: Dispatch<SetStateAction<string>>;
  showMessage: (type: "success" | "error", text: string) => void;
}

function parseRepos(value: string | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((repo): repo is string => typeof repo === "string") : [];
  } catch {
    return [];
  }
}

async function saveSetting(key: string, value: string): Promise<Response> {
  return apiFetch(`/settings/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export function GithubSettings({
  settings,
  setSettings,
  newRepoInput,
  setNewRepoInput,
  showMessage,
}: GithubSettingsProps) {
  const repos = parseRepos(settings.github_issue_repos);

  async function saveRepos(updated: string[], successMessage: string) {
    const value = JSON.stringify(updated);
    const res = await saveSetting("github_issue_repos", value);
    if (res.ok) {
      setSettings((s) => ({ ...s, github_issue_repos: value }));
      showMessage("success", successMessage);
    } else {
      showMessage("error", "Failed to save repos");
    }
  }

  async function saveUsername(value: string) {
    const res = await saveSetting("github_username", value);
    if (res.ok) setSettings((s) => ({ ...s, github_username: value }));
    showMessage(res.ok ? "success" : "error", res.ok ? "GitHub username saved" : "Failed to save username");
    return res.ok;
  }

  async function addRepo() {
    const repo = newRepoInput.trim();
    if (!repo || !repo.includes("/")) {
      showMessage("error", "Enter a valid repo (owner/repo)");
      return;
    }
    if (repos.includes(repo)) {
      showMessage("error", "Repo already added");
      return;
    }
    await saveRepos([...repos, repo], `Added ${repo}`);
    setNewRepoInput("");
  }

  return (
    <SettingsSection
      title="GitHub repositories"
      description={<>Repos that Chomp monitors for issues. Label an issue <Badge>chomp:ready</Badge> to trigger auto-fix.</>}
    >
      <SettingsPanel>
        <ValueRow
          label="Chomp's username"
          hint="The account agents recognize as themselves in issues and PRs"
          value={settings.github_username ? `@${settings.github_username}` : null}
          placeholder="GitHub username"
          onSave={(value) => saveUsername(value.replace(/^@/, ""))}
          onDelete={() => saveUsername("")}
        />
      </SettingsPanel>

      <div className="mt-3">
        {repos.length > 0 ? (
          <SettingsPanel>
            {repos.map((repo) => (
              <SettingsRow
                key={repo}
                icon={<Github size={16} strokeWidth={1.5} className="text-text-muted shrink-0" />}
                label={<span className="font-mono truncate">{repo}</span>}
              >
                <IconButton tone="danger" label={`Remove ${repo}`} onClick={() => saveRepos(repos.filter((r) => r !== repo), `Removed ${repo}`)}>
                  <X size={16} strokeWidth={1.5} />
                </IconButton>
              </SettingsRow>
            ))}
          </SettingsPanel>
        ) : (
          <p className="m-0 text-[13px] text-text-muted">No repos yet</p>
        )}
      </div>

      <div className="flex gap-2 items-center mt-3">
        <Input
          aria-label="Repository to add"
          value={newRepoInput}
          onChange={(e) => setNewRepoInput(e.target.value)}
          placeholder="owner/repo"
          className="flex-1 min-w-0 h-9 !py-0 font-mono"
          onKeyDown={(e) => {
            if (e.key === "Enter" && newRepoInput.trim()) {
              addRepo();
            }
          }}
        />
        <Button onClick={addRepo}>
          <Plus size={16} strokeWidth={1.5} />
          Add
        </Button>
      </div>
    </SettingsSection>
  );
}
