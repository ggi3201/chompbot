#!/usr/bin/env node
// Lightweight self-test for the Chomp CLI. Spins up a fake Chomp API on a
// random port and runs the CLI against it. Zero deps, matches the rest of
// the package style.

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");

const TOOLS = [
  {
    name: "reply",
    description: "Send a message to the Chomp chat UI.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "the message" } },
      required: ["message"],
    },
  },
  {
    name: "recall_memories",
    description: "Recall memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        use_semantic: { type: "boolean" },
      },
    },
  },
];

let lastCall = null;
let requireSessionForReply = true;

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/mcp/tools/list") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ tools: TOOLS }));
      return;
    }
    if (req.method === "POST" && req.url === "/mcp/tools/call") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        lastCall = {
          name: parsed.name,
          args: parsed.arguments,
          sessionId: req.headers["x-chomp-session-id"] || null,
          secret: req.headers["x-chomp-mcp-secret"] || null,
        };
        if (parsed.name === "reply" && requireSessionForReply && !req.headers["x-chomp-session-id"]) {
          res.statusCode = 400;
          res.end(JSON.stringify({ content: [{ type: "text", text: "missing session" }], isError: true }));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: `called ${parsed.name} with ${JSON.stringify(parsed.arguments)}` }],
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
}

function runCli(args, { env = {}, stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

const failures = [];
function check(label, cond, detail) {
  if (cond) {
    process.stdout.write(`ok   ${label}\n`);
  } else {
    failures.push({ label, detail });
    process.stdout.write(`FAIL ${label}${detail ? `: ${detail}` : ""}\n`);
  }
}

async function main() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = String(server.address().port);
  const env = { CHOMP_HOST: "127.0.0.1", CHOMP_PORT: port, CHOMP_MCP_SECRET: "", CHOMP_SESSION_ID: "" };

  // tools list
  const list = await runCli(["tools", "list"], { env });
  check("tools list exits 0", list.code === 0, list.stderr);
  check("tools list mentions reply", /reply/.test(list.stdout));

  // tools list --json
  const listJson = await runCli(["tools", "list", "--json"], { env });
  check("tools list --json is valid JSON", JSON.parse(listJson.stdout).length === 2);

  // tools schema
  const schema = await runCli(["tools", "schema", "reply"], { env });
  check("tools schema reply returns schema", /"required"/.test(schema.stdout));

  // help for tool
  const help = await runCli(["help", "reply"], { env });
  check("help reply shows --message", /--message/.test(help.stdout));

  // missing required arg
  const missing = await runCli(["reply"], { env });
  check("missing required arg exits 2", missing.code === 2 && /missing required/.test(missing.stderr));

  // session-bound tool without session
  lastCall = null;
  const noSession = await runCli(["reply", "--message", "hi"], { env });
  check("reply without session falls through to API error", noSession.code === 1);

  // session-bound tool with session
  lastCall = null;
  const withSession = await runCli(["reply", "--message", "hi"], { env: { ...env, CHOMP_SESSION_ID: "sess-1" } });
  check("reply with session exits 0", withSession.code === 0);
  check("reply forwarded session header", lastCall?.sessionId === "sess-1");
  check("reply forwarded message arg", lastCall?.args?.message === "hi");

  // numeric coercion
  lastCall = null;
  const numCall = await runCli(["recall_memories", "--query", "ai", "--limit", "5"], { env });
  check("number flag coerced to JS number", numCall.code === 0 && lastCall?.args?.limit === 5);

  // boolean coercion
  lastCall = null;
  const boolCall = await runCli(
    ["recall_memories", "--query", "ai", "--use_semantic", "false"],
    { env },
  );
  check("boolean flag coerced", lastCall?.args?.use_semantic === false);

  // chomp_ prefix normalization
  lastCall = null;
  const prefixed = await runCli(["chomp_recall_memories", "--query", "x"], { env });
  check("chomp_ prefix normalized", prefixed.code === 0 && lastCall?.name === "recall_memories");

  // mcp__ prefix normalization
  lastCall = null;
  const mcpPrefixed = await runCli(["mcp__chomp-api__recall_memories", "--query", "x"], { env });
  check("mcp__ prefix normalized", mcpPrefixed.code === 0 && lastCall?.name === "recall_memories");

  // --json overrides flags
  lastCall = null;
  const jsonArg = await runCli(["recall_memories", "--json", '{"query":"raw","limit":2}'], { env });
  check("--json passes object args", jsonArg.code === 0 && lastCall?.args?.limit === 2);

  // stdin JSON
  lastCall = null;
  const stdinCall = await runCli(["recall_memories"], { env, stdin: '{"query":"from stdin"}' });
  check("stdin JSON is parsed as args", stdinCall.code === 0 && lastCall?.args?.query === "from stdin");

  // --raw prints full payload
  const raw = await runCli(
    ["recall_memories", "--query", "x", "--raw"],
    { env },
  );
  check("--raw prints JSON envelope", /"content"/.test(raw.stdout));

  // secret header forwarding
  lastCall = null;
  await runCli(["recall_memories", "--query", "x", "--secret", "abc"], { env });
  check("secret flag forwarded", lastCall?.secret === "abc");

  // unknown tool
  const unknown = await runCli(["does_not_exist", "--foo", "bar"], { env });
  check("unknown tool exits 2", unknown.code === 2 && /unknown tool/i.test(unknown.stderr));

  server.close();

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} failure(s)\n`);
    process.exit(1);
  }
  process.stdout.write("\nall checks passed\n");
}

main().catch((err) => {
  process.stderr.write(`test runner error: ${err?.stack || err}\n`);
  process.exit(1);
});
