#!/usr/bin/env node
// Chomp CLI — same capabilities as the chomp-api MCP server, exposed as a
// shell command. Zero dependencies, talks to the Chomp REST API on
// /mcp/tools/list and /mcp/tools/call. Intended for environments where MCP
// is unavailable or disabled.
//
// Usage:
//   chomp <tool> [--key value | --key=value] [--json '<args-json>']
//   chomp tools list [--json]
//   chomp tools schema <tool>
//   chomp help [tool]
//
// Auth/transport env vars (override with CLI flags --host/--port/--secret/--session-id):
//   CHOMP_HOST        default 127.0.0.1
//   CHOMP_PORT        default 3001
//   CHOMP_MCP_SECRET  optional, sent as X-Chomp-MCP-Secret
//   CHOMP_SESSION_ID  required only for session-bound tools (reply, ask_user)
//
// Output: prints the first text-typed content item to stdout, exits 1 on
// isError. Use --raw to print the full JSON response.

import http from "node:http";

const DEFAULT_HOST = process.env.CHOMP_HOST || "127.0.0.1";
const DEFAULT_PORT = process.env.CHOMP_PORT || "3001";
const DEFAULT_SECRET = process.env.CHOMP_MCP_SECRET || "";
const DEFAULT_SESSION = process.env.CHOMP_SESSION_ID || "";

const argv = process.argv.slice(2);

function fail(msg, code = 2) {
  process.stderr.write(`chomp: ${msg}\n`);
  process.exit(code);
}

function printHelp() {
  process.stdout.write(
    `Chomp CLI — call any Chomp MCP tool from the shell.

Usage:
  chomp <tool> [--key value | --key=value]...   Call a tool with named args
  chomp <tool> --json '<args-json>'             Call a tool with raw JSON args
  chomp tools list [--json]                     List all available tools
  chomp tools schema <tool>                     Show the input schema for a tool
  chomp help [tool]                             Show this help, or per-tool help

Tool names accept any of: reply, chomp_reply, mcp__chomp-api__reply.

Flags (override env):
  --host <host>          Chomp API host (env CHOMP_HOST, default 127.0.0.1)
  --port <port>          Chomp API port (env CHOMP_PORT, default 3001)
  --secret <s>           MCP secret    (env CHOMP_MCP_SECRET)
  --session-id <id>      Session id    (env CHOMP_SESSION_ID, required for reply/ask_user)
  --raw                  Print the full JSON response instead of the text payload
  --json '<args>'        Pass arguments as a JSON object (overrides --key flags)
  --                     Stop flag parsing

Examples:
  chomp tools list
  chomp tools schema reply
  chomp reply --message "Hello from the CLI"
  chomp recall_memories --query "stock tickers" --limit 5
  chomp save_memory --category preferences --content "user likes dark mode"
  echo '{"query":"AI"}' | chomp search_conversations
`,
  );
}

/**
 * Parse argv into { positional, flags } honoring `--` and accepting both
 * `--key value` and `--key=value`. Boolean flags like --raw are tracked too.
 */
function parseArgv(rest) {
  const positional = [];
  const flags = {};
  let i = 0;
  let onlyPositional = false;
  while (i < rest.length) {
    const tok = rest[i];
    if (!onlyPositional && tok === "--") {
      onlyPositional = true;
      i += 1;
      continue;
    }
    if (!onlyPositional && tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      let key;
      let value;
      if (eq !== -1) {
        key = tok.slice(2, eq);
        value = tok.slice(eq + 1);
      } else {
        key = tok.slice(2);
        const next = rest[i + 1];
        if (next === undefined || next.startsWith("--")) {
          value = true;
          i += 1;
          flags[key] = value;
          continue;
        }
        value = next;
        i += 2;
        flags[key] = value;
        continue;
      }
      flags[key] = value;
      i += 1;
      continue;
    }
    positional.push(tok);
    i += 1;
  }
  return { positional, flags };
}

