/**
 * Template engine for `template`-kind widget refreshers.
 *
 * The agent writes a canvas-block template ONCE at save time. On refresh, the
 * server fetches the URL, parses JSON, and applies this engine to substitute
 * placeholders against the parsed data — no LLM in the loop.
 *
 * Grammar (intentionally tiny — anything more complex should use `agent` kind):
 *
 *   {{ $.path.to.value }}                      // jsonpath extraction
 *   {{ $.path | filter }}                      // filter chain (one or more)
 *   {{ $.field op rhs ? branchA : branchB }}   // ternary with simple comparison
 *
 * No eval, no arbitrary code. Hand-parsed regex grammar.
 */

const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
const TERNARY_RE = /^(.+?)\s*\?\s*([^:]+?)\s*:\s*(.+)$/;
const COMPARISON_RE = /^(\$[^\s|]*)\s*(>=|<=|==|!=|>|<)\s*(.+?)$/;

const FILTERS: Record<string, (value: unknown) => unknown> = {
  percent: (v) => {
    const n = Number(v);
    return Number.isNaN(n) ? "" : `${n.toFixed(2)}%`;
  },
  signed_pct: (v) => {
    const n = Number(v);
    if (Number.isNaN(n)) return "";
    return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  },
  usd: (v) => {
    const n = Number(v);
    if (Number.isNaN(n)) return "";
    if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
    if (Math.abs(n) >= 100) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  },
  nok: (v) => {
    const n = Number(v);
    return Number.isNaN(n) ? "" : `${n.toFixed(2)} NOK`;
  },
  integer: (v) => {
    const n = Number(v);
    return Number.isNaN(n) ? "" : Math.round(n);
  },
  comma_int: (v) => {
    const n = Number(v);
    return Number.isNaN(n) ? "" : Math.round(n).toLocaleString("en-US");
  },
  two_decimal: (v) => {
    const n = Number(v);
    return Number.isNaN(n) ? "" : n.toFixed(2);
  },
  upper: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
};

export const SUPPORTED_FILTERS = Object.keys(FILTERS);

// ── walk + substitute ─────────────────────────────────────────────────

export function applyTemplate(template: unknown, context: unknown): unknown {
  if (template === null || template === undefined) return template;
  if (typeof template === "string") return substituteString(template, context);
  if (Array.isArray(template)) return template.map((v) => applyTemplate(v, context));
  if (typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = applyTemplate(v, context);
    }
    return out;
  }
  return template;
}

function substituteString(s: string, context: unknown): unknown {
  // Single-placeholder strings return the raw evaluated value (so numbers stay numbers).
  const whole = s.match(/^\s*\{\{([^{}]*)\}\}\s*$/);
  if (whole) return evalExpression(whole[1], context);

  return s.replace(PLACEHOLDER_RE, (_match, expr: string) => {
    const value = evalExpression(expr, context);
    if (value === null || value === undefined) return "";
    return String(value);
  });
}

// ── expression evaluation ─────────────────────────────────────────────

function evalExpression(rawExpr: string, root: unknown): unknown {
  const expr = rawExpr.trim();
  if (!expr) throw new Error("Empty {{}} expression");

  // Ternary first (it can contain comparisons and embedded paths).
  const ternary = expr.match(TERNARY_RE);
  if (ternary) {
    const cond = ternary[1].trim();
    const truthy = ternary[2].trim();
    const falsy = ternary[3].trim();
    const condResult = evalCondition(cond, root);
    return evalBranch(condResult ? truthy : falsy, root);
  }

  // Filter chain: $.path | filter1 | filter2
  return evalFilterChain(expr, root);
}

function evalFilterChain(expr: string, root: unknown): unknown {
  const parts = expr.split("|").map((p) => p.trim());
  const path = parts[0];
  if (!path.startsWith("$")) {
    throw new Error(`Invalid expression "${expr}" — must start with $`);
  }
  let value: unknown = extractPath(path, root);
  for (let i = 1; i < parts.length; i++) {
    const fname = parts[i];
    const filter = FILTERS[fname];
    if (!filter) throw new Error(`Unknown filter "${fname}". Supported: ${SUPPORTED_FILTERS.join(", ")}`);
    value = filter(value);
  }
  return value;
}

