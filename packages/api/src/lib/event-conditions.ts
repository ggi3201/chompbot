/**
 * Field-level conditions evaluated against arbitrary objects (typically
 * ChompEvents in the proactive engine and event trigger evaluator).
 *
 * Extracted from the duplicated copies that previously lived in
 *   - proactive/engine.ts
 *   - events/trigger-evaluator.ts
 *
 * Pure: no DB, no I/O, no globals — safe to test in isolation.
 */

export interface FieldCondition {
  /** Dot-path into the target object (e.g. "type", "payload.action"). */
  field: string;
  op: "eq" | "neq" | "contains";
  /** Comparison value as a string. The target value is also coerced to a string. */
  value: string;
}

/** Read a nested value out of `obj` using dot-notation. Returns undefined for missing paths. */
export function getField(obj: Record<string, unknown>, field: string): unknown {
  const parts = field.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Evaluate a single condition against `target`. Missing paths compare as the empty string. */
export function evaluateCondition(target: Record<string, unknown>, condition: FieldCondition): boolean {
  const fieldValue = String(getField(target, condition.field) ?? "");
  switch (condition.op) {
    case "eq":
      return fieldValue === condition.value;
    case "neq":
      return fieldValue !== condition.value;
    case "contains":
      return fieldValue.includes(condition.value);
    default:
      return false;
  }
}

/**
 * AND-evaluate a list of conditions against `target`.
 *
 * - Empty conditions list → true (no conditions = always match).
 * - Null/undefined target with non-empty conditions → true. This preserves the
 *   permissive behavior used by periodic proactive rules that pass no event;
 *   callers that want strict matching should pre-check for null.
 */
export function evaluateConditions(
  target: Record<string, unknown> | null | undefined,
  conditions: FieldCondition[],
): boolean {
  if (conditions.length === 0) return true;
  if (!target) return true;
  return conditions.every((c) => evaluateCondition(target, c));
}
