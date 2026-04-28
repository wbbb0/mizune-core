import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

  test("virtual message list renders terminal status inside the scrolling list", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/VirtualMessageList.vue", import.meta.url), "utf8");

    assert.match(source, /#default="\{ item, index \}"/);
    assert.match(source, /v-if="index === items\.length - 1 && \(loadingMore \|\| !hasMore\)"/);
    assert.doesNotMatch(source, /<div\s+v-if="loadingMore \|\| \(!hasMore && items\.length > 0\)"/);
    assert.match(source, /scrollToIndex\(0, \{ align: "start" \}\)/);
    assert.match(source, /props\.items\[0\]\?\.id/);
    assert.match(source, /distFromBottom/);
    assert.match(source, /scrollToTop/);
    assert.doesNotMatch(source, /scrollToBottom/);
    assert.doesNotMatch(source, /TOP_LOAD_THRESHOLD_PX/);
  });

  test("message bubble uses explicit action button instead of context menu or long press", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/MessageBubble.vue", import.meta.url), "utf8");
    const metaSource = await readFile(new URL("../../../webui/src/components/sessions/MessageMetaLine.vue", import.meta.url), "utf8");

    assert.match(source, /MessageMetaLine/);
    assert.match(metaSource, /MoreHorizontal/);
    assert.match(metaSource, /@click="openActions"/);
    assert.doesNotMatch(source, /@contextmenu=/);
    assert.doesNotMatch(metaSource, /@contextmenu=/);
    assert.doesNotMatch(source, /@touchstart/);
    assert.doesNotMatch(metaSource, /@touchstart/);
    assert.doesNotMatch(source, /longPressTimer/);
    assert.doesNotMatch(metaSource, /longPressTimer/);
  });

  test("transcript items use explicit action button and keep disclosures interactive when runtimeExcluded", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/TranscriptItem.vue", import.meta.url), "utf8");

    assert.match(source, /MoreHorizontal/);
    assert.match(source, /@click="openActions"/);
    assert.match(source, /title_generation_event/);
    assert.match(source, /item\.summary/);
    assert.match(source, /source === 'auto' \? '自动生成' : '重新生成'/);
    assert.doesNotMatch(source, /@contextmenu=/);
    assert.doesNotMatch(source, /@touchstart/);
    assert.doesNotMatch(source, /function toggleExpanded\(\)\s*{\s*if \(runtimeExcluded\.value\) \{/);
    assert.doesNotMatch(source, /function toggleReasoningExpanded\(\)\s*{\s*if \(runtimeExcluded\.value\) \{/);
    assert.doesNotMatch(source, /function togglePlannerExpanded\(\)\s*{\s*if \(runtimeExcluded\.value\) \{/);
    assert.doesNotMatch(source, /TranscriptTextBlock v-if="runtimeExcluded && item\.reasoningContent"/);
    assert.doesNotMatch(source, /WorkbenchCard v-if="runtimeExcluded" title="规划输出"/);
  });
