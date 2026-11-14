import express from "express";
import { randomUUID } from "crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

const dispatch = vi.hoisted(() => ({ dispatchToAgent: vi.fn() }));
vi.mock("../../src/agents/dispatch.js", () => dispatch);
const client = vi.hoisted(() => ({ alertsTarget: vi.fn() }));
vi.mock("../../src/monitoring/alerts-client.js", () => client);

import { db } from "../../src/db/index.js";
import { chatMessages, conversations, incidents } from "../../src/db/schema.js";
import { alertsIdle } from "../../src/monitoring/alerts.js";
import { buildDiagnosisPrompt, startDiagnosis } from "../../src/monitoring/diagnose.js";
import { applyStatusChange, getIncident, listIncidents } from "../../src/monitoring/incidents.js";
import monitoringRoutes from "../../src/routes/monitoring.js";
import { addTarget, clearMonitoring, NOW, serve } from "./helpers.js";

const api = {
  sendMessage: vi.fn(async (_chat: number, _text: string, _opts?: Record<string, unknown>) => ({ message_id: 100 })),
  editMessageText: vi.fn(async () => true),
};

/** The agent says these, in order, through chomp_reply. */
let answers: string[] = [];
const say = (conversationId: string, text: string) =>
  db.insert(chatMessages).values({ id: randomUUID(), conversationId, role: "assistant", content: text }).run();

const clock = () => NOW + 120_000;
let release: (() => void) | null = null;
beforeEach(() => {
  clearMonitoring();
  db.delete(chatMessages).run();
  db.delete(conversations).run();
  answers = ["Looking at the logs", "The disk is full: no space left on device"];
  release = null;
  api.sendMessage.mockClear();
  client.alertsTarget.mockReturnValue({ api, chatId: 555 });
  dispatch.dispatchToAgent.mockReset();
  dispatch.dispatchToAgent.mockImplementation(async (_routing, ctx: { conversationId: string }) => {
    for (const text of answers) say(ctx.conversationId, text);
    return { response: "trailing prose that is not the answer", agentUsed: "Claude" };
  });
});

/** An open incident for a container, with the alert already sent. */
async function openIncident() {
  addTarget({ key: "web", title: "Web", status: "down", container: "web-1", image: "ghcr.io/x/web:1", url: "https://web.example.com" });
  applyStatusChange({ key: "web" }, { vantage: "home", status: "down", error: "HTTP 502" }, NOW);
  applyStatusChange({ key: "web" }, { vantage: "home", status: "down", error: "HTTP 502" }, NOW + 60_000);
  await alertsIdle();
  api.sendMessage.mockClear();
  return db.select().from(incidents).get()!;
}

// Safety, not wording: the diagnosing agent runs unattended and must only look.
test("the diagnosis prompt names the incident and forbids changing anything", async () => {
  const incident = await openIncident();
  const prompt = buildDiagnosisPrompt(getIncident(incident.id)!);
  expect(prompt).toContain("Incident: Web is down");
  expect(prompt).toContain("Do not restart, stop, start, change, delete or deploy anything");
});

test("a diagnosis runs in the incident's own conversation, saves the last chomp_reply, and replies under the alert", async () => {
  const incident = await openIncident();
  const start = startDiagnosis(incident.id, clock);
  expect(start.started).toBe(true);
  await (start as { done: Promise<void> }).done;

  const [routing, ctx, options] = dispatch.dispatchToAgent.mock.calls[0];
  expect(routing.prompt).toContain("Incident: Web is down");
  expect(options).toMatchObject({ deliveryChannel: "proactive", autonomy: "autonomous" });
  const detail = getIncident(incident.id)!;
  expect(detail.conversationId).toBe(ctx.conversationId);
  expect(db.select().from(conversations).get()).toMatchObject({ id: ctx.conversationId, title: "Monitoring: Web is down" });

  // The answer is the agent's last message in the conversation, not result.response.
  expect(detail.diagnosisText).toBe("The disk is full: no space left on device");
  expect(detail.diagnosis).toBe("done");
  expect(detail.events.map((e) => e.kind)).toEqual(["opened", "alerted", "diagnosis_requested", "diagnosis"]);
  expect(api.sendMessage).toHaveBeenCalledWith(555, "The disk is full: no space left on device", expect.objectContaining({ reply_parameters: { message_id: 100, allow_sending_without_reply: true } }));
});

test("one diagnosis runs per incident at a time, and the row shows it", async () => {
  const incident = await openIncident();
  dispatch.dispatchToAgent.mockImplementationOnce(async (_routing, ctx: { conversationId: string }) => {
    await new Promise<void>((resolve) => { release = resolve; });
    say(ctx.conversationId, "done");
    return { response: "" };
  });
  const first = startDiagnosis(incident.id, clock);
  expect(first.started).toBe(true);
  expect(startDiagnosis(incident.id, clock)).toEqual({ started: false, reason: "running" });
  await vi.waitFor(() => expect(release).not.toBeNull());
  expect(listIncidents({ now: NOW + 61_000 })[0].diagnosis).toBe("running");

  release!();
  await (first as { done: Promise<void> }).done;
  expect(listIncidents({ now: NOW + 61_000 })[0].diagnosis).toBe("done");
  expect(dispatch.dispatchToAgent).toHaveBeenCalledTimes(1);
});

