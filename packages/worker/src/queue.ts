import { Queue, Worker } from "bullmq";
import { redis } from "./connection.js";

export const heartbeatQueue = new Queue("heartbeat", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

export const agentJobQueue = new Queue("agent-jobs", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
  },
});

export function createWorker(
  queueName: string,
  processor: (job: { data: Record<string, unknown> }) => Promise<unknown>,
) {
  return new Worker(queueName, processor, {
    connection: redis,
    concurrency: 3,
  });
}
