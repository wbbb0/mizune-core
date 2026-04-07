import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function collectTests(directory, prefix = 'test') {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory()) {
        return collectTests(join(directory, entry.name), join(prefix, entry.name));
      }
      if (
        entry.isFile()
        && (
          entry.name.endsWith('.test.mjs')
          || entry.name.endsWith('.test.ts')
          || entry.name.endsWith('.test.tsx')
        )
      ) {
        return [join(prefix, entry.name)];
      }
      return [];
    });
}

function discoverTests() {
  return collectTests(fileURLToPath(new URL('.', import.meta.url)))
    .sort((left, right) => left.localeCompare(right));
}

const tests = process.argv.slice(2);
const testFiles = tests.length > 0 ? tests : discoverTests();

for (const testFile of testFiles) {
  console.log(`\n==> Running ${testFile}`);

  const result = spawnSync(process.execPath, ["--import", "tsx", testFile], {
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
}
