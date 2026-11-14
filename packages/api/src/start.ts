// Entry point that loads .env before any modules initialize.
// ESM static imports are hoisted, so env must be set before dynamic import.
// Relative paths (migrations, ./data) mean packages/api, wherever Chomp was started from.
process.chdir(new URL("..", import.meta.url).pathname);
const envPath = new URL("../../../.env", import.meta.url).pathname;
try {
  process.loadEnvFile(envPath);
} catch {
  // No .env file — production or env vars set externally
}

await import("./index.js");
