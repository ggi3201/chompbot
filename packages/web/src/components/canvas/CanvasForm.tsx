// Small form: submit sends "label: value" lines as the user's next message.

import { useState } from "react";
import { Button, Input } from "../ui";
import CanvasCard from "./CanvasCard";
import { useCanvasAction, useCanvasLocked } from "./CanvasActionContext";

interface Field {
  name: string;
  label?: string;
  type?: "text" | "number" | "textarea" | "select" | "checkbox";
  options?: string[];
  value?: string | number | boolean;
}

interface CanvasFormProps {
  title?: string;
  fields: Field[];
  submitLabel?: string;
  prompt?: string;
}

export default function CanvasForm({ title, fields, submitLabel = "Send", prompt }: CanvasFormProps) {
  const send = useCanvasAction();
  const answered = useCanvasLocked();
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.type === "checkbox" ? Boolean(f.value) : String(f.value ?? "")])),
  );
  const [sent, setSent] = useState(false);
  const set = (name: string, v: string | boolean) => setValues((prev) => ({ ...prev, [name]: v }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const lines = fields.map((f) => {
      const v = values[f.name];
      return `${f.label || f.name}: ${typeof v === "boolean" ? (v ? "yes" : "no") : v}`;
    });
    send?.([prompt, ...lines].filter(Boolean).join("\n"));
    setSent(true);
  }

  const locked = !send || sent || answered;

  return (
    <CanvasCard title={title}>
      <form onSubmit={submit} className={`flex flex-col gap-3 transition-opacity ${locked ? "opacity-60" : ""}`}>
        {fields.map((f) => (
          <label key={f.name} className="flex flex-col gap-1 text-[13px] text-text-secondary">
            {f.type !== "checkbox" && (f.label || f.name)}
            {f.type === "textarea" ? (
              <Input as="textarea" rows={3} disabled={locked} value={values[f.name] as string} onChange={(e) => set(f.name, e.target.value)} />
            ) : f.type === "select" ? (
              <Input as="select" disabled={locked} value={values[f.name] as string} onChange={(e) => set(f.name, e.target.value)}>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </Input>
            ) : f.type === "checkbox" ? (
              <span className="flex items-center gap-2">
                <input type="checkbox" disabled={locked} checked={values[f.name] as boolean} onChange={(e) => set(f.name, e.target.checked)} />
                {f.label || f.name}
              </span>
            ) : (
              <Input type={f.type === "number" ? "number" : "text"} disabled={locked} value={values[f.name] as string} onChange={(e) => set(f.name, e.target.value)} />
            )}
          </label>
        ))}
        <div>
          <Button type="submit" variant="primary" disabled={locked} title={send ? undefined : "Only works in chat"}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </CanvasCard>
  );
}
