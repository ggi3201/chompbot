import { describe, expect, it } from "vitest";
import { arrowKey, barKeyBytes, KEY_BAR, NO_MODIFIERS, withModifiers } from "../../src/lib/terminal/keys";
import { folderLabel, terminalLabel } from "../../src/lib/terminal/labels";

const key = (name: string) => KEY_BAR.find((k) => k.name === name)!;

describe("the phone's latched modifiers", () => {
  it("leave text alone when none is latched", () => {
    expect(withModifiers("ls -la", NO_MODIFIERS)).toBe("ls -la");
  });

  it.each([
    ["c", "\x03"],
    ["C", "\x03"],
    ["d", "\x04"],
    ["l", "\x0c"],
    ["[", "\x1b"],
    ["\\", "\x1c"],
    [" ", "\x00"],
    ["?", "\x7f"],
  ])("Ctrl %j sends its control code", (typed, sent) => {
    expect(withModifiers(typed, { ctrl: true, alt: false })).toBe(sent);
  });

  it("Ctrl leaves a character with no control code as it is", () => {
    expect(withModifiers("1", { ctrl: true, alt: false })).toBe("1");
  });

  it("Ctrl acts on one character only, so a pasted word goes through", () => {
    expect(withModifiers("hello", { ctrl: true, alt: false })).toBe("hello");
  });

  it("Alt prefixes ESC, as Meta does in a shell", () => {
    expect(withModifiers("b", { ctrl: false, alt: true })).toBe("\x1bb");
    expect(withModifiers("x", { ctrl: true, alt: true })).toBe("\x1b\x18");
  });
});

describe("arrow keys", () => {
  it("send CSI in normal mode and SS3 once a program asks for application mode", () => {
    expect(arrowKey("up", NO_MODIFIERS, false)).toBe("\x1b[A");
    expect(arrowKey("up", NO_MODIFIERS, true)).toBe("\x1bOA");
    expect(arrowKey("left", NO_MODIFIERS, false)).toBe("\x1b[D");
  });

  it("carry Ctrl and Alt as xterm's modifier parameter", () => {
    expect(arrowKey("right", { ctrl: true, alt: false }, false)).toBe("\x1b[1;5C");
    expect(arrowKey("left", { ctrl: false, alt: true }, true)).toBe("\x1b[1;3D");
    expect(arrowKey("down", { ctrl: true, alt: true }, false)).toBe("\x1b[1;7B");
  });
});

describe("the key bar", () => {
  it("sends Escape and Tab as their bytes", () => {
    expect(barKeyBytes(key("Escape"), NO_MODIFIERS, false)).toBe("\x1b");
    expect(barKeyBytes(key("Tab"), NO_MODIFIERS, false)).toBe("\t");
  });

  it("sends nothing for a modifier key itself", () => {
    expect(barKeyBytes(key("Control"), NO_MODIFIERS, false)).toBeNull();
  });

  it("applies latched modifiers to its own keys", () => {
    expect(barKeyBytes(key("Up"), { ctrl: true, alt: false }, false)).toBe("\x1b[1;5A");
  });
});

describe("tab names", () => {
  it("call the home folder ~ and any other folder by its last name", () => {
    expect(folderLabel("/home/testuser")).toBe("~");
    expect(folderLabel("/Users/testuser")).toBe("~");
    expect(folderLabel("/home/testuser/code/chomp")).toBe("chomp");
  });

  it("prefer the title the shell set, without the user and host every tab shares", () => {
    expect(terminalLabel({ cwd: "/home/testuser", title: "testuser@test-server: ~/code/chomp" })).toBe("~/code/chomp");
    expect(terminalLabel({ cwd: "/home/testuser", title: "" }, "vim notes.md")).toBe("vim notes.md");
  });

  it("fall back to the folder when nothing set a title", () => {
    expect(terminalLabel({ cwd: "/home/testuser/code/chomp", title: "" })).toBe("chomp");
  });
});
