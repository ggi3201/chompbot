/**
 * The prompt ↑ or ↓ recalls into the composer, or null to leave the key alone.
 * It only steps from an empty composer or from a recalled prompt left unedited, so it never
 * eats text being typed. In a multi-line prompt it waits until the caret reaches the edge.
 */
export function stepPrompt(sent: string[], input: string, direction: "up" | "down", caret: { atStart: boolean; atEnd: boolean }): string | null {
  if (sent.length === 0) return null;
  const index = sent.lastIndexOf(input);
  const multiLine = input.includes("\n");
  if (direction === "up") {
    if (input === "") return sent[sent.length - 1];
    if (index <= 0 || (multiLine && !caret.atStart)) return null;
    return sent[index - 1];
  }
  if (index < 0 || (multiLine && !caret.atEnd)) return null;
  return index === sent.length - 1 ? "" : sent[index + 1];
}

/** A Markdown quote of `text`, ready to answer under. */
export function quoteBlock(text: string): string {
  return `${text.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
}

/** A note on one line of a changed file: where it is, the line quoted, then the note. */
export function diffComment(path: string, line: { kind: string; text: string; oldLine?: number; newLine?: number }, note: string): string {
  const where = line.kind === "del" ? `\`${path}\`, removed line ${line.oldLine}` : `\`${path}:${line.newLine}\``;
  return `${where}\n${quoteBlock(line.text || " ")}${note.trim()}\n`;
}
