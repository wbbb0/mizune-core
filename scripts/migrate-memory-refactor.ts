import { resolve } from "node:path";
import { migrateMemoryDataDir } from "../src/memory/migration.ts";

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npx tsx scripts/migrate-memory-refactor.ts <data-dir>");
    process.exit(1);
  }

  const report = await migrateMemoryDataDir({
    dataDir: resolve(target),
    removeLegacyFiles: true
  });

  console.log(JSON.stringify({
    dataDir: report.dataDir,
    inventory: report.inventory,
    duplicateCount: report.duplicates.length,
    scopeFindingCount: report.scopeFindings.length,
    filesWritten: report.filesWritten,
    filesRemoved: report.filesRemoved
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
