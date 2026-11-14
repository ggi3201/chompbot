import { describe, expect, it } from "vitest";
import { arrowKey, barKeyBytes, KEY_BAR, NO_MODIFIERS, withModifiers } from "../../src/lib/terminal/keys";
import { folderLabel, terminalLabel } from "../../src/lib/terminal/labels";

const key = (name: string) => KEY_BAR.find((k) => k.name === name)!;

describe("the phone's latched modifiers", () => {
  it("leave text alone with nothing latched; Ctrl sends control codes (not for a character without one or a pasted word); Alt prefixes ESC", () => {
    {
      expect(withModifiers("ls -la", NO_MODIFIERS)).toBe("ls -la");
    }
    {
      const ctrl = { ctrl: true, alt: false };
      const codes: [string, string][] = [["c", "\x03"], ["C", "\x03"], ["d", "\x04"], ["l", "\x0c"], ["[", "\x1b"], ["\\", "\x1c"], [" ", "\x00"], ["?", "\x7f"]];
      for (const [typed, sent] of codes) expect(withModifiers(typed, ctrl), JSON.stringify(typed)).toBe(sent);
      expect(withModifiers("1", ctrl)).toBe("1");
      expect(withModifiers("hello", ctrl)).toBe("hello");
    }
    {
      expect(withModifiers("b", { ctrl: false, alt: true })).toBe("\x1bb");
      expect(withModifiers("x", { ctrl: true, alt: true })).toBe("\x1b\x18");
    }
  });


});

describe("arrow keys", () => {
  it("send CSI in normal mode and SS3 once a program asks for application mode, with Ctrl and Alt as xterm's modifier parameter", () => {
    expect(arrowKey("up", NO_MODIFIERS, false)).toBe("\x1b[A");
    expect(arrowKey("up", NO_MODIFIERS, true)).toBe("\x1bOA");
    expect(arrowKey("left", NO_MODIFIERS, false)).toBe("\x1b[D");
    // Ctrl and Alt ride as xterm's modifier parameter.
    expect(arrowKey("right", { ctrl: true, alt: false }, false)).toBe("\x1b[1;5C");
    expect(arrowKey("left", { ctrl: false, alt: true }, true)).toBe("\x1b[1;3D");
    expect(arrowKey("down", { ctrl: true, alt: true }, false)).toBe("\x1b[1;7B");
  });
});

describe("the key bar", () => {
  it("sends Escape and Tab as their bytes, nothing for a modifier key, and applies latched modifiers to its own keys", () => {
    expect(barKeyBytes(key("Escape"), NO_MODIFIERS, false)).toBe("\x1b");
    expect(barKeyBytes(key("Tab"), NO_MODIFIERS, false)).toBe("\t");
    expect(barKeyBytes(key("Control"), NO_MODIFIERS, false)).toBeNull();
    expect(barKeyBytes(key("Up"), { ctrl: true, alt: false }, false)).toBe("\x1b[1;5A");
  });
});

describe("tab names", () => {
  it("call home ~ and other folders by their last name, and prefer the shell's title without the shared user and host", () => {
    {
      expect(folderLabel("/home/testuser")).toBe("~");
      expect(folderLabel("/Users/testuser")).toBe("~");
      expect(folderLabel("/home/testuser/code/chomp")).toBe("chomp");
    }
    {
      expect(terminalLabel({ cwd: "/home/testuser", title: "testuser@test-server: ~/code/chomp" })).toBe("~/code/chomp");
      expect(terminalLabel({ cwd: "/home/testuser", title: "" }, "vim notes.md")).toBe("vim notes.md");
      // With nothing setting a title, the folder.
      expect(terminalLabel({ cwd: "/home/testuser/code/chomp", title: "" })).toBe("chomp");
    }
  });

});
