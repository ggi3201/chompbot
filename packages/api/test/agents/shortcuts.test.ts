import express from "express";
import { existsSync, readFileSync } from "fs";
import type { AddressInfo } from "net";
import { join } from "path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { buildShortcutPlist, execCreateShortcut } from "../../src/agents/tools/shortcuts.js";

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/lib/secrets.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSecret: (key: string) => secrets.get(key),
}));

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let received: { auth?: string; body: string }[] = [];
let signerStatus = 200;

beforeAll(async () => {
  const app = express();
  app.use(express.text({ type: "application/xml" }));
  app.post("/sign", (req, res) => {
    received.push({ auth: req.headers.authorization, body: req.body as string });
    res.status(signerStatus).send(signerStatus === 200 ? "AEA1signed" : "no");
  });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
});
afterAll(() => server.close());
afterEach(() => {
  secrets.clear();
  received = [];
  signerStatus = 200;
});

const useSigner = () => {
  secrets.set("SHORTCUT_SIGNER_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  secrets.set("SHORTCUT_SIGNER_TOKEN", "secret");
};
const battery = { name: "Chomp Battery", actions: [{ action: "getbatterylevel", id: "level" }], output: "{{level}}" };

test("short action names expand, and text is escaped", () => {
  const plist = buildShortcutPlist([{ action: "gettext", params: { WFTextActionText: "a < b & c" } }, { action: "com.apple.other.Action" }]);
  expect(plist).toContain("<string>is.workflow.actions.gettext</string>");
  expect(plist).toContain("<string>com.apple.other.Action</string>");
  expect(plist).toContain("<string>a &lt; b &amp; c</string>");
});

test("variables in text point at their action and sit at the right place", () => {
  const plist = buildShortcutPlist(
    [{ action: "gettext", id: "first", params: { WFTextActionText: "x" } }, { action: "notification", params: { WFNotificationActionBody: "Hi {{first}} and {{input}}!" } }],
  );
  const uuid = plist.match(/<key>UUID<\/key><string>([0-9A-F-]{36})<\/string>/)?.[1];
  expect(uuid).toBeTruthy();
  expect(plist).toContain("<string>Hi ￼ and ￼!</string>");
  expect(plist).toContain(`<key>{3, 1}</key><dict><key>Type</key><string>ActionOutput</string><key>OutputName</key><string>first</string><key>OutputUUID</key><string>${uuid}</string></dict>`);
  expect(plist).toContain("<key>{9, 1}</key><dict><key>Type</key><string>ExtensionInput</string></dict>");
  expect(plist).toContain("<string>WFTextTokenString</string>");
});

test("a whole variable and the output use their own forms", () => {
  const plist = buildShortcutPlist([{ action: "getclipboard", id: "clip" }, { action: "setclipboard", params: { WFInput: { variable: "clip" } } }], "{{clip}}");
  expect(plist).toContain("<string>WFTextTokenAttachment</string>");
  expect(plist).toContain("<string>is.workflow.actions.output</string>");
  expect(plist).toContain("<key>WFOutput</key>");
});

test("the signed file is saved under the Shortcut's name, behind an unguessable folder", async () => {
  useSigner();
  const result = await execCreateShortcut(battery);

  expect(received[0].auth).toBe("Bearer secret");
  expect(received[0].body).toContain("is.workflow.actions.getbatterylevel");
  const match = result.match(/\/api\/uploads\/([0-9a-f-]{36})\/Chomp%20Battery\.shortcut/);
  expect(match).toBeTruthy();
  const file = join(process.env.UPLOADS_DIR ?? "./data/uploads", match![1], "Chomp Battery.shortcut");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("AEA1signed");
});

test("bad input and a missing variable are refused before signing", async () => {
  useSigner();
  expect(await execCreateShortcut({ ...battery, name: "../evil" })).toContain("ERROR: name");
  expect(await execCreateShortcut({ ...battery, actions: [] })).toContain("ERROR: actions");
  expect(await execCreateShortcut({ ...battery, output: "{{nope}}" })).toContain('ERROR: "{{nope}}"');
  expect(received).toHaveLength(0);
});

test("the agent hears why signing failed", async () => {
  expect(await execCreateShortcut(battery)).toContain("are not set in Settings");

  useSigner();
  signerStatus = 500;
  expect(await execCreateShortcut(battery)).toContain("The signer refused it (500): no");

  secrets.set("SHORTCUT_SIGNER_URL", "http://127.0.0.1:9");
  expect(await execCreateShortcut(battery)).toContain("must be awake and on Tailscale");
});
