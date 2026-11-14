import { describe, expect, it } from "vitest";
import { fileLanguage, isImageFile, isMarkdownFile } from "../../src/lib/file-types";

describe("file types", () => {
  it("picks the language from the extension or a well-known name, and knows images and Markdown", () => {
    expect(fileLanguage("packages/web/src/App.tsx")).toBe("tsx");
    expect(fileLanguage("scripts/run.SH")).toBe("bash");
    expect(fileLanguage("Dockerfile")).toBe("docker");
    expect(fileLanguage(".env.local")).toBe("ini");
    expect(fileLanguage("LICENSE")).toBeNull();
    expect(fileLanguage("archive.tar.gz")).toBeNull();
    expect(isImageFile("assets/icon.SVG")).toBe(true);
    expect(isImageFile("notes.txt")).toBe(false);
    expect(isMarkdownFile("README.md")).toBe(true);
  });
});
