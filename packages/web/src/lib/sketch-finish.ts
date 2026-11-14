// Turns a shared sheet into a finished picture in the browser, with no image model: inflate its shapes into a
// height field for the 3D finish, or lay graphite along the image's structure for the pencil finish.

export const SHEET_WIDTH = 1000;
export const SHEET_HEIGHT = 750;
export const PAPER = "#f4efe4";
const GRAPHITE = "#2b2a2c";

export interface SketchMark {
  d: string;
  color: string;
  width: number;
  fill?: string;
  author: "user" | "agent";
}

export interface SheetContent {
  reference: string | null;
  strokes: SketchMark[];
}

// ── Pure field maths ─────────────────────────────────────────────

/** Three box passes, which is close to a Gaussian and cheap enough for a phone. */
export function blur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius));
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = a[row] * (r + 1);
      for (let i = 1; i <= r; i++) sum += a[row + Math.min(i, w - 1)];
      for (let x = 0; x < w; x++) {
        b[row + x] = sum * norm;
        sum += a[row + Math.min(x + r + 1, w - 1)] - a[row + Math.max(x - r, 0)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = b[x] * (r + 1);
      for (let i = 1; i <= r; i++) sum += b[x + Math.min(i, h - 1) * w];
      for (let y = 0; y < h; y++) {
        a[x + y * w] = sum * norm;
        sum += b[x + Math.min(y + r + 1, h - 1) * w] - b[x + Math.max(y - r, 0) * w];
      }
    }
  }
  return a;
}

/** Marks every pixel a flood from the edge of the sheet cannot reach: the inside of whatever was drawn closed. */
export function interiorOf(ink: Float32Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const visit = (i: number) => {
    if (!outside[i] && ink[i] < 0.5) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    visit(x);
    visit(x + (h - 1) * w);
  }
  for (let y = 0; y < h; y++) {
    visit(y * w);
    visit(w - 1 + y * w);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < w * (h - 1)) visit(i + w);
  }
  return outside.map((v, i) => (v || ink[i] >= 0.5 ? 0 : 1));
}

/** A rounded profile that is zero at a mask's edge and rises towards its middle. */
export function inflate(mask: Float32Array, w: number, h: number, radius: number): Float32Array {
  const soft = blur(mask, w, h, radius);
  return soft.map((v, i) => (mask[i] > 0.5 ? Math.sqrt(Math.max(0, Math.min(1, (v - 0.5) * 2))) : 0));
}

// ── Rasterising the sheet ────────────────────────────────────────

function offscreen(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext("2d", { willReadFrequently: true })!;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load the reference image"));
    img.src = url;
  });
}

function drawContained(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function alphaOf(ctx: CanvasRenderingContext2D, w: number, h: number): Float32Array {
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] / 255;
  return out;
}

function isDark(hex: string): boolean {
  const v = hex.length === 4 ? [hex[1] + hex[1], hex[2] + hex[2], hex[3] + hex[3]] : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  const [r, g, b] = v.map((c) => parseInt(c, 16));
  return 0.3 * r + 0.59 * g + 0.11 * b < 70;
}

interface Layers {
  w: number;
  h: number;
  ink: Float32Array;
  mask: Float32Array;
  /** Colour the user or agent put down, premultiplied, without the dark outline ink. */
  colour: Uint8ClampedArray;
  /** Reference image pixels, and where they exist. */
  photo: Uint8ClampedArray | null;
  photoAlpha: Float32Array | null;
}

