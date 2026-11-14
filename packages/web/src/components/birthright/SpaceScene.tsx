import { useEffect, useRef } from "react";
import { useReducedMotion, type MotionValue } from "motion/react";

const TAU = Math.PI * 2;
const STAR_DENSITY = 1 / 2100; // stars per CSS px of screen
const MAX_STARS = 900;
const FAR_STARS_MAX = 9000;
const BAND_SLOPE = -0.58;
const NEAR_Z = 0.07;
const DRIFT_PER_SECOND = 0.0065;
const WARP_PER_SECOND = 1.5;
const ROLL_PER_SECOND = 0.0032;
const ALPHA_STEPS = 24;

const TINTS = ["255,255,255", "255,221,186", "190,212,255"];
const STYLES = TINTS.map((tint) =>
  Array.from({ length: ALPHA_STEPS + 1 }, (_, i) => `rgba(${tint},${(i / ALPHA_STEPS).toFixed(3)})`),
);

interface Star {
  x: number;
  y: number;
  z: number;
  brightness: number;
  tint: number;
  phase: number;
}

function spawnStar(spread: number, z: number): Star {
  const roll = Math.random();
  return {
    x: (Math.random() * 2 - 1) * spread,
    y: (Math.random() * 2 - 1) * spread,
    z,
    brightness: Math.random() ** 3.4,
    tint: roll < 0.74 ? 0 : roll < 0.87 ? 1 : 2,
    phase: Math.random() * TAU,
  };
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  depth: number;
}

function makeMoteSprite(): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = 96;
  const ctx = sprite.getContext("2d")!;
  const glow = ctx.createRadialGradient(48, 48, 0, 48, 48, 48);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.35, "rgba(255,255,255,0.3)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 96, 96);
  return sprite;
}

/** Layered value noise, cheap enough for one pass over a small buffer at startup. */
function makeNoise(seed: number) {
  const lattice = Float32Array.from({ length: 256 * 256 }, (_, i) => {
    const v = Math.sin(i * 12.9898 + seed) * 43758.5453;
    return v - Math.floor(v);
  });
  const at = (x: number, y: number) => lattice[((y & 255) << 8) | (x & 255)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const sample = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const u = smooth(x - xi), v = smooth(y - yi);
    const top = at(xi, yi) * (1 - u) + at(xi + 1, yi) * u;
    const bottom = at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u;
    return top * (1 - v) + bottom * v;
  };
  return (x: number, y: number) => {
    let sum = 0, amplitude = 0.5, frequency = 1;
    for (let octave = 0; octave < 5; octave++) {
      sum += sample(x * frequency, y * frequency) * amplitude;
      amplitude *= 0.5;
      frequency *= 2.03;
    }
    return sum;
  };
}

/** How far a point on the −1…1 sky sits from the galaxy's band, 0 on it. */
function bandDistance(u: number, v: number): number {
  return Math.abs(v - u * BAND_SLOPE);
}

