import { expect, test } from "vitest";
import { runScriptGate } from "../../src/proactive/script-gates.js";

const gate = (json: string) => ({ script: "command", input: { command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(json)})`] } });

test("command gate matches only when stdout JSON says matched:true", async () => {
  const hit = await runScriptGate(gate('{"matched":true,"summary":"2 new","new":2}'));
  expect(hit).toMatchObject({ matched: true, script: "command", summary: "2 new", data: { new: 2 } });
  const miss = await runScriptGate(gate('{"matched":false,"summary":"nothing new"}'));
  expect(miss).toMatchObject({ matched: false, summary: "nothing new" });
});

test("command gate fails loudly on bad output, a non-zero exit or a relative path", async () => {
  await expect(runScriptGate(gate("not json"))).rejects.toThrow(/not JSON/);
  await expect(runScriptGate({ script: "command", input: { command: [process.execPath, "-e", "process.exit(3)"] } })).rejects.toThrow();
  await expect(runScriptGate({ script: "command", input: { command: ["python3", "x.py"] } })).rejects.toThrow(/absolute path/);
});
