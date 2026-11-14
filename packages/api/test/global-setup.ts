export default async function setup() {
  const { runMigrations } = await import("../src/db/index.js");
  runMigrations();
}
