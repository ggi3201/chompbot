import { useEffect, useMemo, useState } from "react";
import FormModal from "./FormModal";
import { Input } from "./ui";
import CodeEditor from "./CodeEditor";
import { apiFetch } from "../lib/api";
import type { RunTarget } from "@chomp/shared";
import { useAgentModels } from "../hooks/useAgentModels";
import { useCrud } from "../hooks/useCrud";
import RunTargetFields, { readRunTarget } from "./RunTargetFields";

type RefresherKind = "template" | "agent" | "none";
type HttpMethod = "GET" | "POST" | "PUT";

interface SchemaDescriptor {
  type: string;
  requiredKeys: string[];
}

interface Widget {
  id: string;
  refresherKind: string | null;
  refresherPayload: string | null;
  schemaJson: string | null;
  refreshIntervalMinutes: number | null;
  lastRefreshedAt: string | null;
}

interface RefresherEditorModalProps {
  open: boolean;
  widget: Widget | null;
  dashboardAutoRefresh?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

function safeParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function parseObjectJson(input: string, label: string): Record<string, unknown> | undefined {
  if (!input.trim()) return undefined;
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeKind(kind: string | null): RefresherKind {
  return kind === "template" || kind === "agent" ? kind : "none";
}

function displayMethod(value: unknown): HttpMethod {
  return value === "POST" || value === "PUT" ? value : "GET";
}

function stringifyForEdit(value: unknown, fallback: unknown): string {
  return JSON.stringify(value ?? fallback, null, 2);
}

function refresherLabel(kind: RefresherKind): string {
  if (kind === "template") return "Template";
  if (kind === "agent") return "Agent";
  return "Frozen";
}

const KIND_NOTES: Record<RefresherKind, string> = {
  template: "Use when the source URL keeps returning the same JSON shape. Fast and cheap.",
  agent: "Use when a refresh needs judgment, tools or messy context. Slower, but it can think.",
  none: "Frozen widgets keep the current canvas as a snapshot. Good for records, not for live numbers.",
};

function loopLabel(kind: RefresherKind, intervalMinutes: number | null, autoRefresh: boolean): string {
  if (intervalMinutes) return autoRefresh ? `Auto every ${intervalMinutes}m` : `Auto paused (${intervalMinutes}m)`;
  return kind === "none" ? "No refresh loop" : "Manual only";
}

export default function RefresherEditorModal({
  open,
  widget,
  dashboardAutoRefresh = false,
  onClose,
  onSaved,
}: RefresherEditorModalProps) {
  const [kind, setKind] = useState<RefresherKind>("none");
  const [templateUrl, setTemplateUrl] = useState("");
  const [templateMethod, setTemplateMethod] = useState<HttpMethod>("GET");
  const [templateHeadersJson, setTemplateHeadersJson] = useState("{}");
  const [templateBody, setTemplateBody] = useState("");
  const [templateTransformJson, setTemplateTransformJson] = useState("{}");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentTarget, setAgentTarget] = useState<RunTarget>({});
  const providers = useAgentModels();
  const { items: souls } = useCrud<{ id: string; name: string }>("/souls");
  const [contextUrl, setContextUrl] = useState("");
  const [contextHeadersJson, setContextHeadersJson] = useState("{}");
  const [contextMethod, setContextMethod] = useState<HttpMethod>("GET");
  const [contextBody, setContextBody] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const initial = useMemo(() => {
    if (!widget) return null;
    const payload = safeParse<Record<string, unknown>>(widget.refresherPayload, {});
    return {
      kind: normalizeKind(widget.refresherKind),
      payload,
      intervalMinutes: widget.refreshIntervalMinutes,
      lastRefreshedAt: widget.lastRefreshedAt,
    };
  }, [widget]);

  useEffect(() => {
    if (!open || !initial) return;

    const context = (initial.payload.context ?? {}) as Record<string, unknown>;

    setError(null);
    setKind(initial.kind);
    setTemplateUrl(typeof initial.payload.url === "string" ? initial.payload.url : "");
    setTemplateMethod(displayMethod(initial.payload.method));
    setTemplateHeadersJson(stringifyForEdit(initial.payload.headers, {}));
    setTemplateBody(typeof initial.payload.body === "string" ? initial.payload.body : "");
    setTemplateTransformJson(stringifyForEdit(initial.payload.transform, {}));
    setAgentPrompt(typeof initial.payload.prompt === "string" ? initial.payload.prompt : "");
    setAgentTarget(readRunTarget(initial.payload));
    setContextUrl(typeof context.url === "string" ? context.url : "");
    setContextHeadersJson(stringifyForEdit(context.headers, {}));
    setContextMethod(displayMethod(context.method));
    setContextBody(typeof context.body === "string" ? context.body : "");
    setIntervalMinutes(typeof initial.intervalMinutes === "number" ? String(initial.intervalMinutes) : "");
  }, [open, initial]);

  async function submit() {
    if (!widget) return;
    let payload: Record<string, unknown> | null = null;
    let schema: SchemaDescriptor[] | undefined;

    try {
      if (kind === "template") {
        if (!templateUrl.trim()) {
          setError("Template URL is required");
          return;
        }
        const headers = parseObjectJson(templateHeadersJson, "Headers");
        const transform = JSON.parse(templateTransformJson) as unknown;
        payload = {
          url: templateUrl.trim(),
          ...(templateMethod !== "GET" && { method: templateMethod }),
          ...(headers && Object.keys(headers).length > 0 && { headers }),
          ...(templateBody.trim() && { body: templateBody }),
          transform,
        };
      } else if (kind === "agent") {
        if (!agentPrompt.trim()) {
          setError("Agent prompt is required");
          return;
        }
        const contextHeaders = parseObjectJson(contextHeadersJson, "Context headers");
        const context =
          contextUrl.trim().length > 0
            ? {
                url: contextUrl.trim(),
                ...(contextMethod !== "GET" && { method: contextMethod }),
                ...(contextHeaders && Object.keys(contextHeaders).length > 0 && { headers: contextHeaders }),
                ...(contextBody.trim() && { body: contextBody }),
              }
            : undefined;

        payload = {
          prompt: agentPrompt.trim(),
          ...agentTarget,
          ...(context && { context }),
        };
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payload JSON is invalid");
      return;
    }

    let nextInterval: number | null = null;
    if (kind !== "none" && intervalMinutes.trim() !== "") {
      const parsed = parseInt(intervalMinutes.trim(), 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        setError("Auto-refresh interval must be a positive whole number of minutes");
        return;
      }
      nextInterval = parsed;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/widgets/${widget.id}/refresher`, {
        method: "PUT",
        body: JSON.stringify({
          kind: kind === "none" ? null : kind,
          payload,
          refreshIntervalMinutes: nextInterval,
          ...(schema && { schema }),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        setError(err.error ?? "Save failed");
        return;
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal title="Widget refresh settings" open={open} onClose={onClose} onSubmit={submit} wide>
      {initial && (
        <div className="rounded-md border border-border p-3 text-[13px]">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-medium text-text-primary">{refresherLabel(initial.kind)}</span>
            <span className="font-mono text-xs text-text-muted">
              {loopLabel(initial.kind, initial.intervalMinutes, dashboardAutoRefresh)}
            </span>
            {initial.lastRefreshedAt && (
              <span className="font-mono text-xs text-text-muted">
                Last refreshed {new Date(initial.lastRefreshedAt).toLocaleString()}
              </span>
            )}
          </div>
          <p className="mt-2 text-text-muted">{KIND_NOTES[initial.kind]}</p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 text-[13px]">
        {(["none", "template", "agent"] as RefresherKind[]).map((k) => (
          <label
            key={k}
            className={`h-9 inline-flex items-center justify-center cursor-pointer rounded-md border transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent/60 ${
              kind === k
                ? "bg-raised border-white/14 text-text-primary"
                : "bg-transparent border-border text-text-muted hover:text-text-secondary hover:border-white/14"
            }`}
          >
            <input
              type="radio"
              name="refresher-kind"
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
              className="sr-only"
            />
            {refresherLabel(k)}
          </label>
        ))}
      </div>

      {kind === "template" && (
        <>
          <label className="text-[13px] text-text-secondary mt-1">JSON URL</label>
          <Input
            value={templateUrl}
            onChange={(e) => setTemplateUrl(e.target.value)}
            placeholder="https://api.example.com/data"
          />
          <div className="grid grid-cols-1 md:grid-cols-[8rem_1fr] gap-3">
            <label className="text-[13px] text-text-secondary">
              Method
              <Input
                as="select"
                value={templateMethod}
                onChange={(e) => setTemplateMethod((e.target as HTMLSelectElement).value as HttpMethod)}
                className="mt-1 w-full"
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
              </Input>
            </label>
            <div className="text-[13px] text-text-secondary flex flex-col gap-1">Headers JSON<CodeEditor language="json" validate minHeight="72px" value={templateHeadersJson} onChange={setTemplateHeadersJson} /></div>
          </div>
          {templateMethod !== "GET" && (
            <>
              <label className="text-[13px] text-text-secondary">Request body</label>
              <CodeEditor language="json" minHeight="72px" value={templateBody} onChange={setTemplateBody} />
            </>
          )}
          <label className="text-[13px] text-text-secondary">
            Canvas transform JSON with <span className="text-text-muted">{"{{$.path}}"}</span> placeholders
          </label>
          <CodeEditor language="json" minHeight="180px" value={templateTransformJson} onChange={setTemplateTransformJson} />
        </>
      )}

      {kind === "agent" && (
        <>
          <RunTargetFields value={agentTarget} onChange={setAgentTarget} providers={providers} souls={souls} />
          <label className="text-[13px] text-text-secondary mt-1">
            Prompt <span className="text-text-muted">(the agent must reply with canvas blocks)</span>
          </label>
          <Input
            as="textarea"
            value={agentPrompt}
            onChange={(e) => setAgentPrompt(e.target.value)}
            rows={6}
            placeholder="Refresh this widget and reply with one :::canvas block containing the updated data."
          />
          <div className="border-t border-border my-2" />
          <label className="text-[13px] text-text-secondary">
            Optional context URL <span className="text-text-muted">(fetched before the agent runs)</span>
          </label>
          <Input value={contextUrl} onChange={(e) => setContextUrl(e.target.value)} placeholder="https://api.example.com/data" />
          {contextUrl.trim() && (
            <div className="grid grid-cols-1 md:grid-cols-[8rem_1fr] gap-3">
              <label className="text-[13px] text-text-secondary">
                Method
                <Input
                  as="select"
                  value={contextMethod}
                  onChange={(e) => setContextMethod((e.target as HTMLSelectElement).value as HttpMethod)}
                  className="mt-1 w-full"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </Input>
              </label>
              <div className="text-[13px] text-text-secondary flex flex-col gap-1">Headers JSON<CodeEditor language="json" validate minHeight="72px" value={contextHeadersJson} onChange={setContextHeadersJson} /></div>
            </div>
          )}
          {contextUrl.trim() && contextMethod !== "GET" && (
            <>
              <label className="text-[13px] text-text-secondary">Context request body</label>
              <CodeEditor language="json" minHeight="72px" value={contextBody} onChange={setContextBody} />
            </>
          )}
        </>
      )}

      {kind !== "none" && (
        <>
          <div className="border-t border-border my-2" />
          <label className="text-[13px] text-text-secondary">
            Auto-refresh every <span className="text-text-muted">(minutes, blank means manual only)</span>
          </label>
          <Input
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(e.target.value)}
            placeholder="30"
            inputMode="numeric"
          />
          <p className="text-xs text-text-muted">
            Auto-refresh runs only when this widget has an interval and auto-refresh is on for the board.
          </p>
        </>
      )}

      {kind === "none" && (
        <p className="text-[13px] text-text-muted">
          This widget stays frozen. The refresh button disappears and the current canvas blocks remain as a snapshot.
        </p>
      )}

      {error && <p className="text-[13px] text-error mt-1">{error}</p>}
      {submitting && <p className="font-mono text-xs text-text-muted mt-1">Saving</p>}
    </FormModal>
  );
}