function takeTransportFlags(flags) {
  const host = flags.host || DEFAULT_HOST;
  const port = String(flags.port || DEFAULT_PORT);
  const secret = flags.secret || DEFAULT_SECRET;
  const sessionId = flags["session-id"] || DEFAULT_SESSION;
  const raw = Boolean(flags.raw);
  for (const k of ["host", "port", "secret", "session-id", "raw"]) {
    delete flags[k];
  }
  return { host, port, secret, sessionId, raw };
}

function httpRequest({ host, port, method, path, headers, body }) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: host,
        port: Number.parseInt(port, 10),
        path,
        method,
        headers: headers || {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, body: data });
        });
      },
    );
    req.on("error", (err) => {
      resolve({ status: 0, body: "", error: err });
    });
    if (body) req.write(body);
    req.end();
  });
}

async function fetchTools(transport) {
  const res = await httpRequest({
    host: transport.host,
    port: transport.port,
    method: "GET",
    path: "/mcp/tools/list",
    headers: transport.secret ? { "X-Chomp-MCP-Secret": transport.secret } : {},
  });
  if (res.error) fail(`failed to reach API at ${transport.host}:${transport.port} — ${res.error.message}`, 3);
  if (res.status !== 200) fail(`tools/list HTTP ${res.status}: ${res.body.slice(0, 200)}`, 3);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    fail(`tools/list returned non-JSON: ${res.body.slice(0, 200)}`, 3);
  }
  if (!parsed || !Array.isArray(parsed.tools)) fail("tools/list response missing .tools array", 3);
  return parsed.tools;
}

async function callTool(transport, toolName, args) {
  const body = JSON.stringify({ name: toolName, arguments: args });
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  };
  if (transport.secret) headers["X-Chomp-MCP-Secret"] = transport.secret;
  if (transport.sessionId) headers["X-Chomp-Session-Id"] = transport.sessionId;
  const res = await httpRequest({
    host: transport.host,
    port: transport.port,
    method: "POST",
    path: "/mcp/tools/call",
    headers,
    body,
  });
  if (res.error) fail(`failed to reach API at ${transport.host}:${transport.port} — ${res.error.message}`, 3);
  try {
    return { status: res.status, payload: JSON.parse(res.body) };
  } catch {
    return { status: res.status, payload: { content: [{ type: "text", text: res.body }], isError: res.status >= 400 } };
  }
}

/** Strip mcp__chomp-api__ and chomp_ prefixes so users can use any form. */
function normalizeName(name) {
  let n = name;
  if (n.startsWith("mcp__chomp-api__")) n = n.slice("mcp__chomp-api__".length);
  if (n.startsWith("chomp_")) n = n.slice("chomp_".length);
  return n;
}

/** Coerce string flag values into the type declared by the tool schema. */
function coerceArgs(flags, schema) {
  if (!schema || !schema.properties) {
    const out = {};
    for (const [k, v] of Object.entries(flags)) out[k] = v;
    return out;
  }
  const props = schema.properties;
  const out = {};
  for (const [k, raw] of Object.entries(flags)) {
    const spec = props[k];
    if (raw === true) {
      out[k] = true;
      continue;
    }
    if (!spec) {
      out[k] = raw;
      continue;
    }
    const t = spec.type;
    if (t === "number" || t === "integer") {
      const n = Number(raw);
      if (Number.isNaN(n)) fail(`--${k} expects ${t}, got "${raw}"`);
      out[k] = n;
    } else if (t === "boolean") {
      out[k] = /^(true|1|yes|on)$/i.test(String(raw));
    } else if (t === "object" || t === "array") {
      try {
        out[k] = JSON.parse(raw);
      } catch (err) {
        fail(`--${k} expects JSON ${t}: ${err.message}`);
      }
    } else {
      out[k] = String(raw);
    }
  }
  return out;
}

async function readStdinJson() {
  if (process.stdin.isTTY) return null;
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  const trimmed = data.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    fail(`stdin is not valid JSON: ${err.message}`);
  }
  return null;
}