function rasterise(content: SheetContent, img: HTMLImageElement | null, w: number, h: number): Layers {
  const scale = w / SHEET_WIDTH;
  const inkCtx = offscreen(w, h);
  const fillCtx = offscreen(w, h);
  const colourCtx = offscreen(w, h);
  for (const ctx of [inkCtx, fillCtx, colourCtx]) {
    ctx.scale(scale, scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }
  for (const mark of content.strokes) {
    const path = new Path2D(mark.d);
    // A hairline must still close its shape at this resolution, or the flood leaks through it.
    inkCtx.lineWidth = Math.max(mark.width, 2.5 / scale);
    inkCtx.stroke(path);
    if (mark.fill) {
      fillCtx.fill(path);
      colourCtx.fillStyle = mark.fill;
      colourCtx.fill(path);
    }
    if (!isDark(mark.color)) {
      colourCtx.strokeStyle = mark.color;
      colourCtx.lineWidth = mark.width * 3;
      colourCtx.stroke(path);
    }
  }
  const ink = alphaOf(inkCtx, w, h);
  const filled = alphaOf(fillCtx, w, h);
  const interior = interiorOf(ink, w, h);
  const mask = new Float32Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = Math.max(ink[i], filled[i], interior[i]);

  let photo: Uint8ClampedArray | null = null;
  let photoAlpha: Float32Array | null = null;
  if (img) {
    const ctx = offscreen(w, h);
    drawContained(ctx, img, w, h);
    photo = ctx.getImageData(0, 0, w, h).data;
    photoAlpha = alphaOf(ctx, w, h);
  }
  return { w, h, ink, mask, colour: colourCtx.getImageData(0, 0, w, h).data, photo, photoAlpha };
}

// ── The 3D finish: clay under a sun you can move ─────────────────

export interface Form {
  w: number;
  h: number;
  height: Float32Array;
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
  ao: Float32Array;
  mask: Float32Array;
  albedo: Float32Array;
  grain: Float32Array;
  relief: number;
}

const CLAY = [0.72, 0.47, 0.3];

function srgbToLinear(v: number): number {
  return Math.pow(v / 255, 2.2);
}

export function buildForm(content: SheetContent, img: HTMLImageElement | null, w: number, h: number): Form {
  const layers = rasterise(content, img, w, h);
  const { ink, mask, colour, photo, photoAlpha } = layers;
  const relief = w * 0.14;
  const big = inflate(mask, w, h, w * 0.05);
  const mid = inflate(mask, w, h, w * 0.018);
  const small = inflate(mask, w, h, w * 0.006);
  const height = new Float32Array(w * h);
  for (let i = 0; i < height.length; i++) height[i] = (big[i] * 0.6 + mid[i] * 0.28 + small[i] * 0.12) * relief;

  // The drawn lines stay readable, as creases cut into the surface.
  const crease = blur(ink, w, h, 1);
  for (let i = 0; i < height.length; i++) height[i] -= crease[i] * w * 0.006 * (mask[i] > 0 ? 1 : 0);

  if (photo && photoAlpha) {
    const lum = new Float32Array(w * h);
    for (let i = 0; i < lum.length; i++) lum[i] = (0.3 * photo[i * 4] + 0.59 * photo[i * 4 + 1] + 0.11 * photo[i * 4 + 2]) / 255;
    const soft = blur(lum, w, h, 1.5);
    for (let i = 0; i < height.length; i++) {
      height[i] += soft[i] * photoAlpha[i] * w * 0.05;
      mask[i] = Math.max(mask[i], photoAlpha[i]);
    }
  }

  const smooth = blur(height, w, h, 1);
  const nx = new Float32Array(w * h);
  const ny = new Float32Array(w * h);
  const nz = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = x + y * w;
      const gx = smooth[y * w + Math.min(x + 1, w - 1)] - smooth[y * w + Math.max(x - 1, 0)];
      const gy = smooth[x + Math.min(y + 1, h - 1) * w] - smooth[x + Math.max(y - 1, 0) * w];
      const len = 1 / Math.hypot(gx * 0.7, gy * 0.7, 1);
      nx[i] = -gx * 0.7 * len;
      ny[i] = -gy * 0.7 * len;
      nz[i] = len;
    }
  }
  const wide = blur(smooth, w, h, w * 0.02);
  const ao = wide.map((v, i) => Math.max(0.42, Math.min(1, 1 - Math.max(0, v - smooth[i]) / (relief * 0.22))));

  // Colour bleeds outward from where it was put down, so a stroke of ember tints the form around it.
  const alpha = new Float32Array(w * h);
  const channels = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  for (let i = 0; i < alpha.length; i++) {
    const a = colour[i * 4 + 3] / 255;
    alpha[i] = a;
    for (let c = 0; c < 3; c++) channels[c][i] = srgbToLinear(colour[i * 4 + c]) * a;
  }
  const softAlpha = blur(alpha, w, h, w * 0.03);
  const softChannels = channels.map((c) => blur(c, w, h, w * 0.03));
  const albedo = new Float32Array(w * h * 3);
  for (let i = 0; i < alpha.length; i++) {
    const t = Math.min(1, softAlpha[i] * 4);
    for (let c = 0; c < 3; c++) {
      const tinted = softAlpha[i] > 0.001 ? softChannels[c][i] / softAlpha[i] : CLAY[c];
      const base = CLAY[c] * (1 - t) + tinted * t;
      albedo[i * 3 + c] = photo && photoAlpha && photoAlpha[i] > 0.5 ? srgbToLinear(photo[i * 4 + c]) : base;
    }
  }
  const grain = new Float32Array(w * h);
  for (let i = 0; i < grain.length; i++) grain[i] = (Math.random() + Math.random() - 1) * 0.012;
  return { w, h, height: smooth, nx, ny, nz, ao, mask, albedo, grain, relief };
}

