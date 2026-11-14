import { test, expect } from "vitest";
import {
  CHANNEL_COMMANDS,
  getDelegatedPrompt,
  getDiscordCommandSpecs,
  isDelegatedCommand,
  listDelegatedCommands,
  renderTelegramHelp,
  renderDiscordHelp,
} from "../../src/channels/command-catalog.js";

test("every command has a unique handler", () => {
  const handlers = CHANNEL_COMMANDS.map((c) => c.handler);
  const duplicates = handlers.filter((name, i) => handlers.indexOf(name) !== i);
  expect(duplicates).toEqual([]);
});

test("telegram commands have unique names", () => {
  const telegramNames = CHANNEL_COMMANDS
    .filter((c) => c.telegram)
    .map((c) => c.telegram!.name);
  const duplicates = telegramNames.filter((name, i) => telegramNames.indexOf(name) !== i);
  expect(duplicates).toEqual([]);
});

test("discord commands have unique names and conform to slash command rules", () => {
  const discordNames = CHANNEL_COMMANDS
    .filter((c) => c.discord)
    .map((c) => c.discord!.name);
  const duplicates = discordNames.filter((name, i) => discordNames.indexOf(name) !== i);
  expect(duplicates).toEqual([]);

  // Discord slash command names must be 1-32 chars, lowercase, no spaces
  for (const name of discordNames) {
    expect(name.length).toBeGreaterThanOrEqual(1);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).toMatch(/^[a-z0-9_-]+$/);
  }
});

test("getDiscordCommandSpecs only includes commands with discord metadata", () => {
  const specs = getDiscordCommandSpecs();
  const expectedCount = CHANNEL_COMMANDS.filter((c) => c.discord).length;
  expect(specs).toHaveLength(expectedCount);
  for (const spec of specs) {
    expect(spec.name).toBeTruthy();
    expect(spec.description).toBeTruthy();
  }
});

test("renderTelegramHelp lists every telegram command and uses HTML escaping", () => {
  const help = renderTelegramHelp();
  expect(help).toContain("<b>Chomp Commands</b>");
  expect(help).toContain("Calendar &amp; Email");
  expect(help).not.toMatch(/Calendar & Email/); // raw ampersand would break Telegram HTML
  for (const command of CHANNEL_COMMANDS.filter((c) => c.telegram)) {
    expect(help).toContain(`/${command.telegram!.name}`);
  }
});

test("renderDiscordHelp lists every discord command with markdown formatting", () => {
  const help = renderDiscordHelp();
  expect(help).toContain("**Chomp Commands**");
  for (const command of CHANNEL_COMMANDS.filter((c) => c.discord)) {
    expect(help).toContain(`\`/${command.discord!.name}`);
  }
});

test("commands marked with discord options render <argname> in help", () => {
  const help = renderDiscordHelp();
  const withOption = CHANNEL_COMMANDS.find((c) => c.discord?.option);
  expect(withOption).toBeTruthy();
  expect(help).toContain(`<${withOption!.discord!.option!.name}>`);
});

test("core commands needed by chat onboarding are present", () => {
  const handlers = new Set(CHANNEL_COMMANDS.map((c) => c.handler));
  for (const required of ["help", "status", "fresh", "resume", "agents", "memories", "rules"]) {
    expect(handlers.has(required)).toBe(true);
  }
});

// ── Delegated prompts ─────────────────────────────────────────

test("listDelegatedCommands returns the same commands isDelegatedCommand reports", () => {
  const list = listDelegatedCommands();
  expect(list.length).toBeGreaterThan(0);
  for (const handler of list) {
    expect(isDelegatedCommand(handler)).toBe(true);
  }
  expect(isDelegatedCommand("help")).toBe(false);
  expect(isDelegatedCommand("status")).toBe(false);
});

test("every delegated command exists in the channel command catalog", () => {
  const handlers = new Set(CHANNEL_COMMANDS.map((c) => c.handler));
  for (const handler of listDelegatedCommands()) {
    expect(handlers.has(handler), `delegated handler "${handler}" must be a known command`).toBe(true);
  }
});

test("getDelegatedPrompt returns null for non-delegated commands", () => {
  expect(getDelegatedPrompt("help", "")).toBeNull();
  expect(getDelegatedPrompt("status", "")).toBeNull();
  expect(getDelegatedPrompt("definitely-not-a-command", "")).toBeNull();
});

test("no-arg delegated commands produce a non-empty prompt regardless of input", () => {
  for (const handler of ["today", "tomorrow", "inbox", "issues", "weather", "crypto", "stocks", "news", "drive"]) {
    const result = getDelegatedPrompt(handler, "");
    expect(result?.ok, handler).toBe(true);
    if (result?.ok) expect(result.prompt.length).toBeGreaterThan(10);
  }
});

test("event command interpolates details when provided, falls back when empty", () => {
  const withDetails = getDelegatedPrompt("event", "Lunch with Mom Friday 12:00");
  expect(withDetails?.ok).toBe(true);
  if (withDetails?.ok) expect(withDetails.prompt).toContain("Lunch with Mom Friday 12:00");

  const empty = getDelegatedPrompt("event", "");
  expect(empty?.ok).toBe(true);
  if (empty?.ok) expect(empty.prompt).toMatch(/title.*date.*time/i);
});

test("email command requires an id and reports usage when missing", () => {
  const missing = getDelegatedPrompt("email", "");
  expect(missing?.ok).toBe(false);
  if (missing && !missing.ok) expect(missing.usage).toMatch(/id/i);

  const ok = getDelegatedPrompt("email", "abc123");
  expect(ok?.ok).toBe(true);
  if (ok?.ok) expect(ok.prompt).toContain("abc123");
});

test("recipes command requires a query", () => {
  const missing = getDelegatedPrompt("recipes", "   ");
  expect(missing?.ok).toBe(false);

  const ok = getDelegatedPrompt("recipes", "miso ramen");
  expect(ok?.ok).toBe(true);
  if (ok?.ok) expect(ok.prompt).toContain("miso ramen");
});

test("create-issue parses repo and title from a single args string", () => {
  const tooFew = getDelegatedPrompt("create-issue", "myorg/myrepo");
  expect(tooFew?.ok).toBe(false);

  const ok = getDelegatedPrompt("create-issue", "myorg/myrepo Fix login bug on safari");
  expect(ok?.ok).toBe(true);
  if (ok?.ok) {
    expect(ok.prompt).toContain("myorg/myrepo");
    expect(ok.prompt).toContain("Fix login bug on safari");
  }
});

test("delegated prompts are stable strings (no random / Date.now leakage)", () => {
  const a = getDelegatedPrompt("today", "");
  const b = getDelegatedPrompt("today", "");
  expect(a?.ok && b?.ok && a.prompt === b.prompt).toBe(true);
});
