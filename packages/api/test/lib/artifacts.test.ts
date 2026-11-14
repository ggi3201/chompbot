import { test, expect, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let lib: typeof import("../../src/lib/artifacts.js");

beforeAll(async () => {
  process.env.ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), "artifacts-"));
  lib = await import("../../src/lib/artifacts.js");
});

test("saves, reads back with the shim, and replaces by id", () => {
  const id = lib.saveArtifact("<html><head></head><body>one</body></html>");
  const html = lib.readArtifact(id)!;
  expect(html).toContain("one");
  expect(html).toContain("window.chomp");
  expect(html).toContain("viewport");
  lib.saveArtifact("<body>two</body>", id);
  expect(lib.readArtifact(id)).toContain("two");
});

test("rejects unknown ids, path traversal and empty html", () => {
  expect(lib.readArtifact("../../etc/passwd")).toBeNull();
  expect(lib.readArtifact("00000000-0000-0000-0000-000000000000")).toBeNull();
  expect(() => lib.saveArtifact("<p>x</p>", "../x")).toThrow();
  expect(() => lib.saveArtifact("  ")).toThrow();
});
