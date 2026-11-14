import { Fragment, useState } from "react";
import type { FileDiff } from "@chomp/shared";
import Button from "../ui/Button";
import { parseUnifiedDiff, type DiffLine } from "../../lib/chat-timeline";

const lineTones: Record<DiffLine["kind"], string> = {
  hunk: "text-text-muted bg-white/3",
  add: "bg-success/10 text-text-primary",
  del: "bg-error/10 text-text-primary",
  context: "text-text-secondary",
  meta: "text-text-muted italic",
};

const signs: Record<DiffLine["kind"], string> = {
  hunk: "",
  add: "+",
  del: "-",
  context: " ",
  meta: "",
};

const signTones: Record<DiffLine["kind"], string> = {
  hunk: "",
  add: "text-success",
  del: "text-error",
  context: "",
  meta: "",
};

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-mono text-xs shrink-0">
      <span className="text-success">+{additions}</span>{" "}
      <span className="text-error">−{deletions}</span>
    </span>
  );
}

function NoteRow({ onAdd, onCancel }: { onAdd: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  const add = () => note.trim() && onAdd(note);
  return (
    <tr className="bg-raised">
      <td colSpan={4} className="p-0">
        {/* The table scrolls sideways under long lines; the note stays the width you can see. */}
        <div className="sticky left-0 w-[100cqw] box-border p-2">
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                add();
              }
            }}
            rows={2}
            placeholder="Note on this line"
            aria-label="Note on this line"
            className="w-full resize-y rounded-md border border-border bg-surface px-2 py-1 font-sans text-[13px] text-text-primary outline-none focus:border-text-muted"
          />
          <div className="flex justify-end gap-2 mt-1">
            <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={add} disabled={!note.trim()}>Add to message</Button>
          </div>
        </div>
      </td>
    </tr>
  );
}

/**
 * One file's unified diff: a header with path and counts, then the lines with old/new numbers.
 * With `onComment`, clicking a line opens a note under it, handed back with that line.
 */
export default function DiffView({ file, onComment }: { file: FileDiff; onComment?: (line: DiffLine, note: string) => void }) {
  const lines = parseUnifiedDiff(file.diff);
  const [noteAt, setNoteAt] = useState<number | null>(null);
  const commentable = (line: DiffLine) => !!onComment && line.kind !== "hunk" && line.kind !== "meta";
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-8 bg-raised border-b border-border">
        <span className="font-mono text-xs text-text-secondary truncate flex-1 min-w-0" title={file.path}>
          {file.path}
        </span>
        {file.kind !== "update" && (
          <span className="font-mono text-xs text-text-muted">{file.kind === "add" ? "new" : "deleted"}</span>
        )}
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </div>
      {lines.length === 0 ? (
        <p className="px-3 py-2 m-0 font-mono text-xs text-text-muted">No changes to show</p>
      ) : (
        <div className="@container max-h-80 overflow-auto bg-surface-alt">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {lines.map((line, index) => (
                <Fragment key={index}>
                <tr
                  className={`${lineTones[line.kind]} ${commentable(line) ? "cursor-pointer hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-border" : ""}`}
                  // A drag that selects code text is not a click on the line.
                  onClick={commentable(line) ? () => !window.getSelection()?.toString() && setNoteAt(noteAt === index ? null : index) : undefined}
                >
                  {line.kind === "hunk" ? (
                    <td colSpan={4} className="px-3 whitespace-pre">{line.text}</td>
                  ) : (
                    <>
                      <td className="w-px pl-3 pr-1 text-right text-text-muted select-none tabular-nums">{line.oldLine ?? ""}</td>
                      <td className="w-px px-1 text-right text-text-muted select-none tabular-nums">
                        {commentable(line) ? (
                          <button
                            type="button"
                            aria-label={`Comment on line ${line.newLine ?? line.oldLine}`}
                            className="p-0 border-none bg-transparent font-mono text-xs text-inherit cursor-pointer"
                          >
                            {line.newLine ?? ""}
                          </button>
                        ) : (
                          line.newLine ?? ""
                        )}
                      </td>
                      <td className={`w-px pl-2 select-none ${signTones[line.kind]}`}>{signs[line.kind]}</td>
                      <td className="pr-3 whitespace-pre">{line.text}</td>
                    </>
                  )}
                </tr>
                {onComment && noteAt === index && (
                  <NoteRow
                    onCancel={() => setNoteAt(null)}
                    onAdd={(note) => {
                      onComment(line, note);
                      setNoteAt(null);
                    }}
                  />
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
