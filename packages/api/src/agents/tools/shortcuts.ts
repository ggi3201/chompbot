import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getSecret } from "../../lib/secrets.js";

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./data/uploads";
/** Shortcuts marks where a variable sits inside a text with this character. */
const VARIABLE_MARK = "￼";
const REFERENCE = /\{\{([^{}]+)\}\}/g;

interface ActionInput {
  action: string;
  id?: string;
  params?: Record<string, unknown>;
}

function attachment(reference: string, uuids: Map<string, string>): Record<string, string> {
  if (reference === "input") return { Type: "ExtensionInput" };
  const uuid = uuids.get(reference);
  if (!uuid) throw new Error(`"{{${reference}}}" does not match the id of an action`);
  return { Type: "ActionOutput", OutputName: reference, OutputUUID: uuid };
}

function textValue(text: string, uuids: Map<string, string>): unknown {
  if (!text.match(REFERENCE)) return text;
  const attachmentsByRange: Record<string, unknown> = {};
  let string = "";
  let last = 0;
  for (const match of text.matchAll(REFERENCE)) {
    string += text.slice(last, match.index);
    attachmentsByRange[`{${string.length}, 1}`] = attachment(match[1], uuids);
    string += VARIABLE_MARK;
    last = match.index + match[0].length;
  }
  string += text.slice(last);
  return { Value: { string, attachmentsByRange }, WFSerializationType: "WFTextTokenString" };
}

/** Turns the agent's {{id}} text and {variable: id} objects into the form Shortcuts stores. */
function resolveVariables(value: unknown, uuids: Map<string, string>): unknown {
  if (typeof value === "string") return textValue(value, uuids);
  if (Array.isArray(value)) return value.map((item) => resolveVariables(item, uuids));
  if (!value || typeof value !== "object") return value;
  const { variable } = value as { variable?: unknown };
  if (typeof variable === "string") {
    return { Value: attachment(variable, uuids), WFSerializationType: "WFTextTokenAttachment" };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveVariables(item, uuids)]));
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistValue(value: unknown): string {
  if (typeof value === "string") return `<string>${escapeXml(value)}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join("")}</array>`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== null && item !== undefined);
    return `<dict>${entries.map(([key, item]) => `<key>${escapeXml(key)}</key>${plistValue(item)}`).join("")}</dict>`;
  }
  throw new Error(`Cannot store ${String(value)} in a Shortcut`);
}

export function buildShortcutPlist(actions: ActionInput[], output?: string): string {
  const uuids = new Map(actions.flatMap((action) => (action.id ? [[action.id, randomUUID().toUpperCase()] as const] : [])));
  const steps = actions.map((action) => ({
    WFWorkflowActionIdentifier: action.action.includes(".") ? action.action : `is.workflow.actions.${action.action}`,
    WFWorkflowActionParameters: {
      ...(resolveVariables(action.params ?? {}, uuids) as object),
      ...(action.id && { UUID: uuids.get(action.id) }),
    },
  }));
  if (output) {
    steps.push({
      WFWorkflowActionIdentifier: "is.workflow.actions.output",
      WFWorkflowActionParameters: { WFOutput: textValue(output, uuids) } as never,
    });
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${plistValue({
    WFWorkflowClientVersion: "2605.0.5",
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowIcon: { WFWorkflowIconGlyphNumber: 59511, WFWorkflowIconStartColor: 4282601983 },
    WFWorkflowImportQuestions: [],
    WFWorkflowInputContentItemClasses: ["WFStringContentItem", "WFURLContentItem"],
    WFWorkflowOutputContentItemClasses: ["WFStringContentItem"],
    WFWorkflowTypes: [],
    WFWorkflowHasOutputFallback: false,
    WFWorkflowActions: steps,
  })}</plist>`;
}

async function signShortcut(plist: string): Promise<Buffer> {
  const url = getSecret("SHORTCUT_SIGNER_URL") ?? process.env.SHORTCUT_SIGNER_URL;
  const token = getSecret("SHORTCUT_SIGNER_TOKEN") ?? process.env.SHORTCUT_SIGNER_TOKEN;
  if (!url || !token) throw new Error("SHORTCUT_SIGNER_URL and SHORTCUT_SIGNER_TOKEN are not set in Settings.");
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, "")}/sign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/xml" },
      body: plist,
      signal: AbortSignal.timeout(70_000),
    });
  } catch (err) {
    throw new Error(`Could not reach the signer on the user's Mac, which must be awake and on Tailscale: ${err instanceof Error ? err.message : err}`);
  }
  if (!res.ok) throw new Error(`The signer refused it (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function execCreateShortcut(args: { name?: unknown; actions?: unknown; output?: unknown }): Promise<string> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name || name.length > 60 || /[/\\]/.test(name)) return "ERROR: name must be 1 to 60 characters with no slashes.";
  const actions = args.actions as ActionInput[];
  if (!Array.isArray(actions) || actions.length === 0 || actions.some((action) => typeof action?.action !== "string")) {
    return "ERROR: actions must be a list of {action, id?, params?}.";
  }
  try {
    const signed = await signShortcut(buildShortcutPlist(actions, typeof args.output === "string" ? args.output : undefined));
    const id = randomUUID();
    // Shortcuts names an imported Shortcut after its file, so the id goes in the folder.
    mkdirSync(join(UPLOADS_DIR, id), { recursive: true });
    writeFileSync(join(UPLOADS_DIR, id, `${name}.shortcut`), signed);
    const path = `/api/uploads/${id}/${encodeURIComponent(name)}.shortcut`;
    return `Created "${name}". Send the user this link: ${process.env.CHOMP_DOMAIN ?? ""}${path}\nThey tap it on the iPhone, download the file, open it, and tap Add Shortcut. Check that the actions look right before relying on it.`;
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : err}`;
  }
}
