// Prompts for the maintenance rules Chomp seeds switched off. chomp-self explains what each needs before it is switched on.

export const MEMORY_DREAM_RULE_PROMPT = `Run the weekly memory dream. Load the \`dream\` skill with get_skills and follow its Dream mode (Phases 1-4) exactly: read dream_digest(days: 7) and the memory store, find what agents keep getting wrong, save the proposals file under ~/chomp-work/dream/, and end with the report and the approval form.

This run is unsupervised, so it changes NO memory. It only proposes. The user approves in the web chat conversation of this rule, where the form is clickable. Start the report with one line saying so, because the message may also reach Telegram or Discord, where the form shows as plain text.

Zero proposals worth making is a fine outcome: say so in one line and stop. Keep the report dry and factual: a maintenance log, not a performance.`;

export const MEMORY_REVIEW_RULE_PROMPT = `Weekly review of memories Chomp extracted on its own (source: auto) in the last 8 days. The gate matched, so there is something to review. Candidates, each with its evidence quote and its nearest existing memories:
{{gateResult}}

For each candidate decide exactly one:
- KEEP: durable, specific, correct. Leave it alone.
- DROP: a task or request rather than a lasting fact, trivia, vague (names no concrete thing), already false, or an exact duplicate of a neighbour. Delete it with delete_memory. Only the candidates themselves (auto memories) may be deleted.
- PROPOSE: it duplicates or contradicts a STATED neighbour (source user or seed), or is worth promoting to a stated memory. Touch neither; list it in the report with both ids.

Rails: delete at most 10 memories. Never call update_memory or save_memory. Never touch stated memories, or any memory that is not in the candidate list. When unsure, KEEP. Do not read the rest of the store: the candidates and neighbours above are all you need.

Report with one chomp_reply, 3-6 lines: counts (kept / dropped / proposed); for each drop its id and first ~80 characters, so it can be restored from a database backup; then the proposals. Dry and factual, a maintenance log, not a performance.`;

export const SKILL_REVIEW_RULE_PROMPT = `Run the monthly review of the user's own skills. The goal is skills that match how the work really went last month, and that get shorter, not longer.

This run is unsupervised, so it changes NO skill and NO memory. It only proposes. The user approves in the web chat conversation of this rule by replying with the numbers, for example "apply P1, P3". Start the report with one line saying so, because the message may also reach Telegram or Discord, where a reply does not reach this conversation.

## Scope

In scope: the skill folders in \`~/.claude/skills\`.

Out of scope, never propose a change to these: third-party skills (any skill whose frontmatter has a \`license\` field or names an outside author) and every plugin skill (anything under \`~/.claude/plugins\`, or with a \`plugin:skill\` name).

Skills seeded from Chomp's code (chomp-agent, chomp-self, dream, phone-widget, apple-shortcuts, social-publish, weather, crypto-prices, stock-prices, news, ai-trends, x-trends, football, github, github-issue-autofix, gmail, google-calendar) are in scope, but their fix is a code change in the Chomp repo (\`packages/api/src/seed.ts\` and \`seed/\`). Mark such a proposal "repo".

## Evidence

1. \`dream_digest(days: 7)\` for user pushback. It is cut at 60k chars, so do not rely on it for failures.
2. Chomp's database (the DB_PATH in Chomp's .env, opened read-only), table \`chat_items\`, last 31 days. Skill loads are rows with \`kind = 'tool_call'\` whose payload has \`"tool":"Skill"\`; \`payload.input\` is a JSON string holding the skill name. Agents also read a \`SKILL.md\` directly, so count those commands too. Failures are payloads with \`status\` "failed", or a command with \`exitCode\` above 0. Count loads per skill and keep the conversation ids.
3. For each skill that was loaded in a conversation with a failed command, a failed tool or user pushback, read that part of the conversation (\`get_conversation_messages\`) and decide whether the skill's instructions caused it.
4. Read each in-scope \`SKILL.md\` that has such a signal. For the others, only check that the files, scripts, commands and Chomp tools the skill names still exist.
5. \`recall_memories\` with category \`lessons\`: a lesson that is about one in-scope skill belongs in that skill.

## What to propose

- **fix**: the skill's instructions were wrong or missing a step, and it cost a failure or a correction. Cite the conversation (first 8 characters of its id) and the date.
- **stale**: the skill names a file, script, command, tool or fact that no longer exists or is no longer true. Say how you checked.
- **cut**: text that is duplicated, describes a one-off incident as a rule, or repeats what the agent protocol or another skill already says. Quote the lines to delete.
- **move**: a memory lesson that belongs in a skill. The proposal adds it to the skill and deletes the memory.

Rules:
- Every proposal needs evidence from this month or a check you ran. No proposals from taste.
- At most 8 proposals, most valuable first. Across all of them, the skills must not get longer in total: pair additions with cuts.
- Never propose deleting a whole skill because it is rarely used.
- The report covers skills only. Do not repeat personal content from the chats you read.

## Output

Save the proposals to \`~/chomp-work/skill-review/<YYYY-MM>.md\`: for each, its number, type, skill, evidence, and the exact text to remove and to add. Then reply in plain markdown, with no canvas blocks (they are off in this run):
- one line of totals: skills in scope, skills loaded this month, proposals, and the line count before and after if all are applied;
- one bullet per proposal: **P1 · skill · type:** the change and its evidence, in two or three sentences;
- what you did not check.

Zero proposals is a fine outcome: say so in one line and stop. Keep it dry and factual: a maintenance log.

## When the user answers

Apply only the proposals the user names, exactly as written in the proposals file. Before the first edit, copy each affected \`SKILL.md\` to \`~/chomp-work/skill-review/<YYYY-MM>-backup/<skill>/SKILL.md\`, because the skills folder is not in git. Edit own skills on disk and keep their frontmatter. For "repo" proposals, load \`chomp-dev\` if the user has it, and make the change in the Chomp repo. For "move", delete the memory after the skill holds the text. End with what changed per skill and the line count before and after.`;

export const TAILSCALE_KEY_RULE_PROMPT = `Check Tailscale node key expiry and only speak up if something needs a human.

Run \`tailscale status --json\` (on macOS the CLI may be /Applications/Tailscale.app/Contents/MacOS/Tailscale) and parse \`Self\` plus every entry in \`Peer\`. For each node read \`HostName\`, \`Online\`, \`Expired\`, and \`KeyExpiry\`, and compute days remaining from \`KeyExpiry\` versus now (UTC).

Report via chomp_reply ONLY if at least one of these is true:
- any node has \`Expired: true\` (its key has already lapsed, so it is off the tailnet)
- any node's key expires within 21 days

If nothing qualifies, send a single short line confirming all node keys are healthy and the soonest expiry date, then stop. Do not pad it.

When you do report, for each affected node give: hostname, days remaining (negative if already lapsed), and whether it is online. For servers and build machines, name the permanent fix: disable key expiry for that node in the Tailscale admin console (Machines → node → ⋯ → Disable key expiry). If the user's memories say which machine is which, use them. Do not try to re-authenticate a node yourself.`;
