import { expect, test } from "vitest";
import { blur, inflate, interiorOf } from "../../src/lib/sketch-finish";

const W = 40;
const H = 30;

function square(open = false): Float32Array {
  const ink = new Float32Array(W * H);
  for (let i = 10; i <= 30; i++) {
    ink[i + 5 * W] = 1;
    ink[i + 25 * W] = 1;
  }
  for (let y = 5; y <= 25; y++) {
    ink[10 + y * W] = 1;
    if (!(open && y === 15)) ink[30 + y * W] = 1;
  }
  return ink;
}

test("a closed outline has an inside, not counting the ink itself, and an open one does not", () => {
  expect(interiorOf(square(), W, H)[20 + 15 * W]).toBe(1);
  expect(interiorOf(square(), W, H)[2 + 2 * W]).toBe(0);
  expect(interiorOf(square(true), W, H).reduce((sum, v) => sum + v, 0)).toBe(0);
  expect(interiorOf(square(), W, H)[10 + 15 * W]).toBe(0);
});

test("blur keeps a flat field flat and spreads a peak", () => {
  const flat = new Float32Array(W * H).fill(0.5);
  expect(blur(flat, W, H, 3)[17 + 13 * W]).toBeCloseTo(0.5, 5);

  const peak = new Float32Array(W * H);
  peak[20 + 15 * W] = 1;
  const spread = blur(peak, W, H, 2);
  expect(spread[20 + 15 * W]).toBeLessThan(1);
  expect(spread[21 + 15 * W]).toBeGreaterThan(0);
});

test("inflating a shape is highest in its middle and zero outside it", () => {
  const mask = Float32Array.from(interiorOf(square(), W, H));
  const form = inflate(mask, W, H, 3);
  expect(form[20 + 15 * W]).toBeGreaterThan(form[11 + 15 * W]);
  expect(form[2 + 2 * W]).toBe(0);
});
