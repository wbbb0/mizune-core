function formatFailureLocation(data) {
  if (data.file) {
    return `${data.file} > ${data.name}`;
  }
  return data.name;
}

function formatSummary(summary) {
  const counts = summary?.counts ?? {};
  const total = counts.total ?? counts.tests ?? 0;
  const passed = counts.passed ?? 0;
  const skipped = counts.skipped ?? 0;
  const todo = counts.todo ?? 0;
  const cancelled = counts.cancelled ?? 0;
  const failed = counts.failed ?? (summary?.success === false
    ? Math.max(total - passed - skipped - todo - cancelled, 1)
    : 0);
  const durationMs = typeof summary?.duration_ms === "number"
    ? summary.duration_ms.toFixed(2)
    : "0.00";

  return [
    "",
    "Summary",
    `Total: ${total}`,
    `Passed: ${passed}`,
    `Failed: ${failed}`,
    `Skipped: ${skipped}`,
    `Todo: ${todo}`,
    `Cancelled: ${cancelled}`,
    `Duration: ${durationMs}ms`,
    ""
  ].join("\n");
}

export default async function* failuresSummaryReporter(source) {
  const emittedFailures = new Set();
  let summary = null;

  for await (const event of source) {
    if (event.type === "test:fail") {
      const data = event.data ?? {};
      const key = JSON.stringify({
        file: data.file ?? null,
        name: data.name ?? "<anonymous>",
        message: data.details?.error?.message ?? ""
      });

      if (emittedFailures.has(key)) {
        continue;
      }
      emittedFailures.add(key);

      const lines = [`FAIL ${formatFailureLocation(data)}`];
      const message = data.details?.error?.message;
      const stack = data.details?.error?.stack;
      if (message) {
        lines.push(message);
      }
      if (stack) {
        lines.push(stack);
      }
      yield `${lines.join("\n")}\n\n`;
      continue;
    }

    if (event.type === "test:summary") {
      summary = event.data;
    }
  }

  if (summary) {
    yield formatSummary(summary);
  }
}
