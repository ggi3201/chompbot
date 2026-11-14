// In-memory registry of connected devices.
//
// Holds the active WebSocket session per device, the tools each device has
// advertised, and the table of in-flight tool calls awaiting a response.
//
// Lifetime is process-only — devices reconnect and re-advertise on every
// new WebSocket session. No persistence yet (intentional; this is the
// simplest correct shape for a personal-use bridge).

import type { WebSocket } from "ws";
import { randomUUID } from "crypto";
import type {
  DevicePlatform,
  DeviceToolDefinition,
  ToDeviceMessage,
  ToolCallMessage,
} from "./protocol.js";

export interface DeviceSession {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  platform: DevicePlatform;
  tools: DeviceToolDefinition[];
  connectedAt: number;
  lastSeen: number;
  send: (msg: ToDeviceMessage) => void;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
  name: string;
}

// The app is in the background while a Shortcut runs, so its socket can drop.
// The result arrives after the app reconnects, and the call's timeout still applies.
const OUTLIVES_DISCONNECT = new Set(["run_shortcut"]);

export class DeviceRegistry {
  private sessionsById = new Map<string, DeviceSession>();
  private sessionByDeviceId = new Map<string, string>();
  private pendingCalls = new Map<string, PendingCall>();
  /**
   * Per-deviceId list of resolvers awaiting a (re)connect. Drained by
   * `register()` so anyone who called `awaitDeviceConnect` while the device
   * was offline gets woken the instant it comes back.
   */
  private connectWaiters = new Map<string, Array<(s: DeviceSession) => void>>();

  register(session: DeviceSession): void {
    // Replace any prior session for the same deviceId (reconnect).
    const prior = this.sessionByDeviceId.get(session.deviceId);
    if (prior && prior !== session.sessionId) {
      this.unregister(prior);
    }
    this.sessionsById.set(session.sessionId, session);
    this.sessionByDeviceId.set(session.deviceId, session.sessionId);

    // Notify anyone waiting for this device.
    const waiters = this.connectWaiters.get(session.deviceId);
    if (waiters && waiters.length) {
      this.connectWaiters.delete(session.deviceId);
      for (const w of waiters) {
        try { w(session); } catch { /* swallow */ }
      }
    }
  }

  /**
   * Wait up to `timeoutMs` for a device with this deviceId to (re)connect.
   * Returns the session if it arrives in time, `null` on timeout. Used by
   * the bridge dispatcher to await an APNs-wakeup reconnect before failing
   * a tool call.
   */
  awaitDeviceConnect(deviceId: string, timeoutMs: number): Promise<DeviceSession | null> {
    const existing = this.getByDeviceId(deviceId);
    if (existing) return Promise.resolve(existing);
    return new Promise<DeviceSession | null>((resolve) => {
      const arr = this.connectWaiters.get(deviceId) ?? [];
      const onConnect = (s: DeviceSession) => {
        clearTimeout(timer);
        resolve(s);
      };
      arr.push(onConnect);
      this.connectWaiters.set(deviceId, arr);
      const timer = setTimeout(() => {
        const list = this.connectWaiters.get(deviceId);
        if (list) {
          const i = list.indexOf(onConnect);
          if (i >= 0) list.splice(i, 1);
          if (list.length === 0) this.connectWaiters.delete(deviceId);
        }
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  unregister(sessionId: string): void {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;
    this.sessionsById.delete(sessionId);
    if (this.sessionByDeviceId.get(session.deviceId) === sessionId) {
      this.sessionByDeviceId.delete(session.deviceId);
    }
    // Reject any in-flight calls for this session.
    for (const [callId, pending] of this.pendingCalls) {
      if (pending.sessionId === sessionId && !OUTLIVES_DISCONNECT.has(pending.name)) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Device disconnected"));
        this.pendingCalls.delete(callId);
      }
    }
  }

  touch(sessionId: string): void {
    const session = this.sessionsById.get(sessionId);
    if (session) session.lastSeen = Date.now();
  }

  getBySession(sessionId: string): DeviceSession | undefined {
    return this.sessionsById.get(sessionId);
  }

  getByDeviceId(deviceId: string): DeviceSession | undefined {
    const sessionId = this.sessionByDeviceId.get(deviceId);
    return sessionId ? this.sessionsById.get(sessionId) : undefined;
  }

  list(): DeviceSession[] {
    return [...this.sessionsById.values()];
  }

  /** Resolve a deviceId given an optional explicit choice. */
  resolveDevice(preferredDeviceId?: string): DeviceSession | { error: string } {
    if (preferredDeviceId) {
      const session = this.getByDeviceId(preferredDeviceId);
      if (!session) return { error: `No connected device with id "${preferredDeviceId}"` };
      return session;
    }
    const all = this.list();
    if (all.length === 0) return { error: "No devices connected" };
    if (all.length > 1) {
      return {
        error: `Multiple devices connected (${all.map((d) => d.deviceId).join(", ")}); specify device_id`,
      };
    }
    return all[0];
  }

  callTool(
    deviceId: string,
    name: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const session = this.getByDeviceId(deviceId);
    if (!session) return Promise.reject(new Error(`Device "${deviceId}" not connected`));
    const tool = session.tools.find((t) => t.name === name);
    if (!tool) {
      return Promise.reject(new Error(`Device "${deviceId}" has no tool "${name}"`));
    }

    const callId = randomUUID();
    const message: ToolCallMessage = { type: "tool_call", callId, name, args };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        reject(new Error(`Device tool "${name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Don't keep the event loop alive solely for a pending RPC.
      timer.unref?.();
      this.pendingCalls.set(callId, { resolve, reject, timer, sessionId: session.sessionId, name });
      try {
        session.send(message);
      } catch (err) {
        clearTimeout(timer);
        this.pendingCalls.delete(callId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Resolve a tool_result from a device. */
  resolveCall(callId: string, payload: { ok: boolean; result?: unknown; error?: string }): boolean {
    const pending = this.pendingCalls.get(callId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingCalls.delete(callId);
    if (payload.ok) {
      pending.resolve(payload.result);
    } else {
      pending.reject(new Error(payload.error ?? "Device returned an error"));
    }
    return true;
  }

  /** Test helper: number of in-flight calls. */
  pendingCount(): number {
    return this.pendingCalls.size;
  }
}

/** Process-wide default registry. */
export const deviceRegistry: DeviceRegistry = new DeviceRegistry();

/** Build a send() function that serializes ToDeviceMessage onto a ws. */
export function wsSender(ws: WebSocket): (msg: ToDeviceMessage) => void {
  return (msg) => {
    ws.send(JSON.stringify(msg));
  };
}
