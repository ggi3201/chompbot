/**
 * Backfill embeddings for stored memories.
 *
 * Memory embeddings are generated fire-and-forget on save. If the embedding
 * model is unavailable at that moment the failure is logged and the row keeps a
 * NULL embedding forever — which silently downgrades recall_memories to a LIKE
 * substring query. This script repairs those rows.
 *
 * Usage:
 *   pnpm --filter @chomp/api exec tsx scripts/backfill-embeddings.ts
 *   pnpm --filter @chomp/api exec tsx scripts/backfill-embeddings.ts --force
 *   pnpm --filter @chomp/api exec tsx scripts/backfill-embeddings.ts --dry-run
 *
 * Runs against DB_PATH. Writing to the production DB requires
 * CHOMP_ALLOW_PROD_DB=1, matching the rest of the codebase.
 */
const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const dryRun = args.has("--dry-run");

const { isEmbeddingModelReady, EMBEDDING_MODEL } = await import("../src/db/embeddings.js");
const { backfillEmbeddings, countMemoriesMissingEmbeddings } = await import("../src/db/memories.js");

const { total, missing } = countMemoriesMissingEmbeddings();
console.log(`[backfill] ${total} memories, ${missing} missing an embedding`);
console.log(`[backfill] embedding model: ${EMBEDDING_MODEL}`);

if (!(await isEmbeddingModelReady())) {
  console.error(
    `[backfill] Model '${EMBEDDING_MODEL}' is not available in Ollama.\n` +
      `           Pull it first:  ollama pull ${EMBEDDING_MODEL}`,
  );
  process.exit(1);
}

if (dryRun) {
  console.log(
    `[backfill] --dry-run: would embed ${force ? total : missing} memor${(force ? total : missing) === 1 ? "y" : "ies"}. No writes performed.`,
  );
  process.exit(0);
}

if (!force && missing === 0) {
  console.log("[backfill] Nothing to do. Use --force to re-embed everything.");
  process.exit(0);
}

const started = Date.now();
const result = await backfillEmbeddings({
  force,
  onProgress: (done, count, content) => {
    const preview = content.replace(/\s+/g, " ").slice(0, 60);
    console.log(`[backfill] ${done}/${count}  ${preview}${content.length > 60 ? "…" : ""}`);
  },
});

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n[backfill] Done in ${seconds}s — ${result.embedded} embedded, ` +
    `${result.skipped} already current, ${result.failed} failed.`,
);

if (result.errors.length > 0) {
  console.error("[backfill] Failures:");
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
