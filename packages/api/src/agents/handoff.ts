/**
 * The note a session writes for the fresh session that takes over from it.
 *
 * The session itself writes it, on its own model and settings: everything it
 * has seen (tool results included) is already in its prompt cache, so the
 * turn reads cheaply and knows more than a separate summariser reading the
 * Chomp transcript cold would. Changing model or effort for this one turn
 * would throw that cache away.
 */
export function buildHandoffPrompt(goal: string): string {
  return [
    "Write a handoff note for a new session that takes over this work. It will not see this conversation: your note is all it gets.",
    "",
    "Do not use tools and do not change anything. Write from what you already know.",
    "",
    "Keep it short, well under 400 words, but complete enough to start without asking:",
    "- The goal, in one or two sentences.",
    "- The state now: what is done, what is verified, what is not.",
    "- Decisions made and constraints the user gave, including how they want to work.",
    "- The files, paths, commands, branches and ids that matter.",
    "- Open problems, and the next step.",
    "",
    "Leave out how you got here, dead ends that no longer matter, and anything the new session can read faster from the code.",
    goal ? `\nThe new session's task: ${goal}\nFocus the note on what that task needs.` : "",
    "",
    "Answer with the note only, in markdown, starting with \"# Handoff\".",
  ].join("\n");
}

/** `/handoff sonnet 5.5 high fix the tests` → the goal after the model words, which the client strips. */
export const HANDOFF_COMMAND = "/handoff";
