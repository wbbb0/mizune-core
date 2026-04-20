import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reporterPath = fileURLToPath(new URL("./reporters/failures-summary.mjs", import.meta.url));

function collectTests(directory, prefix = "test") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory()) {
        return collectTests(join(directory, entry.name), join(prefix, entry.name));
      }
      if (
        entry.isFile()
        && (
          entry.name.endsWith(".test.mjs")
          || entry.name.endsWith(".test.ts")
          || entry.name.endsWith(".test.tsx")
        )
      ) {
        return [join(prefix, entry.name)];
      }
      return [];
    });
}

function discoverTests() {
  return collectTests(fileURLToPath(new URL(".", import.meta.url)))
    .sort((left, right) => left.localeCompare(right));
}

function parseArgs(argv) {
  let concurrency = Number.parseInt(process.env.LLM_BOT_TEST_CONCURRENCY ?? "4", 10);
  const files = [];

  for (const arg of argv) {
    if (arg === "--serial") {
      concurrency = 1;
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      const value = Number.parseInt(arg.slice("--concurrency=".length), 10);
      if (Number.isFinite(value) && value > 0) {
        concurrency = value;
      }
      continue;
    }
    files.push(resolve(arg));
  }

  return {
    concurrency,
    files
  };
}

const { concurrency, files } = parseArgs(process.argv.slice(2));
const testFiles = files.length > 0
  ? files
  : discoverTests().map((path) => resolve(path));

const result = spawnSync(process.execPath, [
  "--test",
  "--import",
  "tsx",
  `--test-concurrency=${concurrency}`,
  `--test-reporter=${reporterPath}`,
  ...testFiles
], {
  stdio: "inherit"
});

if (result.error) {
  throw result.error;
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
