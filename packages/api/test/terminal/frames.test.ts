import { describe, expect, test } from "vitest";
import { controlFrame, dataFrame, FrameKind, frameReader } from "../../src/terminal/frames.js";

describe("holder frames", () => {
  test("survive any chunking of the stream", () => {
    const stream = Buffer.concat([controlFrame({ type: "resize", cols: 120, rows: 40 }), dataFrame("héllo\x1b[31m"), dataFrame(Buffer.from([0xff, 0x00]))]);
    const frames: [number, string][] = [];
    const read = frameReader((kind, payload) => frames.push([kind, payload.toString("latin1")]));
    for (let i = 0; i < stream.length; i += 3) read(stream.subarray(i, i + 3));

    expect(frames).toEqual([
      [FrameKind.control, JSON.stringify({ type: "resize", cols: 120, rows: 40 })],
      [FrameKind.data, Buffer.from("héllo\x1b[31m").toString("latin1")],
      [FrameKind.data, "\xff\x00"],
    ]);
  });

  test("an empty data frame still arrives", () => {
    const frames: number[] = [];
    frameReader((_kind, payload) => frames.push(payload.length))(dataFrame(""));
    expect(frames).toEqual([0]);
  });
});
