import { useMemo } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-json";

/** A Prism language name, or "html". Prism's core carries markup, css and javascript; callers import other grammars they need. */
export type CodeLanguage = string;

const escape = (code: string) => code.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function highlight(code: string, language: CodeLanguage): string {
  const name = language === "html" ? "markup" : language;
  const grammar = Prism.languages[name];
  if (!grammar) return escape(code);
  try {
    return Prism.highlight(code, grammar, name);
  } catch {
    return escape(code);
  }
}

/** The error text if `code` is not valid JSON, else null. Empty input is not an error. */
export function jsonError(code: string): string | null {
  if (!code.trim()) return null;
  try {
    JSON.parse(code);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid JSON";
  }
}

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: CodeLanguage;
  minHeight?: string;
  maxHeight?: string;
  placeholder?: string;
  /** Show a parse error under the editor. Only for fields that must be strict JSON. */
  validate?: boolean;
  id?: string;
}

export default function CodeEditor({ value, onChange, language, minHeight = "120px", maxHeight, placeholder, validate = false, id }: CodeEditorProps) {
  const error = useMemo(() => (validate && language === "json" ? jsonError(value) : null), [validate, language, value]);

  return (
    <div className="flex flex-col gap-1">
      <div
        className={`code-editor lang-${language} border rounded-md bg-glass overflow-auto transition-colors focus-within:border-white/24 ${error ? "border-error/40" : "border-border"}`}
        style={{ minHeight, maxHeight }}
      >
        <Editor
          value={value}
          onValueChange={onChange}
          highlight={(code) => highlight(code, language)}
          padding={10}
          tabSize={2}
          insertSpaces
          textareaId={id}
          placeholder={placeholder}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "13px",
            lineHeight: 1.5,
            color: "var(--color-text-primary)",
            minHeight,
            caretColor: "var(--color-accent)",
          }}
        />
      </div>
      {error && <p role="alert" className="font-mono text-xs text-error">{error}</p>}
    </div>
  );
}
