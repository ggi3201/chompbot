import { useState } from "react";
import { motion } from "motion/react";
import { Download } from "lucide-react";
import Markdown from "../Markdown";
import { Button, IconButton, ChoicePills } from "../ui";
import { useTypewriter } from "../../hooks/useTypewriter";
import type { SoulDraft } from "../../lib/birthright";

const WRITING_CPS = 420;

function downloadMarkdown(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const SOUL_SHEET = "soul.md";
const PROFILE_SHEET = "user.md";
const SHEETS = [{ id: SOUL_SHEET }, { id: PROFILE_SHEET }];

interface SoulCardProps {
  soul: SoulDraft;
  saving: boolean;
  onGiveLife: () => void;
}

/** The soul types itself out in the conversation. Nothing is saved until the person says so. */
export default function SoulCard({ soul, saving, onGiveLife }: SoulCardProps) {
  const [chosen, setChosen] = useState<string | null>(null);
  // While it is being written, follow the part being written. Finished, it opens on the soul.
  const followed = soul.writing && soul.profile ? PROFILE_SHEET : SOUL_SHEET;
  const sheet = chosen ?? followed;
  const source = (sheet === SOUL_SHEET ? soul.content : soul.profile).trimStart();
  const typed = useTypewriter(sheet === SOUL_SHEET ? 0 : 1, source, { cps: WRITING_CPS });

  return (
    <motion.article
      initial={{ opacity: 0, y: 26, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 30, damping: 13 }}
      className="rounded-xl border border-border bg-[#0a0b0f]/85 shadow-modal"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h2 className="m-0 text-base font-medium text-text-primary">{soul.name || "Unnamed"}</h2>
          {soul.description && <p className="m-0 mt-0.5 text-[13px] leading-snug text-text-muted">{soul.description}</p>}
        </div>
        <ChoicePills options={SHEETS} value={sheet} onChange={setChosen} />
      </header>

      <div className="mt-3 max-h-[46vh] overflow-y-auto border-y border-border px-5 py-4 text-sm leading-relaxed text-text-secondary">
        <Markdown>{source.slice(0, typed)}</Markdown>
      </div>

      <footer className="flex flex-wrap items-center gap-2 px-5 py-3.5">
        <Button variant="primary" disabled={soul.writing || saving} onClick={onGiveLife}>
          {saving ? "Saving" : soul.writing ? "Writing" : "Give it life"}
        </Button>
        <p className="m-0 min-w-0 flex-1 text-xs leading-snug text-text-muted">
          Replaces your one default soul, user.md and spoken voice. Or tell me what to change.
        </p>
        <IconButton
          label={`Download ${sheet}`}
          disabled={soul.writing}
          onClick={() => downloadMarkdown(sheet, source.trim())}
        >
          <Download size={16} strokeWidth={1.5} />
        </IconButton>
      </footer>
    </motion.article>
  );
}
