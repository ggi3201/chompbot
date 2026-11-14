import { describe, expect, it } from "vitest";
import { deviceToolResult } from "../../src/mcp/tool-handlers.js";

describe("deviceToolResult", () => {
  it("sends an image as an image block, with no base64 in the text", () => {
    const { content } = deviceToolResult({ id: "a/L0/001", width: 10, mimeType: "image/png", imageBase64: "QUJD" });
    expect(content[0]).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
    expect(content[1].type === "text" && JSON.parse(content[1].text)).toEqual({ id: "a/L0/001", width: 10 });
  });

  it("leaves other results as text", () => {
    expect(deviceToolResult("hi").content).toEqual([{ type: "text", text: "hi" }]);
    expect(deviceToolResult({ steps: 5 }).content).toEqual([{ type: "text", text: JSON.stringify({ steps: 5 }, null, 2) }]);
  });
});
