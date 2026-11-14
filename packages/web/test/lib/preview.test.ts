import { describe, expect, it } from "vitest";
import type { ChatItem } from "@chomp/shared";
import { clampRect, fitFrame, latestPreview, marksMessage, pagePoint, pressedKey, previewWindowCalls, wheelPixels, type PreviewMark } from "../../src/lib/preview";

const base = { conversationId: "c1", turnId: "t1", updatedAt: "2026-11-06T10:00:00Z", createdAt: "2026-11-06T10:00:00Z" };

function call(id: string, seq: number, tool: string, output?: string): ChatItem {
  return { ...base, id, seq, kind: "tool_call", tool, title: id, output, status: "completed" };
}

const OPEN = "mcp__chomp-api__preview_start";

describe("latestPreview", () => {
  it("takes the newest call that opened a page", () => {
    const items = [
      call("a", 1, OPEN, "Preview open at http://localhost:5173/\nServer: \"web\"."),
      call("b", 2, OPEN, "Preview open at http://localhost:5174/settings\nmore"),
      call("c", 3, "Read", "Preview open at http://localhost:9999/"),
    ];
    expect(latestPreview(items)).toEqual({ itemId: "b", url: "http://localhost:5174/settings" });
  });

  it("skips a call that failed, and a call still running, and has nothing without a call", () => {
    const items = [call("a", 1, OPEN, "Preview open at http://localhost:5173/"), call("b", 2, OPEN, "Error: Port 5174 is already in use."), call("c", 3, OPEN)];
    expect(latestPreview(items)?.itemId).toBe("a");
    expect(latestPreview([])).toBeNull();
  });

  it("reads a URL out of JSON-wrapped output", () => {
    expect(latestPreview([call("a", 1, OPEN, '[{"type":"text","text":"Preview open at http://localhost:5173/\\nmore"}]')])?.url).toBe("http://localhost:5173/");
  });
});

describe("previewWindowCalls", () => {
  const WINDOW = "mcp__chomp-api__preview_window";

  it("lists the calls that succeeded with a known view, oldest first", () => {
    const items = [
      call("a", 1, WINDOW, "Preview window: full\nThe web chat follows this."),
      call("b", 2, WINDOW, "Error: No page is open in this chat's preview."),
      call("c", 3, WINDOW),
      call("d", 4, WINDOW, '[{"type":"text","text":"Preview window: pop_out\\nmore"}]'),
      call("e", 5, "Read", "Preview window: close"),
      call("f", 6, WINDOW, "Preview window: fullscreen"),
    ];
    expect(previewWindowCalls(items).map((c) => [c.itemId, c.view])).toEqual([["a", "full"], ["d", "pop_out"]]);
  });
});

describe("clampRect", () => {
  const viewport = { width: 1000, height: 800 };
  const rect = { x: 100, y: 100, width: 400, height: 300 };

  it("leaves a window on screen alone, stops at every edge, and shrinks one bigger than the viewport", () => {
    {
      expect(clampRect(rect, viewport)).toEqual(rect);
      expect(clampRect({ ...rect, x: 5000, y: 5000 }, viewport)).toMatchObject({ x: 600, y: 500 });
      expect(clampRect({ ...rect, x: -5000, y: -5000 }, viewport)).toMatchObject({ x: 0, y: 0 });
    }
    {
      expect(clampRect({ x: 342, y: 64, width: 480, height: 360 }, { width: 390, height: 844 })).toEqual({ x: 0, y: 64, width: 390, height: 360 });
    }
  });

});

describe("fitFrame", () => {
  it("shows a page that fits at its own size, and shrinks one that does not, keeping its shape", () => {
    expect(fitFrame({ width: 375, height: 812 }, { width: 800, height: 900 })).toEqual({ width: 375, height: 812 });
    expect(fitFrame({ width: 768, height: 1024 }, { width: 400, height: 1000 })).toEqual({ width: 400, height: 533 });
  });
});

describe("pagePoint", () => {
  it("maps a pointer on a shrunk frame to the page's own pixels", () => {
    expect(pagePoint({ x: 150, y: 70 }, { left: 100, top: 20, width: 200, height: 100 }, { width: 400, height: 200 })).toEqual({ x: 100, y: 100 });
  });
});

const key = (k: string, mods: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) =>
  pressedKey({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

describe("pressedKey", () => {
  it("leaves typed text, paste and a lone modifier to the browser, and sends named keys with Cmd and Ctrl as one shortcut", () => {
    {
      expect(key("a")).toBeNull();
      expect(key("A", { shiftKey: true })).toBeNull();
      expect(key("v", { metaKey: true })).toBeNull();
      expect(key("Shift", { shiftKey: true })).toBeNull();
    }
    {
      expect(key("Enter")).toBe("Enter");
      expect(key("Tab", { shiftKey: true })).toBe("Shift+Tab");
      expect(key("a", { metaKey: true })).toBe("ControlOrMeta+a");
      expect(key("a", { ctrlKey: true })).toBe("ControlOrMeta+a");
    }
  });

});

describe("wheelPixels", () => {
  it("turns lines into pixels", () => {
    expect(wheelPixels(3, 1)).toBe(48);
    expect(wheelPixels(120, 0)).toBe(120);
  });
});

describe("marksMessage", () => {
  const mark = (id: number, url: string, comment: string): PreviewMark => ({
    id,
    url,
    comment,
    element: { label: 'button "Add"', selector: "#add", box: { x: 10.4, y: 20.6, width: 80, height: 32 }, text: "Add" },
  });

  it("is empty without marks, numbers each mark with what finds it and what the user said, and names the page when marks come from several", () => {
    {
      expect(marksMessage([])).toBe("");
      expect(marksMessage([mark(1, "http://localhost:5173/", "make it green "), mark(2, "http://localhost:5173/", "")])).toBe(
        [
          "Pointed at in the preview (http://localhost:5173/):",
          '1. button "Add", `#add`, at 10,21 size 80x32: make it green',
          '2. button "Add", `#add`, at 10,21 size 80x32',
          "Each has a picture attached, in the same order.",
        ].join("\n"),
      );
    }
    {
      expect(marksMessage([mark(1, "http://a/", "x"), mark(2, "http://b/", "y")])).toContain("size 80x32 on http://b/: y");
    }
  });

});
