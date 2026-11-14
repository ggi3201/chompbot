// Sketches: a sheet the user and an agent draw on in turns. Stored as files by unguessable id, like artifacts.
// Every mark is SVG path data, so the agent can write beziers and the browser can stroke them directly.

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";

const SKETCHES_DIR = resolve(process.env.SKETCHES_DIR ?? "./data/sketches");
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./data/uploads";
mkdirSync(SKETCHES_DIR, { recursive: true });

export const SHEET_WIDTH = 1000;
export const SHEET_HEIGHT = 750;
const PAPER = "#f4efe4";
const REFERENCE_OPACITY = 0.45;
const AUTHOR_INK = { user: "#2a2a2c", agent: "#c2571a" } as const;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH_RE = /^[MmLlCcQqSsTtHhVvAaZz0-9eE.,\-\s]+$/;
const COLOR_RE = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
const UPLOAD_URL_RE = /^\/api\/uploads\/[\w.-]+$/;
const MAX_PATH_CHARS = 20_000;
const MAX_STROKES = 5_000;
const MAX_BATCH = 500;

export type SketchAuthor = "user" | "agent";

export interface SketchStroke {
  d: string;
  color: string;
  width: number;
  fill?: string;
  author: SketchAuthor;
}

export interface Sketch {
  id: string;
  title: string;
  reference: string | null;
  note: string | null;
  turn: SketchAuthor;
  strokes: SketchStroke[];
}

/** What a caller may send for a stroke, untrusted. */
export interface StrokeInput {
  d?: unknown;
  color?: unknown;
  width?: unknown;
  fill?: unknown;
}

const pathFor = (id: string) => join(SKETCHES_DIR, `${id}.json`);

export function readSketch(id: string): Sketch | null {
  if (!ID_RE.test(id) || !existsSync(pathFor(id))) return null;
  return JSON.parse(readFileSync(pathFor(id), "utf8")) as Sketch;
}

function requireSketch(id: string): Sketch {
  const sketch = readSketch(id);
  if (!sketch) throw new Error(`No sketch with id ${id}`);
  return sketch;
}

