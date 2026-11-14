import { useState, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button, Input } from "./ui";

interface GenerateBarProps {
  loading: boolean;
  error: string | null;
  onGenerate: (prompt: string) => void;
}

export default function GenerateBar({ loading, error, onGenerate }: GenerateBarProps) {
  const [prompt, setPrompt] = useState("");

  function handleSubmit() {
    if (!prompt.trim() || loading) return;
    onGenerate(prompt.trim());
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="mb-3 -mt-1">
      <div className="flex gap-2 items-center">
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want"
          disabled={loading}
          className="flex-1"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleSubmit}
          disabled={loading || !prompt.trim()}
        >
          {loading && <Loader2 size={16} strokeWidth={1.5} className="animate-spin" />}
          {loading ? "Generating" : "Generate"}
        </Button>
      </div>
      {error && <p className="mt-1.5 text-xs text-error">{error}</p>}
    </div>
  );
}