test("a second diagnosis continues in the same conversation and reads only the new answer", async () => {
  const incident = await openIncident();
  await (startDiagnosis(incident.id, clock) as { done: Promise<void> }).done;
  answers = ["After a restart the disk is still full"];
  await (startDiagnosis(incident.id, clock) as { done: Promise<void> }).done;
  expect(dispatch.dispatchToAgent.mock.calls[1][1].conversationId).toBe(dispatch.dispatchToAgent.mock.calls[0][1].conversationId);
  expect(getIncident(incident.id)?.diagnosisText).toBe("After a restart the disk is still full");
  expect(db.select().from(conversations).all()).toHaveLength(1);
});

test("when the agent only wrote prose outside tool calls, that prose is the answer; an agent that says nothing is a failed diagnosis", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const incident = await openIncident();
  answers = [];
  dispatch.dispatchToAgent.mockResolvedValueOnce({ response: " Out of memory. ", agentUsed: "Claude" });
  await (startDiagnosis(incident.id, clock) as { done: Promise<void> }).done;
  expect(getIncident(incident.id)?.diagnosisText).toBe("Out of memory.");

  dispatch.dispatchToAgent.mockResolvedValueOnce({ response: "", agentUsed: "Claude" });
  await (startDiagnosis(incident.id, clock) as { done: Promise<void> }).done;
  expect(getIncident(incident.id)?.events.at(-1)).toMatchObject({ kind: "diagnosis_failed", text: "The agent gave no answer" });
  log.mockRestore();
});

test("a failed diagnosis is saved and reported, and the incident can be diagnosed again", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const incident = await openIncident();
  dispatch.dispatchToAgent.mockRejectedValueOnce(new Error("Max concurrent agents reached"));
  await (startDiagnosis(incident.id, clock) as { done: Promise<void> }).done;
  const detail = getIncident(incident.id)!;
  expect(detail.diagnosis).toBe("failed");
  expect(detail.diagnosisText).toBeNull();
  expect(detail.events.at(-1)).toMatchObject({ kind: "diagnosis_failed", text: "Max concurrent agents reached" });
  expect(api.sendMessage).toHaveBeenCalledWith(555, "Diagnosis failed: Max concurrent agents reached", expect.anything());

  const again = startDiagnosis(incident.id, clock);
  expect(again.started).toBe(true);
  await (again as { done: Promise<void> }).done;
  log.mockRestore();
});


// ── Routes ──────────────────────────────────────────────────────────────

let server: Awaited<ReturnType<typeof serve>>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/monitoring", monitoringRoutes);
  server = await serve(app);
});
afterAll(() => server.close());

test("GET /incidents/:id returns the incident with its services, timeline and cause; 404 for an unknown id; GET /incidents rows carry the same", async () => {
  const incident = await openIncident();
  const body = await (await fetch(`${server.url}/api/monitoring/incidents/${incident.id}`)).json();
  expect(body.incident).toMatchObject({
    id: incident.id, title: "Web is down", cause: "Web", causeKey: "web", state: "open", flapping: false, diagnosis: "none", diagnosisText: null,
    targets: [{ key: "web", title: "Web", upAt: null }],
    events: [{ kind: "opened", text: "HTTP 502" }, { kind: "alerted" }],
  });
  expect((await fetch(`${server.url}/api/monitoring/incidents/nope`)).status).toBe(404);
  const { incidents: rows } = await (await fetch(`${server.url}/api/monitoring/incidents`)).json();
  expect(rows[0]).toMatchObject({ cause: "Web", causeKey: "web", flapping: false, diagnosis: "none" });
});

test("POST /incidents/:id/diagnose answers 202 at once, 409 while it runs, and 404 for an unknown incident", async () => {
  const incident = await openIncident();
  dispatch.dispatchToAgent.mockImplementationOnce(async (_routing, ctx: { conversationId: string }) => {
    await new Promise<void>((resolve) => { release = resolve; });
    say(ctx.conversationId, "Disk full");
    return { response: "" };
  });
  const post = (id: string) => fetch(`${server.url}/api/monitoring/incidents/${id}/diagnose`, { method: "POST" });

  const first = await post(incident.id);
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ status: "running" });
  expect((await post(incident.id)).status).toBe(409);
  expect((await post("nope")).status).toBe(404);

  release!();
  await vi.waitFor(() => expect(getIncident(incident.id)?.diagnosis).toBe("done"));
});
