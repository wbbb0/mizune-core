import test from "node:test";
import assert from "node:assert/strict";
import { formatLogTimestamp } from "../../src/logger.ts";

  test("formatLogTimestamp formats epoch using configured timezone", async () => {
    assert.equal(formatLogTimestamp(0, "Asia/Shanghai"), "[1970-01-01 08:00:00.000]");
  });

  test("formatLogTimestamp keeps millisecond precision across timezones", async () => {
    const timestamp = Date.UTC(2026, 2, 18, 0, 5, 6, 789);

    assert.equal(formatLogTimestamp(timestamp, "UTC"), "[2026-03-18 00:05:06.789]");
    assert.equal(formatLogTimestamp(timestamp, "Asia/Shanghai"), "[2026-03-18 08:05:06.789]");
  });

  test("formatLogTimestamp falls back to raw value for invalid dates", async () => {
    assert.equal(formatLogTimestamp("not-a-time", "Asia/Shanghai"), "[not-a-time]");
  });
