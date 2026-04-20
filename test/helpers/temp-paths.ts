import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanupPaths = new Set<string>();
let cleanupRegistered = false;

function registerCleanup() {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;

  process.once("exit", () => {
    for (const target of cleanupPaths) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup for test-only temp paths.
      }
    }
  });
}

export function createTempDir(prefix: string) {
  registerCleanup();
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  cleanupPaths.add(directory);
  return directory;
}
