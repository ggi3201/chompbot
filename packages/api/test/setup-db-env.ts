// Per-worker safety net. Runs before any test module imports db/index.ts.
//
// Chomp agents execute inside a PTY spawned by the systemd service, so a
// `vitest` run inherits DB_PATH=<prod> and CHOMP_ALLOW_PROD_DB=1 from the
// service environment. If those reach a worker, the test beforeEach
// db.delete() hooks would truncate the real production database. This strips
// the prod-DB opt-in and refuses to proceed unless DB_PATH points at an
// ephemeral /tmp database — failing loudly instead of silently wiping prod.
delete process.env.CHOMP_ALLOW_PROD_DB;
process.env.NODE_ENV = "test";
process.env.SKETCHES_DIR = "/tmp/chomp-test-sketches";

if (!process.env.DB_PATH || !process.env.DB_PATH.startsWith("/tmp/")) {
  throw new Error(
    `[test setup] DB_PATH is '${process.env.DB_PATH ?? "(unset)"}', expected a /tmp path. ` +
    `Refusing to run tests against a non-ephemeral database — check vitest.config.ts ` +
    `and ensure the launching shell isn't forcing a production DB_PATH.`,
  );
}
