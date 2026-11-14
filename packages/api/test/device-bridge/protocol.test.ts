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

test("parses tool_result with ok=true and a result, or ok=false and an error", () => {
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

  const failed = parseFromDeviceMessage(JSON.stringify({
    type: "tool_result",
    callId: "abc",
    ok: false,
    error: "device exploded",
  }));
  if (failed.ok && failed.message.type === "tool_result") {
    expect(failed.message.ok).toBe(false);
    expect(failed.message.error).toBe("device exploded");
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

test("rejects unknown types, hello with a malformed tool inputSchema, and hello with an unknown platform", () => {
  const r = parseFromDeviceMessage(JSON.stringify({ type: "bogus" }));
  expect(r.ok).toBe(false);

  const malformedSchema = parseFromDeviceMessage(JSON.stringify({
    type: "hello",
    deviceId: "phone-1",
    deviceName: "Test Phone",
    platform: "ios",
    tools: [{ name: "x", description: "y", inputSchema: { type: "array" } }],
  }));
  expect(malformedSchema.ok).toBe(false);

  const unknownPlatform = parseFromDeviceMessage(JSON.stringify({
    type: "hello",
    deviceId: "phone-1",
    deviceName: "Test Phone",
    platform: "windows",
    tools: [],
  }));
  expect(unknownPlatform.ok).toBe(false);
});
