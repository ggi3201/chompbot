// Wire protocol for the device bridge.
//
// A "device" (e.g. a personal iPhone app) connects to /device-bridge over
// WebSocket, advertises a set of locally-executable tools, and acts as a
// remote tool-executor for Chomp's agent. The agent calls those tools by
// sending tool_call messages; the device responds with tool_result. The
// agent → device direction is RPC-style (matched by callId).

import { z } from "zod";

const jsonSchemaShape = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(),
});

export const deviceToolDefinitionSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1024),
  inputSchema: jsonSchemaShape,
});
export type DeviceToolDefinition = z.infer<typeof deviceToolDefinitionSchema>;

export const devicePlatformSchema = z.enum(["ios", "android", "macos", "node"]);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

// ── Device → Server ───────────────────────────────────────────────

export const helloMessageSchema = z.object({
  type: z.literal("hello"),
  deviceId: z.string().min(1).max(128),
  deviceName: z.string().min(1).max(128),
  platform: devicePlatformSchema,
  tools: z.array(deviceToolDefinitionSchema).max(256),
});
export type HelloMessage = z.infer<typeof helloMessageSchema>;

export const toolResultMessageSchema = z.object({
  type: z.literal("tool_result"),
  callId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type ToolResultMessage = z.infer<typeof toolResultMessageSchema>;

export const eventMessageSchema = z.object({
  type: z.literal("event"),
  name: z.string().min(1),
  data: z.unknown().optional(),
});
export type EventMessage = z.infer<typeof eventMessageSchema>;

export const heartbeatMessageSchema = z.object({
  type: z.literal("heartbeat"),
});
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;

export const fromDeviceMessageSchema = z.discriminatedUnion("type", [
  helloMessageSchema,
  toolResultMessageSchema,
  eventMessageSchema,
  heartbeatMessageSchema,
]);
export type FromDeviceMessage = z.infer<typeof fromDeviceMessageSchema>;

// ── Server → Device ───────────────────────────────────────────────

export interface WelcomeMessage {
  type: "welcome";
  sessionId: string;
}

export interface ToolCallMessage {
  type: "tool_call";
  callId: string;
  name: string;
  args: unknown;
}

export interface ServerHeartbeatMessage {
  type: "heartbeat";
}

export interface ServerErrorMessage {
  type: "error";
  error: string;
}

export type ToDeviceMessage =
  | WelcomeMessage
  | ToolCallMessage
  | ServerHeartbeatMessage
  | ServerErrorMessage;

export type ParseFromDeviceResult =
  | { ok: true; message: FromDeviceMessage }
  | { ok: false; error: string };

export function parseFromDeviceMessage(raw: string): ParseFromDeviceResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  const result = fromDeviceMessageSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return { ok: true, message: result.data };
}
