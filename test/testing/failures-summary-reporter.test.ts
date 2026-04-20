import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error test reporter is loaded by Node as a plain ESM module.
import failuresSummaryReporter from "../reporters/failures-summary.mjs";

type ReporterEvent =
  | {
      type: "test:pass";
      data: {
        name: string;
        nesting: number;
        file?: string;
      };
    }
  | {
      type: "test:fail";
      data: {
        name: string;
        nesting: number;
        file?: string;
        details?: {
          error?: {
            message?: string;
            stack?: string;
          };
        };
      };
    }
  | {
      type: "test:summary";
      data: {
        counts: {
          total: number;
          passed: number;
          failed: number;
          skipped: number;
          todo: number;
          cancelled: number;
        };
        duration_ms: number;
      };
    };

async function renderReporterOutput(events: ReporterEvent[]) {
  const chunks: string[] = [];
  for await (const chunk of failuresSummaryReporter(toAsyncIterable(events))) {
    chunks.push(String(chunk));
  }
  return chunks.join("");
}

async function* toAsyncIterable(events: ReporterEvent[]) {
  for (const event of events) {
    yield event;
  }
}

test("failures summary reporter omits passing tests and prints failure details with summary", async () => {
  const output = await renderReporterOutput([
    {
      type: "test:pass",
      data: {
        name: "passing test",
        nesting: 0,
        file: "test/pass.test.ts"
      }
    },
    {
      type: "test:fail",
      data: {
        name: "failing test",
        nesting: 0,
        file: "test/fail.test.ts",
        details: {
          error: {
            message: "expected true to equal false",
            stack: "AssertionError: expected true to equal false\n    at test/fail.test.ts:4:1"
          }
        }
      }
    },
    {
      type: "test:summary",
      data: {
        counts: {
          total: 2,
          passed: 1,
          failed: 1,
          skipped: 0,
          todo: 0,
          cancelled: 0
        },
        duration_ms: 123.45
      }
    }
  ]);

  assert.doesNotMatch(output, /passing test/);
  assert.match(output, /FAIL test\/fail\.test\.ts > failing test/);
  assert.match(output, /expected true to equal false/);
  assert.match(output, /Total: 2/);
  assert.match(output, /Passed: 1/);
  assert.match(output, /Failed: 1/);
});