function evalCondition(cond: string, root: unknown): boolean {
  const m = cond.match(COMPARISON_RE);
  if (!m) {
    throw new Error(`Invalid condition "${cond}" — expected "$.path <op> <literal>"`);
  }
  const left = extractPath(m[1], root);
  const op = m[2];
  const right = parseLiteral(m[3]);
  return compare(left, op, right);
}

function evalBranch(branch: string, root: unknown): unknown {
  const t = branch.trim();
  // Literal first.
  if (t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  const num = Number(t);
  if (!Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(t)) return num;
  // Otherwise — must be a path / filter chain.
  if (!t.startsWith("$")) {
    throw new Error(`Invalid ternary branch "${t}" — must be a literal or $-path`);
  }
  return evalFilterChain(t, root);
}

function parseLiteral(raw: string): unknown {
  const t = raw.trim();
  if (t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  throw new Error(`Unrecognized literal "${raw}" (expected number, string, or null)`);
}

function compare(left: unknown, op: string, right: unknown): boolean {
  // Coerce numeric strings on either side to numbers for ordering ops.
  const ln = typeof left === "number" ? left : typeof left === "string" && !isNaN(Number(left)) ? Number(left) : null;
  const rn = typeof right === "number" ? right : typeof right === "string" && !isNaN(Number(right)) ? Number(right) : null;
  if ((op === ">" || op === "<" || op === ">=" || op === "<=") && (ln === null || rn === null)) {
    return false;
  }
  if (ln !== null && rn !== null) {
    switch (op) {
      case ">":  return ln >  rn;
      case "<":  return ln <  rn;
      case ">=": return ln >= rn;
      case "<=": return ln <= rn;
      case "==": return ln === rn;
      case "!=": return ln !== rn;
    }
  }
  if (op === "==") return left === right;
  if (op === "!=") return left !== right;
  return false;
}

// ── jsonpath-lite ──────────────────────────────────────────────────────

const PATH_SEGMENT_RE = /\.([a-zA-Z_$][a-zA-Z0-9_$]*)|\[(\d+)\]|\["([^"]+)"\]|\['([^']+)'\]/g;

function extractPath(path: string, root: unknown): unknown {
  if (path === "$") return root;
  if (!path.startsWith("$")) return undefined;
  const rest = path.slice(1);
  let cur: unknown = root;
  PATH_SEGMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_SEGMENT_RE.exec(rest)) !== null) {
    if (cur === null || cur === undefined) return undefined;
    if (m[2] !== undefined) {
      // numeric index
      cur = Array.isArray(cur) ? (cur as unknown[])[Number(m[2])] : undefined;
    } else {
      const key = m[1] ?? m[3] ?? m[4];
      cur = typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
    }
  }
  return cur;
}

// ── write-time validation ─────────────────────────────────────────────

/**
 * Walk the template tree and validate every {{...}} placeholder syntactically.
 * Path-miss errors during runtime substitute "" — we don't surface those here.
 * Grammar errors (unclosed brace, unknown filter, malformed ternary) throw.
 */
export function validateTemplateSyntax(template: unknown): void {
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      const opens = (v.match(/\{\{/g) ?? []).length;
      const closes = (v.match(/\}\}/g) ?? []).length;
      if (opens !== closes) {
        throw new Error(`Unclosed {{ in template string: "${v.slice(0, 80)}"`);
      }
      // Try evaluating each {{}} against an empty root — only grammar errors matter.
      for (const match of v.matchAll(PLACEHOLDER_RE)) {
        try {
          evalExpression(match[1], {});
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Path-miss returns undefined; we never throw from path traversal alone.
          // So any thrown error here is a grammar error worth surfacing.
          throw new Error(`Template syntax error in {{${match[1]}}}: ${msg}`);
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) visit(val);
    }
  };
  visit(template);
}
