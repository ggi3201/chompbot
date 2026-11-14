/**
 * In-process event bus for the API. Uses a typed EventEmitter.
 * Can be extended with Redis pub/sub for cross-process events when needed.
 */
import { EventEmitter } from "events";
import type { ChompEvent } from "@chomp/shared";

const emitter = new EventEmitter();
emitter.setMaxListeners(50); // Allow many subscribers

/** Emit an event to all listeners */
export function emit(event: ChompEvent) {
  console.log(`[events] ${event.type}`);
  emitter.emit("event", event);
  emitter.emit(event.type, event);
}

/** Subscribe to all events */
export function on(handler: (event: ChompEvent) => void) {
  emitter.on("event", handler);
}

/** Subscribe to a specific event type */
export function onType<T extends ChompEvent["type"]>(
  type: T,
  handler: (event: Extract<ChompEvent, { type: T }>) => void,
) {
  emitter.on(type, handler);
}

/** Unsubscribe a handler from all events */
export function off(handler: (event: ChompEvent) => void) {
  emitter.off("event", handler);
}

/** Get recent events (ring buffer) */
const recentEvents: ChompEvent[] = [];
const MAX_RECENT = 50;

on((event) => {
  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT) recentEvents.shift();
});

export function getRecentEvents(): ChompEvent[] {
  return [...recentEvents];
}