// Filmic curve and gamma as one table, so each frame costs a lookup instead of three pow() per pixel.
const TONE_STEPS = 4096;
const TONE = new Uint8ClampedArray(TONE_STEPS);
for (let i = 0; i < TONE_STEPS; i++) {
  const x = (i / (TONE_STEPS - 1)) * 4;
  const mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  TONE[i] = Math.pow(Math.min(1, mapped), 1 / 2.2) * 255;
}
const tone = (v: number) => TONE[Math.min(TONE_STEPS - 1, Math.max(0, (v / 4) * (TONE_STEPS - 1)) | 0)];

/** Lights the form. sunX and sunY run from -1 to 1 across the frame. Cheap enough to redo on every pointer move. */
export function shadeForm(form: Form, sunX: number, sunY: number, out: Uint8ClampedArray) {
  const { w, h, height, nx, ny, nz, ao, mask, albedo, grain, relief } = form;
  const lenL = 1 / Math.hypot(sunX, sunY, 0.72);
  const lx = sunX * lenL;
  const ly = sunY * lenL;
  const lz = 0.72 * lenL;
  const flat = Math.hypot(lx, ly) || 1;
  const stepX = lx / flat;
  const stepY = ly / flat;
  const slope = (lz / flat) * 0.9;
  const STEPS = 7;
  const reach = relief * 0.32;
  const hx = lx * 0.5;
  const hy = ly * 0.5;
  const hz = (lz + 1) * 0.5;
  const hl = 1 / Math.hypot(hx, hy, hz);

  for (let y = 0, i = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++, i++) {
      let shadow = 1;
      const base = height[i];
      for (let s = 1; s <= STEPS; s++) {
        const dist = (s / STEPS) * reach;
        const sx = x + stepX * dist;
        const sy = y + stepY * dist;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) break;
        const over = height[(sx | 0) + (sy | 0) * w] - base - dist * slope;
        if (over > 0) {
          shadow = Math.min(shadow, 1 - Math.min(1, over / (relief * 0.05)));
          if (shadow <= 0) break;
        }
      }
      const edge = mask[i] > 0.5;
      const diff = Math.max(0, (nx[i] * lx + ny[i] * ly + nz[i] * lz + 0.25) / 1.25);
      const fill = Math.max(0, -nx[i] * lx * 0.5 - ny[i] * ly * 0.5 + 0.5);
      const spec = Math.pow(Math.max(0, (nx[i] * hx + ny[i] * hy + nz[i] * hz) * hl), 28) * 0.14;
      const rim = edge ? Math.pow(1 - nz[i], 5) * 0.5 : 0;
      const key = diff * shadow * ao[i];
      let r: number, g: number, b: number;
      if (edge) {
        r = albedo[i * 3] * (key * 1.75 + fill * 0.14 + 0.05) + spec + rim * 0.7;
        g = albedo[i * 3 + 1] * (key * 1.46 + fill * 0.15 + 0.05) + spec * 0.92 + rim * 0.8;
        b = albedo[i * 3 + 2] * (key * 1.1 + fill * 0.2 + 0.06) + spec * 0.82 + rim;
      } else {
        // A dim teal studio with a warm pool of light that follows the sun.
        const pool = Math.max(0, 1 - Math.hypot((x / w - 0.5 - sunX * 0.2) * 1.5, (v - 0.55 - sunY * 0.2) * 1.5));
        const lit = (0.018 + pool * pool * 0.1) * (0.35 + 0.65 * shadow);
        r = lit * 1.1;
        g = lit * 1.15;
        b = lit * 1.2;
      }
      const vignette = 1 - 0.5 * Math.pow(Math.hypot(x / w - 0.5, v - 0.5) * 1.35, 2.4);
      const o = i * 4;
      const n = grain[i];
      out[o] = tone(r * vignette) + n * 255;
      out[o + 1] = tone(g * vignette) + n * 255;
      out[o + 2] = tone(b * vignette) + n * 255;
      out[o + 3] = 255;
    }
  }
}

// ── The pencil finish ────────────────────────────────────────────