/** The sky behind the sky: a faint galaxy band in cold dust. It turns with the view, so it stays square and oversized. */
function paintDust(): HTMLCanvasElement {
  const side = 440;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(side, side);
  const clouds = makeNoise(1.7);
  const rifts = makeNoise(9.3);
  for (let py = 0; py < side; py++) {
    for (let px = 0; px < side; px++) {
      const u = (px / side) * 2 - 1, v = (py / side) * 2 - 1;
      const band = Math.exp(-((bandDistance(u, v) / 0.3) ** 2));
      const cloud = Math.max(0, clouds(u * 2.6 + 4, v * 2.6 + 4) - 0.36) * 1.9;
      const rift = 1 - Math.min(1, Math.max(0, rifts(u * 3.4 + 7, v * 3.4 + 2) - 0.46) * 3.2);
      const glow = band * (0.28 + cloud) * rift;
      const haze = cloud * cloud * 0.16;
      const i = (py * side + px) * 4;
      image.data[i] = 3 + glow * 26 + haze * 30;
      image.data[i + 1] = 4 + glow * 30 + haze * 24;
      image.data[i + 2] = 9 + glow * 52 + haze * 58;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Thousands of stars too far away to move, baked once so they cost one draw a frame. Most sit in the band. */
function paintFarStars(side: number, dpr: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext("2d")!;
  const count = Math.min(FAR_STARS_MAX, Math.round((side * side) / (dpr * dpr * 190)));
  for (let i = 0; i < count; i++) {
    const inBand = Math.random() < 0.62;
    const u = Math.random() * 2 - 1;
    const scatter = inBand ? (Math.random() + Math.random() + Math.random() - 1.5) * 0.28 : Math.random() * 2 - 1;
    const v = inBand ? u * BAND_SLOPE + scatter : scatter;
    const light = 0.1 + Math.random() ** 3 * 0.62;
    const radius = (0.32 + Math.random() ** 4 * 0.5) * dpr;
    ctx.fillStyle = `rgba(${TINTS[Math.random() < 0.8 ? 0 : Math.random() < 0.5 ? 1 : 2]},${light.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(((u + 1) / 2) * side, ((v + 1) / 2) * side, radius, 0, TAU);
    ctx.fill();
  }
  return canvas;
}

/** A little film grain over everything, because dark gradients band without it. */
function makeGrain(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 128;
  const tileCtx = tile.getContext("2d")!;
  const dots = tileCtx.createImageData(128, 128);
  for (let i = 0; i < dots.data.length; i += 4) {
    dots.data[i] = dots.data[i + 1] = dots.data[i + 2] = Math.random() * 255;
    dots.data[i + 3] = 6;
  }
  tileCtx.putImageData(dots, 0, 0);
  return ctx.createPattern(tile, "repeat");
}

interface SpaceSceneProps {
  /** Pointer, −1…1 on each axis and already eased: the slow head-turn of someone floating. */
  lookX: MotionValue<number>;
  lookY: MotionValue<number>;
  /** 0 is a slow drift; 1 is a jump through space. */
  warp: MotionValue<number>;
  /** Where everything drifts out from, as a share of the height. The ring sits there. */
  focusY: number;
}

/** The stars. One canvas, redrawn every frame; nothing above it depends on it. */
export default function SpaceScene({ lookX, lookY, warp, focusY }: SpaceSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const moteSprite = makeMoteSprite();
    const dust = paintDust();
    const grain = makeGrain(ctx);
    let width = 0, height = 0, spread = 1;
    let stars: Star[] = [];
    let motes: Mote[] = [];
    let farStars: HTMLCanvasElement | null = null;
    let skySide = 1;
    let roll = Math.random() * TAU;
    let last = performance.now();
    let frame = 0;

    const resize = () => {
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      spread = 1.15 * Math.max(1, width / height);
      const count = Math.min(MAX_STARS, Math.round(width * height * STAR_DENSITY));
      stars = Array.from({ length: count }, () => spawnStar(spread, NEAR_Z + Math.random() * (1 - NEAR_Z)));
      motes = Array.from({ length: 12 }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 3,
        vy: (Math.random() - 0.5) * 3,
        size: 50 + Math.random() * 190,
        alpha: 0.008 + Math.random() * 0.02,
        depth: 12 + Math.random() * 42,
      }));
      // Square and as wide as the diagonal, so the corners stay covered as the sky turns.
      skySide = Math.ceil(Math.hypot(canvas.width, canvas.height) * 1.1);
      farStars = paintFarStars(skySide, dpr);
    };

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      const warpNow = warp.get();
      const dz = (DRIFT_PER_SECOND + warpNow * warpNow * WARP_PER_SECOND) * dt;
      roll += ROLL_PER_SECOND * dt;

      const cx = width / 2;
      const cy = height * focusY;
      const focal = Math.min(width, height) * 0.7;
      // A slow wander on top of the pointer, so the view never quite settles.
      const camX = lookX.get() * 0.05 + Math.sin(t * 0.071) * 0.022 + Math.sin(t * 0.031 + 1.3) * 0.012;
      const camY = lookY.get() * 0.05 + Math.sin(t * 0.053 + 2.1) * 0.018;
      const cos = Math.cos(roll), sin = Math.sin(roll);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(canvas.width / 2 - camX * 26 * dpr, canvas.height / 2 - camY * 26 * dpr);
      ctx.rotate(roll);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(dust, -skySide / 2, -skySide / 2, skySide, skySide);
      if (farStars) ctx.drawImage(farStars, -skySide / 2, -skySide / 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      for (const star of stars) {
        star.z -= dz;
        if (star.z < NEAR_Z) Object.assign(star, spawnStar(spread, 1));

        const rx = star.x * cos - star.y * sin;
        const ry = star.x * sin + star.y * cos;
        const sx = cx + ((rx - camX) / star.z) * focal;
        const sy = cy + ((ry - camY) / star.z) * focal;
        if (sx < -40 || sx > width + 40 || sy < -40 || sy > height + 40) continue;

        const closeness = 1 - star.z;
        const fadeIn = Math.min(1, closeness * 7);
        const twinkle = reduced ? 1 : 1 + 0.14 * Math.sin(t * 1.3 + star.phase);
        const light = Math.min(1, (0.26 + star.brightness * 0.86 + closeness * 0.3) * fadeIn * twinkle);
        const style = STYLES[star.tint][Math.round(light * ALPHA_STEPS)];
        const radius = (0.42 + star.brightness * 1.1) * (0.72 + closeness * 0.9);

        if (warpNow > 0.04) {
          const tailZ = star.z + 0.012 + warpNow * 0.09;
          ctx.strokeStyle = style;
          ctx.lineWidth = radius * 1.2;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(cx + ((rx - camX) / tailZ) * focal, cy + ((ry - camY) / tailZ) * focal);
          ctx.stroke();
        } else if (radius < 0.62) {
          ctx.fillStyle = style;
          ctx.fillRect(sx - radius, sy - radius, radius * 2, radius * 2);
        } else {
          ctx.fillStyle = style;
          ctx.beginPath();
          ctx.arc(sx, sy, radius, 0, TAU);
          ctx.fill();
        }
      }

      // Dust close to the eye, out of focus. It moves against the stars, which is what sells the depth.
      ctx.globalCompositeOperation = "lighter";
      for (const mote of motes) {
        mote.x += mote.vx * dt;
        mote.y += mote.vy * dt;
        if (mote.x < -mote.size) mote.x = width + mote.size;
        if (mote.x > width + mote.size) mote.x = -mote.size;
        if (mote.y < -mote.size) mote.y = height + mote.size;
        if (mote.y > height + mote.size) mote.y = -mote.size;
        ctx.globalAlpha = mote.alpha;
        ctx.drawImage(
          moteSprite,
          mote.x - camX * mote.depth * 14 - mote.size / 2,
          mote.y - camY * mote.depth * 14 - mote.size / 2,
          mote.size,
          mote.size,
        );
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";

      if (grain) {
        ctx.fillStyle = grain;
        ctx.fillRect(0, 0, width, height);
      }
    };

    resize();
    window.addEventListener("resize", resize);
    if (reduced) {
      draw(last);
    } else {
      const loop = (now: number) => {
        draw(now);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [focusY, lookX, lookY, reduced, warp]);

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 size-full" />;
}
