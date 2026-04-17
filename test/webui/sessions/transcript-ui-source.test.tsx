import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("virtual message list renders terminal status inside the scrolling list", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/VirtualMessageList.vue", import.meta.url), "utf8");

    assert.match(source, /#default="\{ item, index \}"/);
    assert.match(source, /v-if="index === items\.length - 1 && \(loadingMore \|\| !hasMore\)"/);
    assert.doesNotMatch(source, /<div\s+v-if="loadingMore \|\| \(!hasMore && items\.length > 0\)"/);
  });

  await runCase("message bubble uses explicit action button instead of context menu or long press", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/MessageBubble.vue", import.meta.url), "utf8");

    assert.match(source, /MoreHorizontal/);
    assert.match(source, /@click="openActions"/);
    assert.doesNotMatch(source, /@contextmenu=/);
    assert.doesNotMatch(source, /@touchstart/);
    assert.doesNotMatch(source, /longPressTimer/);
  });

  await runCase("transcript items use explicit action button and keep disclosures interactive when invalidated", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/TranscriptItem.vue", import.meta.url), "utf8");

    assert.match(source, /MoreHorizontal/);
    assert.match(source, /@click="openActions"/);
    assert.doesNotMatch(source, /@contextmenu=/);
    assert.doesNotMatch(source, /@touchstart/);
    assert.doesNotMatch(source, /function toggleExpanded\(\)\s*{\s*if \(invalidated\.value\) \{/);
    assert.doesNotMatch(source, /function toggleReasoningExpanded\(\)\s*{\s*if \(invalidated\.value\) \{/);
    assert.doesNotMatch(source, /function togglePlannerExpanded\(\)\s*{\s*if \(invalidated\.value\) \{/);
    assert.doesNotMatch(source, /TranscriptTextBlock v-if="invalidated && item\.reasoningContent"/);
    assert.doesNotMatch(source, /TranscriptCard v-if="invalidated" title="规划输出"/);
  });
}

void main();