function percentile(values: Float32Array, q: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

const HATCH_ANGLE = (-52 * Math.PI) / 180;

/** How dark each pixel should end up, and which way a pencil would travel there. */
function pencilField(content: SheetContent, img: HTMLImageElement | null, w: number, h: number) {
  const layers = rasterise(content, img, w, h);
  const { mask, colour, photo, photoAlpha } = layers;
  const dark = new Float32Array(w * h);
  const structure = new Float32Array(w * h);

  // A drawn shape is shaded like a form under a light from the upper right, plus the value of any colour put on it.
  const relief = w * 0.14;
  const form = blur(inflate(mask, w, h, w * 0.05), w, h, 2);
  const LIGHT = [0.55, -0.6, 0.58];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = x + y * w;
      if (mask[i] < 0.5) continue;
      const gx = (form[y * w + Math.min(x + 1, w - 1)] - form[y * w + Math.max(x - 1, 0)]) * relief * 0.5;
      const gy = (form[x + Math.min(y + 1, h - 1) * w] - form[x + Math.max(y - 1, 0) * w]) * relief * 0.5;
      const len = 1 / Math.hypot(gx, gy, 1);
      const lit = Math.max(0, (-gx * LIGHT[0] - gy * LIGHT[1] + LIGHT[2]) * len);
      const a = colour[i * 4 + 3] / 255;
      const value = a * (1 - (0.3 * colour[i * 4] + 0.59 * colour[i * 4 + 1] + 0.11 * colour[i * 4 + 2]) / 255);
      dark[i] = Math.min(0.85, Math.pow(1 - lit, 1.6) * 0.34 + value * 0.36);
      structure[i] = form[i];
    }
  }

  if (photo && photoAlpha) {
    const lum = new Float32Array(w * h);
    for (let i = 0; i < lum.length; i++) lum[i] = (0.3 * photo[i * 4] + 0.59 * photo[i * 4 + 1] + 0.11 * photo[i * 4 + 2]) / 255;
    const wide = blur(lum, w, h, w * 0.02);
    const contrast = lum.map((v, i) => v + 0.35 * (v - wide[i]));
    const hi = percentile(contrast, 0.97);
    const lo = percentile(contrast, 0.02);
    const span = Math.max(0.05, hi - lo);
    // A closed outline on the sheet means: draw only this. It is how a subject gets separated from its background.
    const area = mask.reduce((sum, v) => sum + v, 0) / mask.length;
    const subject = area > 0.02 ? blur(mask, w, h, 3) : null;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = x + y * w;
        // The drawing trails off towards the edges, the way a study does.
        const fade = Math.max(0, Math.min(1, (1.08 - Math.hypot((x / w - 0.5) * 1.5, (y / h - 0.5) * 1.5)) * 2.5));
        const t = Math.max(0, Math.min(1, (hi - contrast[i]) / span));
        dark[i] = subject ? Math.pow(t, 1.25) * photoAlpha[i] * subject[i] : Math.max(dark[i], Math.pow(t, 1.25) * photoAlpha[i] * fade);
        structure[i] = lum[i];
      }
    }
  }

  // Structure tensor: the pencil follows edges where they are strong, and keeps an artist's diagonal where they are not.
  const jxx = new Float32Array(w * h);
  const jxy = new Float32Array(w * h);
  const jyy = new Float32Array(w * h);
  const soft = blur(structure, w, h, 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = x + y * w;
      const gx = soft[y * w + Math.min(x + 1, w - 1)] - soft[y * w + Math.max(x - 1, 0)];
      const gy = soft[x + Math.min(y + 1, h - 1) * w] - soft[x + Math.max(y - 1, 0) * w];
      jxx[i] = gx * gx;
      jxy[i] = gx * gy;
      jyy[i] = gy * gy;
    }
  }
  const sxx = blur(jxx, w, h, 4);
  const sxy = blur(jxy, w, h, 4);
  const syy = blur(jyy, w, h, 4);
  let energy = 0;
  for (let i = 0; i < sxx.length; i++) energy += sxx[i] + syy[i];
  energy = energy / sxx.length + 1e-9;
  const prior = 0.9 * energy;
  const theta = new Float32Array(w * h);
  for (let i = 0; i < theta.length; i++) {
    const vx = sxx[i] - syy[i] - prior * Math.cos(2 * HATCH_ANGLE);
    const vy = 2 * sxy[i] - prior * Math.sin(2 * HATCH_ANGLE);
    theta[i] = 0.5 * Math.atan2(vy, vx) + Math.PI / 2;
  }
  return { dark, theta };
}

