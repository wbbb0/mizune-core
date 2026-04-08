import assert from "node:assert/strict";
import { formatLogTimestamp } from "../../src/logger.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("formatLogTimestamp formats epoch using configured timezone", async () => {
    assert.equal(formatLogTimestamp(0, "Asia/Shanghai"), "[1970-01-01 08:00:00.000]");
  });

  await runCase("formatLogTimestamp keeps millisecond precision across timezones", async () => {
    const timestamp = Date.UTC(2026, 2, 18, 0, 5, 6, 789);

    assert.equal(formatLogTimestamp(timestamp, "UTC"), "[2026-03-18 00:05:06.789]");
    assert.equal(formatLogTimestamp(timestamp, "Asia/Shanghai"), "[2026-03-18 08:05:06.789]");
  });

  await runCase("formatLogTimestamp falls back to raw value for invalid dates", async () => {
    assert.equal(formatLogTimestamp("not-a-time", "Asia/Shanghai"), "[not-a-time]");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});