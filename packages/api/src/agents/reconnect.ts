/**
 * Agent Reconnection — on API startup, find agents that survived a restart
 * and reconnect to them (re-register in memory, tail logs, poll for exit).
 */

import { existsSync, unlinkSync, readFileSync } from "fs";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentSessions } from "../db/schema.js";
import {
  registerSession,
  registerKillCallback,
  completeSession,
  isProcessAlive,
  updateOutput,
  setLastActivity,
  touchSession,
} from "./registry.js";
import { tailFile, type TailHandle } from "./log-tailer.js";

/** How often to check if a reconnected agent's PID is still alive */
const PID_POLL_INTERVAL = 5_000;

/** Delay after PID death before finalizing (let log tailer flush) */
const FINALIZE_DELAY = 1_000;

/**
 * Scan the DB for sessions with status "running", verify their PIDs,
 * and reconnect to alive agents or mark dead ones as crashed.
 *
 * Call this once during API startup, after DB migrations have run.
 */
export function reconnectSurvivingAgents(): { reconnected: number; crashed: number } {
  const runningSessions = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.status, "running"))
    .all();

  if (runningSessions.length === 0) return { reconnected: 0, crashed: 0 };

  let reconnected = 0;
  let crashed = 0;

  for (const row of runningSessions) {
    const pid = row.pid;
    if (!pid || !isProcessAlive(pid)) {
      // Process is dead — mark as crashed
      db.update(agentSessions)
        .set({
          status: "crashed",
          error: "API restarted and agent process was no longer running",
          endedAt: new Date().toISOString(),
        })
        .where(eq(agentSessions.sessionId, row.sessionId))
        .run();

      // Clean up log files
      if (row.logPath) {
        try { unlinkSync(row.logPath); } catch {}
        try { unlinkSync(row.logPath.replace(".jsonl", ".stderr")); } catch {}
      }

      crashed++;
      console.log(`[reconnect] Marked crashed: ${row.agentName} (PID ${pid ?? "??"}, session ${row.sessionId.slice(0, 8)})`);
      continue;
    }

    // Process is alive — reconnect
    const startedAt = row.startedAt ? new Date(row.startedAt).getTime() : Date.now();

    registerSession({
      sessionId: row.sessionId,
      ccSessionId: row.ccSessionId ?? undefined,
      agentName: row.agentName,
      agentType: row.agentType,
      conversationId: row.conversationId ?? undefined,
      pid,
      prompt: row.prompt ?? undefined,
      userPrompt: row.userPrompt ?? undefined,
      label: row.label ?? undefined,
      model: row.model ?? undefined,
      logPath: row.logPath ?? undefined,
      startedAt,
    });

    registerKillCallback(row.sessionId, () => {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    });

    // Start tailing the log file if it exists
    let tailHandle: TailHandle | null = null;
    if (row.logPath && existsSync(row.logPath)) {
      tailHandle = tailFile(row.logPath, (line) => {
        updateOutput(row.sessionId, Buffer.byteLength(line, "utf-8"));

        // Parse JSON events for activity tracking
        let event: any;
        try { event = JSON.parse(line); } catch { return; }

        // Claude Code events
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === "tool_use") {
              setLastActivity(row.sessionId, { tool: block.name, summary: `Using ${block.name}` });
            }
          }
        }
        // Codex events
        if (event.type === "item.started" || event.type === "item.completed") {
          const item = event.item ?? {};
          if (item.type === "command_execution") {
            setLastActivity(row.sessionId, { tool: "Shell", summary: "Running command" });
          } else if (item.type === "file_edit") {
            setLastActivity(row.sessionId, { tool: "Edit", summary: `Editing ${item.file_path ?? "file"}` });
          }
        }
      });
    }

    // Poll for PID death — when the agent finishes, complete the session
    const pollInterval = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(pollInterval);
        // Give the log tailer a moment to flush remaining data
        setTimeout(() => {
          tailHandle?.stop();
          // Parse the log file for a result event to determine exit status
          const status = detectExitStatus(row.logPath);
          completeSession(row.sessionId, status);
          console.log(`[reconnect] Agent finished post-restart: ${row.agentName} (${status})`);
        }, FINALIZE_DELAY);
      } else {
        touchSession(row.sessionId);
      }
    }, PID_POLL_INTERVAL);
    // Don't let the poll keep the process alive
    pollInterval.unref();

    reconnected++;
    console.log(`[reconnect] Reconnected to ${row.agentName} (PID ${pid}, session ${row.sessionId.slice(0, 8)})`);
  }

  return { reconnected, crashed };
}

/**
 * Read the tail of a log file looking for a "result" event to determine
 * whether the agent completed successfully or failed.
 */
function detectExitStatus(logPath: string | null): "completed" | "failed" | "crashed" {
  if (!logPath || !existsSync(logPath)) return "crashed";

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");

    // Scan from the end for a result event
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === "result") {
          return event.is_error ? "failed" : "completed";
        }
      } catch { continue; }
    }
  } catch { /* file read error */ }

  return "crashed";
}