// Written through a rename, so a crash mid-write cannot leave half a drawing.
function writeSketch(sketch: Sketch): Sketch {
  const tmp = `${pathFor(sketch.id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(sketch));
  renameSync(tmp, pathFor(sketch.id));
  return sketch;
}

function checkReference(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!UPLOAD_URL_RE.test(url)) throw new Error("reference must be an /api/uploads/<file> URL");
  return url;
}

function cleanStroke(input: StrokeInput, author: SketchAuthor): SketchStroke {
  const d = typeof input.d === "string" ? input.d.trim() : "";
  if (!d || d.length > MAX_PATH_CHARS || !PATH_RE.test(d)) throw new Error("each stroke needs d: valid SVG path data");
  if (!/^[Mm]/.test(d)) throw new Error("stroke path data must start with M");
  const width = typeof input.width === "number" && Number.isFinite(input.width) ? Math.min(40, Math.max(0.5, input.width)) : 3;
  const color = typeof input.color === "string" && COLOR_RE.test(input.color) ? input.color : AUTHOR_INK[author];
  const fill = typeof input.fill === "string" && COLOR_RE.test(input.fill) ? input.fill : undefined;
  return { d, color, width, author, ...(fill ? { fill } : {}) };
}

function cleanBatch(strokes: StrokeInput[], author: SketchAuthor): SketchStroke[] {
  if (strokes.length > MAX_BATCH) throw new Error(`at most ${MAX_BATCH} strokes in one go`);
  return strokes.map((s) => cleanStroke(s, author));
}

export function createSketch(opts: { title: string; reference?: string | null; note?: string | null }): Sketch {
  return writeSketch({
    id: randomUUID(),
    title: opts.title,
    reference: checkReference(opts.reference),
    note: opts.note ?? null,
    turn: "user",
    strokes: [],
  });
}

/** Adds marks. An agent's marks also end its turn, and its note replaces the one on the sheet. */
export function addStrokes(
  id: string,
  strokes: StrokeInput[],
  author: SketchAuthor,
  opts: { note?: string | null; reference?: string | null } = {},
): Sketch {
  const sketch = requireSketch(id);
  const clean = cleanBatch(strokes, author);
  if (sketch.strokes.length + clean.length > MAX_STROKES) throw new Error(`a sheet holds at most ${MAX_STROKES} strokes`);
  return writeSketch({
    ...sketch,
    strokes: [...sketch.strokes, ...clean],
    reference: opts.reference === undefined ? sketch.reference : checkReference(opts.reference),
    ...(author === "agent" ? { turn: "user" as const, note: opts.note ?? null } : {}),
  });
}

/** Undo for the user's own pen: the agent's marks are not theirs to remove. */
export function removeLastUserStroke(id: string): Sketch {
  const sketch = requireSketch(id);
  const index = sketch.strokes.map((s) => s.author).lastIndexOf("user");
  if (index === -1) return sketch;
  return writeSketch({ ...sketch, strokes: sketch.strokes.filter((_, i) => i !== index) });
}

export function updateSketch(id: string, patch: { turn?: unknown; reference?: unknown }): Sketch {
  const sketch = requireSketch(id);
  if (patch.turn !== undefined && patch.turn !== "user" && patch.turn !== "agent") throw new Error("turn must be user or agent");
  if (patch.reference !== undefined && patch.reference !== null && typeof patch.reference !== "string") throw new Error("reference must be a URL");
  return writeSketch({
    ...sketch,
    turn: patch.turn ?? sketch.turn,
    reference: patch.reference === undefined ? sketch.reference : checkReference(patch.reference),
  });
}

/** The canvas fence for a reply. `upTo` freezes this copy at the current marks once the chat moves on. */
export function sketchFence(sketch: Sketch): string {
  return `:::canvas\n${JSON.stringify({ type: "sketchpad", id: sketch.id, title: sketch.title, upTo: sketch.strokes.length })}\n:::`;
}

function strokeMarkup(s: SketchStroke): string {
  return `<path d="${s.d}" fill="${s.fill ?? "none"}" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function referenceMarkup(url: string | null): string {
  if (!url) return "";
  const file = join(UPLOADS_DIR, url.slice("/api/uploads/".length));
  if (!existsSync(file)) return "";
  const ext = extname(file).slice(1).toLowerCase();
  const mime = ext === "jpg" ? "jpeg" : ext;
  const data = readFileSync(file).toString("base64");
  return `<image href="data:image/${mime};base64,${data}" width="${SHEET_WIDTH}" height="${SHEET_HEIGHT}" opacity="${REFERENCE_OPACITY}" preserveAspectRatio="xMidYMid meet"/>`;
}

// A coordinate grid and each stroke's index at its start, so corrections can name a place and a mark.
function gridMarkup(strokes: SketchStroke[]): string {
  const STEP = 50;
  let out = "";
  for (let x = 0; x <= SHEET_WIDTH; x += STEP) {
    out += `<line x1="${x}" y1="0" x2="${x}" y2="${SHEET_HEIGHT}" stroke="#1a7fd4" stroke-width="${x % 250 ? 0.4 : 1}" opacity="0.5"/><text x="${x + 2}" y="10" fill="#1a7fd4" font-size="10" font-family="monospace">${x}</text>`;
  }
  for (let y = 0; y <= SHEET_HEIGHT; y += STEP) {
    out += `<line x1="0" y1="${y}" x2="${SHEET_WIDTH}" y2="${y}" stroke="#1a7fd4" stroke-width="${y % 250 ? 0.4 : 1}" opacity="0.5"/><text x="1" y="${y - 2}" fill="#1a7fd4" font-size="10" font-family="monospace">${y}</text>`;
  }
  strokes.forEach((s, i) => {
    const m = s.d.match(/^[Mm]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/);
    if (m) out += `<circle cx="${m[1]}" cy="${m[2]}" r="8" fill="#e0246f"/><text x="${m[1]}" y="${+m[2] + 3}" fill="#fff" font-size="9" font-family="monospace" text-anchor="middle">${i}</text>`;
  });
  return out;
}

export function sketchSvg(sketch: Pick<Sketch, "reference" | "strokes">, opts: { grid?: boolean } = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_WIDTH}" height="${SHEET_HEIGHT}" viewBox="0 0 ${SHEET_WIDTH} ${SHEET_HEIGHT}"><rect width="100%" height="100%" fill="${PAPER}"/>${referenceMarkup(sketch.reference)}${sketch.strokes.map(strokeMarkup).join("")}${opts.grid ? gridMarkup(sketch.strokes) : ""}</svg>`;
}

/** Renders a sheet and its grid view to PNGs on disk, for the agent to look at with its file reader. */
async function renderViews(sketch: Pick<Sketch, "id" | "reference" | "strokes">, label: string): Promise<{ sheet: string; grid: string }> {
  const { Resvg } = await import("@resvg/resvg-js");
  const views = { sheet: join(SKETCHES_DIR, `${sketch.id}.${label}.png`), grid: join(SKETCHES_DIR, `${sketch.id}.${label}.grid.png`) };
  writeFileSync(views.sheet, new Resvg(sketchSvg(sketch)).render().asPng());
  writeFileSync(views.grid, new Resvg(sketchSvg(sketch, { grid: true })).render().asPng());
  return views;
}

export function renderSketchViews(id: string): Promise<{ sheet: string; grid: string }> {
  return renderViews(requireSketch(id), "current");
}

/** The sheet as it would look with these marks, without touching it. */
export function renderRehearsal(id: string, strokes: StrokeInput[]): Promise<{ sheet: string; grid: string }> {
  const sketch = requireSketch(id);
  return renderViews({ ...sketch, strokes: [...sketch.strokes, ...cleanBatch(strokes, "agent")] }, "rehearsal");
}

/** A compact account of the sheet for the agent: full path data would flood its context. */
export function describeSketch(sketch: Sketch): string {
  const marks = sketch.strokes.map((s, i) => {
    const start = s.d.match(/^[Mm]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/);
    return `${i} ${s.author} ${s.color}${s.fill ? ` fill ${s.fill}` : ""} from ${start ? `${start[1]},${start[2]}` : "?"}`;
  });
  return [
    `"${sketch.title}", ${SHEET_WIDTH}x${SHEET_HEIGHT}, ${sketch.strokes.length} strokes, turn: ${sketch.turn}`,
    `Reference image: ${sketch.reference ?? "none"}`,
    `Your last note: ${sketch.note ?? "none"}`,
    ...marks.slice(-200),
  ].join("\n");
}
