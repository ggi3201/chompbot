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

const duplicatesOf = (names: string[]) => names.filter((name, i) => names.indexOf(name) !== i);

test("handlers and per-channel names are unique, and discord names conform to slash command rules", () => {
  expect(duplicatesOf(CHANNEL_COMMANDS.map((c) => c.handler))).toEqual([]);
  expect(duplicatesOf(CHANNEL_COMMANDS.filter((c) => c.telegram).map((c) => c.telegram!.name))).toEqual([]);
  const discordNames = CHANNEL_COMMANDS.filter((c) => c.discord).map((c) => c.discord!.name);
  expect(duplicatesOf(discordNames)).toEqual([]);

  // Discord slash command names must be 1-32 chars, lowercase, no spaces
  for (const name of discordNames) {
    expect(name.length).toBeGreaterThanOrEqual(1);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).toMatch(/^[a-z0-9_-]+$/);
  }

  // getDiscordCommandSpecs only includes commands with discord metadata
  const specs = getDiscordCommandSpecs();
  expect(specs).toHaveLength(discordNames.length);
  for (const spec of specs) {
    expect(spec.name).toBeTruthy();
    expect(spec.description).toBeTruthy();
  }
});

test("renderTelegramHelp lists every telegram command and uses HTML escaping", () => {
  const help = renderTelegramHelp();
  expect(help).toContain("Calendar &amp; Email");
  expect(help).not.toMatch(/Calendar & Email/); // raw ampersand would break Telegram HTML
  for (const command of CHANNEL_COMMANDS.filter((c) => c.telegram)) {
    expect(help).toContain(`/${command.telegram!.name}`);
  }
});

test("renderDiscordHelp lists every discord command, with <argname> for commands that take an option", () => {
  const help = renderDiscordHelp();
  for (const command of CHANNEL_COMMANDS.filter((c) => c.discord)) {
    expect(help).toContain(`\`/${command.discord!.name}`);
  }
  const withOption = CHANNEL_COMMANDS.find((c) => c.discord?.option);
  expect(withOption).toBeTruthy();
  expect(help).toContain(`<${withOption!.discord!.option!.name}>`);
});

// ── Delegated prompts ─────────────────────────────────────────

test("delegated commands are known catalog commands, and others get no delegated prompt", () => {
  const handlers = new Set(CHANNEL_COMMANDS.map((c) => c.handler));
  const list = listDelegatedCommands();
  expect(list.length).toBeGreaterThan(0);
  for (const handler of list) {
    expect(isDelegatedCommand(handler)).toBe(true);
    expect(handlers.has(handler), `delegated handler "${handler}" must be a known command`).toBe(true);
  }
  for (const handler of ["help", "status"]) {
    expect(isDelegatedCommand(handler)).toBe(false);
    expect(getDelegatedPrompt(handler, "")).toBeNull();
  }
  expect(getDelegatedPrompt("definitely-not-a-command", "")).toBeNull();
});

test("no-arg delegated commands produce a stable, non-empty prompt regardless of input", () => {
  for (const handler of ["today", "tomorrow", "inbox", "issues", "weather", "crypto", "stocks", "news", "drive"]) {
    const result = getDelegatedPrompt(handler, "");
    expect(result?.ok, handler).toBe(true);
    if (result?.ok) expect(result.prompt.length).toBeGreaterThan(10);
  }
  const a = getDelegatedPrompt("today", "");
  const b = getDelegatedPrompt("today", "");
  expect(a?.ok && b?.ok && a.prompt === b.prompt).toBe(true);
});

test("commands with an argument put it in the prompt; email and recipes require one, event falls back", () => {
  const event = getDelegatedPrompt("event", "Lunch with Mom Friday 12:00");
  expect(event?.ok).toBe(true);
  if (event?.ok) expect(event.prompt).toContain("Lunch with Mom Friday 12:00");
  expect(getDelegatedPrompt("event", "")?.ok).toBe(true);

  const missingEmail = getDelegatedPrompt("email", "");
  expect(missingEmail?.ok).toBe(false);
  if (missingEmail && !missingEmail.ok) expect(missingEmail.usage).toMatch(/id/i);
  const email = getDelegatedPrompt("email", "abc123");
  expect(email?.ok).toBe(true);
  if (email?.ok) expect(email.prompt).toContain("abc123");

  expect(getDelegatedPrompt("recipes", "   ")?.ok).toBe(false);
  const recipes = getDelegatedPrompt("recipes", "miso ramen");
  expect(recipes?.ok).toBe(true);
  if (recipes?.ok) expect(recipes.prompt).toContain("miso ramen");
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