const PENCIL_PASSES: { from: number; length: number; width: number; rot: number; alpha: number; count: number }[] = [
  { from: 0.03, length: 34, width: 0.9, rot: 0, alpha: 0.1, count: 9000 },
  { from: 0.1, length: 30, width: 0.9, rot: 0, alpha: 0.13, count: 9000 },
  { from: 0.18, length: 26, width: 1.1, rot: 0.5, alpha: 0.15, count: 9000 },
  { from: 0.28, length: 22, width: 1.1, rot: -0.45, alpha: 0.18, count: 10000 },
  { from: 0.4, length: 18, width: 1.1, rot: 0, alpha: 0.22, count: 11000 },
  { from: 0.54, length: 15, width: 1.2, rot: 0.42, alpha: 0.26, count: 12000 },
  { from: 0.68, length: 12, width: 1.2, rot: -0.38, alpha: 0.3, count: 13000 },
  { from: 0.82, length: 9, width: 1.3, rot: 0, alpha: 0.36, count: 14000 },
];

const STROKES_PER_PATH = 120;
const FIELD_TO_OUTPUT = 2;

/** Lays graphite on `ctx` a little at a time, yielding so the page can show the drawing building up. */
export function* drawPencil(ctx: CanvasRenderingContext2D, content: SheetContent, img: HTMLImageElement | null): Generator<void> {
  const fw = ctx.canvas.width / FIELD_TO_OUTPUT;
  const fh = ctx.canvas.height / FIELD_TO_OUTPUT;
  const { dark, theta } = pencilField(content, img, fw, fh);
  yield;
  ctx.strokeStyle = GRAPHITE;
  ctx.lineCap = "round";
  const lengthScale = img ? 0.55 : 1;
  for (const pass of PENCIL_PASSES) {
    ctx.globalAlpha = pass.alpha;
    ctx.lineWidth = pass.width * FIELD_TO_OUTPUT * 0.75;
    let placed = 0;
    let attempts = 0;
    ctx.beginPath();
    while (placed < pass.count && attempts < pass.count * 12) {
      attempts++;
      let x = Math.random() * (fw - 1);
      let y = Math.random() * (fh - 1);
      const start = (x | 0) + (y | 0) * fw;
      if (Math.random() > Math.min(1, (dark[start] - pass.from) / 0.09)) continue;
      placed++;
      const length = pass.length * lengthScale * (0.6 + Math.random() * 0.8);
      ctx.moveTo(x * FIELD_TO_OUTPUT, y * FIELD_TO_OUTPUT);
      let px = 0;
      let py = 0;
      for (let s = 0; s < 4; s++) {
        if (x < 0 || y < 0 || x >= fw || y >= fh) break;
        const i = (x | 0) + (y | 0) * fw;
        // A pencil stops where the tone does, so shading stays inside its shape.
        if (s > 0 && dark[i] < pass.from) break;
        const a = theta[i] + pass.rot + (Math.random() - 0.5) * 0.1;
        let dx = Math.cos(a);
        let dy = Math.sin(a);
        if (dx * px + dy * py < 0) {
          dx = -dx;
          dy = -dy;
        }
        px = dx;
        py = dy;
        x += (dx * length) / 4;
        y += (dy * length) / 4;
        ctx.lineTo(x * FIELD_TO_OUTPUT, y * FIELD_TO_OUTPUT);
      }
      if (placed % STROKES_PER_PATH === 0) {
        ctx.stroke();
        ctx.beginPath();
        yield;
      }
    }
    ctx.stroke();
    ctx.beginPath();
    yield;
  }

  // The drawn lines go over the top last, gone over a few times like a hand restating a contour.
  const scale = ctx.canvas.width / SHEET_WIDTH;
  ctx.lineJoin = "round";
  for (const mark of content.strokes) {
    const path = new Path2D(mark.d);
    for (let pass = 0; pass < 3; pass++) {
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.6);
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = Math.max(1, Math.min(mark.width, 7) * 0.8);
      ctx.stroke(path);
      ctx.restore();
    }
    yield;
  }
  ctx.globalAlpha = 1;
}

/** Specks of paper that show through graphite, because pencil only catches the high points of the grain. */
export function paperTooth(): CanvasPattern {
  const size = 256;
  const ctx = offscreen(size, size);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    image.data[i * 4] = 244;
    image.data[i * 4 + 1] = 239;
    image.data[i * 4 + 2] = 228;
    image.data[i * 4 + 3] = Math.pow(Math.random(), 2.2) * 150;
  }
  ctx.putImageData(image, 0, 0);
  return ctx.createPattern(ctx.canvas, "repeat")!;
}
