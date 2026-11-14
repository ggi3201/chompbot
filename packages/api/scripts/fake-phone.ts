// Fake-phone CLI: connects to the device bridge and acts as a mock device
// advertising a handful of tools. Useful for proving the agent → bridge →
// device → result loop end-to-end without a real iPhone build.
//
// Run from repo root:
//   DEVICE_BRIDGE_TOKEN=<token> pnpm --filter @chomp/api exec tsx \
//     scripts/fake-phone.ts --url ws://localhost:3002/device-bridge
//
// Then, in a chat with Chomp, ask it to call `phone_list_devices`,
// `phone_list_tools`, and `phone_call_tool` (e.g. read_clipboard).

import WebSocket from "ws";

type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

interface FakeTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: ToolHandler;
}

const TOOLS: FakeTool[] = [
  {
    name: "read_clipboard",
    description: "Read the current clipboard contents from the device.",
    inputSchema: { type: "object", properties: {} },
    handler: () => ({ text: "Fake clipboard contents at " + new Date().toISOString() }),
  },
  {
    name: "run_shortcut",
    description: "Run an iOS Shortcut by name. Returns the Shortcut's text output.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: (args) => ({ ranShortcut: args.name, output: `Pretended to run "${args.name}"` }),
  },
  {
    name: "get_battery",
    description: "Return the device's current battery level (0-100) and charging state.",
    inputSchema: { type: "object", properties: {} },
    handler: () => ({ level: 73, charging: false }),
  },
];

function parseArgs(argv: string[]): { url: string; token: string; deviceId: string; deviceName: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const key = k.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        args[key] = "true";
      } else {
        args[key] = value;
        i++;
      }
    }
  }
  const url = args.url ?? "ws://localhost:3002/device-bridge";
  const token = args.token ?? process.env.DEVICE_BRIDGE_TOKEN ?? "";
  const deviceId = args["device-id"] ?? "fake-phone-1";
  const deviceName = args["device-name"] ?? "Fake Phone";
  if (!token) {
    console.error("Missing --token (or DEVICE_BRIDGE_TOKEN env var)");
    process.exit(1);
  }
  return { url, token, deviceId, deviceName };
}

function main() {
  const { url, token, deviceId, deviceName } = parseArgs(process.argv.slice(2));
  const fullUrl = `${url}?token=${encodeURIComponent(token)}`;
  console.log(`[fake-phone] connecting to ${url}`);

  const ws = new WebSocket(fullUrl);

  ws.on("open", () => {
    console.log("[fake-phone] connected, sending hello");
    ws.send(
      JSON.stringify({
        type: "hello",
        deviceId,
        deviceName,
        platform: "node",
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      }),
    );
  });

  ws.on("message", async (data) => {
    let msg: { type?: string;[k: string]: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn("[fake-phone] non-JSON message", data.toString());
      return;
    }

    if (msg.type === "welcome") {
      console.log(`[fake-phone] welcomed, sessionId=${msg.sessionId}`);
      return;
    }

    if (msg.type === "tool_call") {
      const callId = msg.callId as string;
      const name = msg.name as string;
      const args = (msg.args && typeof msg.args === "object" ? msg.args : {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        ws.send(JSON.stringify({ type: "tool_result", callId, ok: false, error: `Unknown tool: ${name}` }));
        return;
      }
      try {
        const result = await tool.handler(args);
        ws.send(JSON.stringify({ type: "tool_result", callId, ok: true, result }));
      } catch (e) {
        ws.send(JSON.stringify({
          type: "tool_result",
          callId,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }));
      }
      return;
    }

    if (msg.type === "error") {
      console.error(`[fake-phone] server error: ${msg.error}`);
      return;
    }

    // heartbeat / etc — ignore
  });

  ws.on("close", (code, reason) => {
    console.log(`[fake-phone] closed (${code}) ${reason?.toString() ?? ""}`);
    process.exit(0);
  });

  ws.on("error", (err) => {
    console.error(`[fake-phone] socket error: ${err.message}`);
  });
}

main();
