import { test, expect, vi } from "vitest";
import { DeviceRegistry, type DeviceSession } from "../../src/device-bridge/registry.js";
import type { ToDeviceMessage, DeviceToolDefinition } from "../../src/device-bridge/protocol.js";

function makeSession(deviceId: string, tools: DeviceToolDefinition[], send: (m: ToDeviceMessage) => void = () => {}): DeviceSession {
  const now = Date.now();
  return {
    sessionId: `s-${deviceId}-${now}-${Math.random()}`,
    deviceId,
    deviceName: deviceId.toUpperCase(),
    platform: "node",
    tools,
    connectedAt: now,
    lastSeen: now,
    send,
  };
}

const echoTool: DeviceToolDefinition = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object", properties: {} },
};

test("register / unregister round-trip, and re-registering the same deviceId replaces the prior session", () => {
  const reg = new DeviceRegistry();
  const a = makeSession("phone-1", [echoTool]);
  const b = makeSession("phone-1", []);
  reg.register(a);
  expect(reg.getByDeviceId("phone-1")).toBe(a);
  reg.register(b);
  expect(reg.getBySession(a.sessionId)).toBeUndefined();
  expect(reg.getByDeviceId("phone-1")).toBe(b);
  reg.unregister(b.sessionId);
  expect(reg.getByDeviceId("phone-1")).toBeUndefined();
});

test("resolveDevice: none errors, one is picked, several need an explicit device_id", () => {
  const reg = new DeviceRegistry();
  expect("error" in reg.resolveDevice()).toBe(true);

  reg.register(makeSession("a", []));
  expect(reg.resolveDevice()).toMatchObject({ deviceId: "a" });

  reg.register(makeSession("b", []));
  expect("error" in reg.resolveDevice()).toBe(true);
  expect(reg.resolveDevice("b")).toMatchObject({ deviceId: "b" });
});

test("callTool sends a tool_call and resolves on matching tool_result", async () => {
  const reg = new DeviceRegistry();
  let captured: ToDeviceMessage | undefined;
  const session = makeSession("phone-1", [echoTool], (msg) => { captured = msg; });
  reg.register(session);

  const pending = reg.callTool("phone-1", "echo", { hi: 1 }, 5_000);

  expect(captured?.type).toBe("tool_call");
  if (captured?.type === "tool_call") {
    expect(captured.name).toBe("echo");
    expect(captured.args).toEqual({ hi: 1 });
    const handled = reg.resolveCall(captured.callId, { ok: true, result: { hi: 1 } });
    expect(handled).toBe(true);
  }
  await expect(pending).resolves.toEqual({ hi: 1 });
  expect(reg.pendingCount()).toBe(0);
  expect(reg.resolveCall("never-existed", { ok: true })).toBe(false);
});

test("callTool rejects when device returns ok=false", async () => {
  const reg = new DeviceRegistry();
  let captured: ToDeviceMessage | undefined;
  const session = makeSession("phone-1", [echoTool], (msg) => { captured = msg; });
  reg.register(session);

  const pending = reg.callTool("phone-1", "echo", {}, 5_000);
  if (captured?.type === "tool_call") {
    reg.resolveCall(captured.callId, { ok: false, error: "nope" });
  }
  await expect(pending).rejects.toThrow(/nope/);
});

test("callTool rejects on disconnect", async () => {
  const reg = new DeviceRegistry();
  const session = makeSession("phone-1", [echoTool]);
  reg.register(session);
  const pending = reg.callTool("phone-1", "echo", {}, 5_000);
  reg.unregister(session.sessionId);
  await expect(pending).rejects.toThrow(/disconnect/i);
});

test("callTool rejects on timeout", async () => {
  vi.useFakeTimers();
  try {
    const reg = new DeviceRegistry();
    const session = makeSession("phone-1", [echoTool]);
    reg.register(session);
    const pending = reg.callTool("phone-1", "echo", {}, 1_000);
    vi.advanceTimersByTime(1_500);
    await expect(pending).rejects.toThrow(/timed out/);
    expect(reg.pendingCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("callTool rejects for a missing device and for an unknown tool on the device", async () => {
  const reg = new DeviceRegistry();
  await expect(reg.callTool("nope", "echo", {}, 1_000)).rejects.toThrow(/not connected/);
  reg.register(makeSession("phone-1", [echoTool]));
  await expect(reg.callTool("phone-1", "missing", {}, 1_000)).rejects.toThrow(/no tool/);
});

test("a running Shortcut survives a disconnect, and its result arrives on the next session", async () => {
  const reg = new DeviceRegistry();
  const sent: ToDeviceMessage[] = [];
  const tool = (name: string) => ({ ...echoTool, name });
  const first = makeSession("phone-1", [tool("run_shortcut"), echoTool], (m) => sent.push(m));
  reg.register(first);

  const shortcut = reg.callTool("phone-1", "run_shortcut", { name: "Hello" }, 5_000);
  const other = reg.callTool("phone-1", "echo", {}, 5_000);
  reg.unregister(first.sessionId);
  await expect(other).rejects.toThrow("Device disconnected");

  reg.register(makeSession("phone-1", [tool("run_shortcut")]));
  const call = sent.find((m) => m.type === "tool_call" && m.name === "run_shortcut");
  if (call?.type !== "tool_call") throw new Error("no call sent");
  expect(reg.resolveCall(call.callId, { ok: true, result: { output: "hi" } })).toBe(true);
  await expect(shortcut).resolves.toEqual({ output: "hi" });
});
