import { test, expect } from "vitest";
import { parseFromDeviceMessage } from "../../src/device-bridge/protocol.js";

test("parses a valid hello message", () => {
  const r = parseFromDeviceMessage(JSON.stringify({
    type: "hello",
    deviceId: "phone-1",
    deviceName: "Test Phone",
    platform: "ios",
    tools: [
      {
        name: "read_clipboard",
        description: "Read clipboard",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.message.type).toBe("hello");
    if (r.message.type === "hello") expect(r.message.tools).toHaveLength(1);
  }
});

test("parses tool_result with ok=true and arbitrary result", () => {
  const r = parseFromDeviceMessage(JSON.stringify({
    type: "tool_result",
    callId: "abc-123",
    ok: true,
    result: { foo: "bar" },
  }));
  expect(r.ok).toBe(true);
  if (r.ok && r.message.type === "tool_result") {
    expect(r.message.callId).toBe("abc-123");
    expect(r.message.ok).toBe(true);
    expect(r.message.result).toEqual({ foo: "bar" });
  }
});

test("parses tool_result with ok=false and error string", () => {
  const r = parseFromDeviceMessage(JSON.stringify({
    type: "tool_result",
    callId: "abc",
    ok: false,
    error: "device exploded",
  }));
  if (r.ok && r.message.type === "tool_result") {
    expect(r.message.ok).toBe(false);
    expect(r.message.error).toBe("device exploded");
  }
});

test("parses event messages", () => {
  const r = parseFromDeviceMessage(JSON.stringify({
    type: "event",
    name: "app_foregrounded",
    data: { battery: 80 },
  }));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.message.type).toBe("event");
});

test("rejects invalid JSON", () => {
  const r = parseFromDeviceMessage("not json");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("Invalid JSON");
});

test("rejects messages with unknown type", () => {
  const r = parseFromDeviceMessage(JSON.stringify({ type: "bogus" }));
  expect(r.ok).toBe(false);
});

test("rejects hello with malformed tool inputSchema", () => {
  const r = parseFromDeviceMessage(JSON.stringify({
    type: "hello",
    deviceId: "phone-1",
    deviceName: "Test Phone",
    platform: "ios",
    tools: [{ name: "x", description: "y", inputSchema: { type: "array" } }],
  }));
  expect(r.ok).toBe(false);
});

test("rejects hello with unknown platform", () => {
  const r = parseFromDeviceMessage(JSON.stringify({
    type: "hello",
    deviceId: "phone-1",
    deviceName: "Test Phone",
    platform: "windows",
    tools: [],
  }));
  expect(r.ok).toBe(false);
});
