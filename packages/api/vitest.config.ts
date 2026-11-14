import { defineConfig } from "vitest/config";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testDbDir = mkdtempSync(join(tmpdir(), "chomp-test-"));
const testDbPath = join(testDbDir, "test.db");

// Set BEFORE any test code (or globalSetup) imports db/index.ts.
// Also exposed via test.env so vitest worker processes inherit it.
//
// Chomp agents run inside a PTY spawned by the systemd service, so the shell
// inherits DB_PATH=<prod> and CHOMP_ALLOW_PROD_DB=1 from the service env. If
// those leak into a `vitest` run, the test beforeEach db.delete() hooks would
// wipe the real database. Force the ephemeral path and strip the prod-DB opt-in
// here (main process) and via test.env + setupFiles (workers) so a test can
// NEVER resolve to a non-/tmp DB regardless of the launching environment.
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = "test";
// The tests' expected clock times are in one zone, whatever zone the machine running them is in.
process.env.TZ = "Europe/Oslo";
delete process.env.CHOMP_ALLOW_PROD_DB;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup-db-env.ts"],
    env: {
      DB_PATH: testDbPath,
      NODE_ENV: "test",
      TZ: "Europe/Oslo",
      CHOMP_ALLOW_PROD_DB: "",
    },
    pool: "forks",
    // Every test file shares the one SQLite file above, so files must not overlap.
    fileParallelism: false,
    testTimeout: 10_000,
    reporters: ["default"],
    clearMocks: true,
  },
});
