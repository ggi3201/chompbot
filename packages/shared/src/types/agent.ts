/** The CLI engines a turn can run on. */
export type CliAgentType = "claude-sdk" | "codex-sdk";

/** The model a provider runs when nothing picks one. */
export const CLI_AGENT_DEFAULT_MODEL: Record<CliAgentType, string> = {
  "claude-sdk": "sonnet",
  "codex-sdk": "gpt-6.1-sol",
};
