type ResolveCallback = (answer: string) => void;
type RejectCallback = (reason: Error) => void;

interface PendingQuestion {
  /** Set when the question also went to the phone, whose answer must not land on a later question. */
  id?: string;
  question: string;
  resolve: ResolveCallback;
  reject: RejectCallback;
  timer: ReturnType<typeof setTimeout>;
}

// Queue of pending questions per session — supports multiple sequential ask_user calls
const pendingQueues = new Map<string, PendingQuestion[]>();

export const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function createPendingQuestion(
  sessionId: string,
  question: string,
  id?: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove this specific entry from the queue on timeout
      const queue = pendingQueues.get(sessionId);
      if (queue) {
        const idx = queue.findIndex((q) => q.resolve === resolve);
        if (idx !== -1) {
          queue.splice(idx, 1);
          if (queue.length === 0) pendingQueues.delete(sessionId);
        }
      }
      reject(new Error("Question timed out waiting for user response"));
    }, QUESTION_TIMEOUT_MS);

    const entry: PendingQuestion = { id, question, resolve, reject, timer };

    const queue = pendingQueues.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      pendingQueues.set(sessionId, [entry]);
    }
  });
}

export function answerPendingQuestion(sessionId: string, answer: string, id?: string): boolean {
  const queue = pendingQueues.get(sessionId);
  if (!queue || queue.length === 0) return false;

  // Answer the question asked for, else the oldest pending one (FIFO)
  const index = id ? queue.findIndex((q) => q.id === id) : 0;
  if (index === -1) return false;
  const [entry] = queue.splice(index, 1);
  clearTimeout(entry.timer);
  entry.resolve(answer);

  if (queue.length === 0) pendingQueues.delete(sessionId);
  return true;
}

export function getPendingQuestion(sessionId: string): { question: string } | null {
  const queue = pendingQueues.get(sessionId);
  if (!queue || queue.length === 0) return null;
  // Return the oldest pending question
  return { question: queue[0].question };
}

export function hasPendingQuestion(sessionId: string): boolean {
  const queue = pendingQueues.get(sessionId);
  return !!queue && queue.length > 0;
}

/** Sessions with a question waiting for the user. */
export function pendingQuestionSessionIds(): string[] {
  return [...pendingQueues.keys()];
}
