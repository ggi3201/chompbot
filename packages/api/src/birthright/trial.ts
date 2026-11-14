import { query } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { souls } from "../db/schema.js";
import { pickTrialMessages, readChatRows } from "./evidence.js";
import { soulRunOptions } from "./interview.js";

const TRIAL_ROUNDS = 3;
const TRIAL_NOTE = "This is a short test of how you answer. You have no tools here. Answer the message the way you would in chat. If it would take looking something up or doing work, say briefly what you would do.";

export interface TrialAnswer {
  /** Which prompt wrote it. The page keeps this hidden until the person has chosen. */
  source: "new" | "current";
  text: string;
}

export interface TrialRound {
  message: string;
  answers: TrialAnswer[];
}

export interface Trial {
  /** The soul being replaced, or null when there is none yet. */
  current: string | null;
  rounds: TrialRound[];
}

async function answerAs(soul: string | undefined, message: string, abortController: AbortController): Promise<string> {
  const q = query({
    prompt: message,
    options: {
      ...soulRunOptions(),
      systemPrompt: soul ? `${soul}\n\n${TRIAL_NOTE}` : TRIAL_NOTE,
      persistSession: false,
      abortController,
    },
  });
  try {
    for await (const event of q) {
      if (event.type !== "result") continue;
      if (event.subtype !== "success" || event.is_error) throw new Error(`The test answer ended with ${event.subtype}`);
      return event.result.trim();
    }
    throw new Error("The test answer never finished");
  } finally {
    q.close();
  }
}

/**
 * The same real messages, answered by the new soul and by what is running today.
 * A person can choose between two answers far better than they can judge a prompt.
 */
export async function runTrial(soul: string, abortController: AbortController, random: () => number = Math.random): Promise<Trial> {
  const current = db.select().from(souls).where(eq(souls.isDefault, true)).get();
  const messages = pickTrialMessages(readChatRows(), TRIAL_ROUNDS, random);
  const rounds = await Promise.all(messages.map(async (message) => {
    const [next, today] = await Promise.all([
      answerAs(soul, message, abortController),
      answerAs(current?.content, message, abortController),
    ]);
    const answers: TrialAnswer[] = [{ source: "new", text: next }, { source: "current", text: today }];
    return { message, answers: random() < 0.5 ? answers : answers.reverse() };
  }));
  return { current: current?.name ?? null, rounds };
}