function printResult(payload, raw) {
  if (raw) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(payload?.isError ? 1 : 0);
  }
  const items = Array.isArray(payload?.content) ? payload.content : [];
  const text = items
    .filter((it) => it && it.type === "text" && typeof it.text === "string")
    .map((it) => it.text)
    .join("\n");
  if (payload?.isError) {
    process.stderr.write(`${text || "tool returned isError"}\n`);
    process.exit(1);
  }
  if (text) process.stdout.write(`${text}\n`);
  else process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

async function cmdToolsList(transport, flags) {
  const tools = await fetchTools(transport);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
    return;
  }
  const width = tools.reduce((m, t) => Math.max(m, t.name.length), 0);
  for (const t of tools) {
    const desc = (t.description || "").split("\n")[0];
    process.stdout.write(`${t.name.padEnd(width)}  ${desc}\n`);
  }
}

async function cmdToolsSchema(transport, name) {
  if (!name) fail("usage: chomp tools schema <tool>");
  const tools = await fetchTools(transport);
  const norm = normalizeName(name);
  const tool = tools.find((t) => t.name === norm);
  if (!tool) fail(`unknown tool: ${name}`);
  process.stdout.write(`${JSON.stringify(tool, null, 2)}\n`);
}

async function cmdHelp(transport, name) {
  if (!name) {
    printHelp();
    return;
  }
  const tools = await fetchTools(transport);
  const norm = normalizeName(name);
  const tool = tools.find((t) => t.name === norm);
  if (!tool) fail(`unknown tool: ${name}`);
  const required = new Set(tool.inputSchema?.required || []);
  const props = tool.inputSchema?.properties || {};
  process.stdout.write(`chomp ${tool.name}\n\n${tool.description}\n\nArguments:\n`);
  if (Object.keys(props).length === 0) {
    process.stdout.write("  (none)\n");
    return;
  }
  for (const [key, spec] of Object.entries(props)) {
    const req = required.has(key) ? " (required)" : "";
    const type = spec?.type ? ` <${spec.type}>` : "";
    const enums = Array.isArray(spec?.enum) ? `  [${spec.enum.join("|")}]` : "";
    const desc = spec?.description ? `\n      ${spec.description}` : "";
    process.stdout.write(`  --${key}${type}${req}${enums}${desc}\n`);
  }
}

async function cmdCallTool(transport, toolName, flags) {
  const norm = normalizeName(toolName);
  const tools = await fetchTools(transport);
  const tool = tools.find((t) => t.name === norm);
  if (!tool) fail(`unknown tool: ${toolName} (try \`chomp tools list\`)`);

  const jsonFlag = flags.json;
  if (jsonFlag !== undefined) delete flags.json;

  let args;
  if (jsonFlag && jsonFlag !== true) {
    try {
      args = JSON.parse(jsonFlag);
    } catch (err) {
      fail(`--json must be a JSON object: ${err.message}`);
    }
  } else if (Object.keys(flags).length === 0) {
    const stdinJson = await readStdinJson();
    args = stdinJson ?? {};
  } else {
    args = coerceArgs(flags, tool.inputSchema);
  }

  const required = tool.inputSchema?.required || [];
  for (const key of required) {
    if (args[key] === undefined) fail(`${tool.name}: missing required --${key}`);
  }

  const { payload } = await callTool(transport, norm, args);
  printResult(payload, transport.raw);
}

async function main() {
  if (argv.length === 0) {
    printHelp();
    process.exit(0);
  }
  const { positional, flags } = parseArgv(argv);
  const transport = takeTransportFlags(flags);

  const head = positional[0];

  if (head === "help" || flags.help) {
    await cmdHelp(transport, positional[1]);
    return;
  }
  if (head === "tools") {
    const sub = positional[1];
    if (sub === "list") return cmdToolsList(transport, flags);
    if (sub === "schema") return cmdToolsSchema(transport, positional[2]);
    fail(`unknown tools subcommand: ${sub || "(none)"}. Try: list, schema`);
  }

  if (!head) {
    printHelp();
    process.exit(0);
  }

  await cmdCallTool(transport, head, flags);
}

main().catch((err) => fail(err?.stack || err?.message || String(err), 4));
