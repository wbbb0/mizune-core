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

  test("message bubble supports only the explicit action button without long press", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/MessageBubble.vue", import.meta.url), "utf8");
    const metaSource = await readFile(new URL("../../../webui/src/components/sessions/MessageMetaLine.vue", import.meta.url), "utf8");

    assert.match(source, /MessageMetaLine/);
    assert.match(metaSource, /MoreHorizontal/);
    assert.match(metaSource, /@click="openActions"/);
    assert.doesNotMatch(source, /@contextmenu/);
    assert.doesNotMatch(metaSource, /@contextmenu=/);
    assert.doesNotMatch(source, /@touchstart/);
    assert.doesNotMatch(metaSource, /@touchstart/);
    assert.doesNotMatch(source, /longPressTimer/);
    assert.doesNotMatch(metaSource, /longPressTimer/);
  });

  test("message bubble renders ordered content parts with previews and asset links", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/MessageBubble.vue", import.meta.url), "utf8");

    assert.match(source, /kind === 'content_parts'/);
    assert.match(source, /part\.kind === 'image' \|\| part\.kind === 'emoji'/);
    assert.match(source, /emit\('previewImage', part\.imageUrl/);
    assert.match(source, /border-0 bg-transparent p-0/);
    assert.match(source, /part\.kind === 'file' && !part\.contentUrl/);
    assert.match(source, /:href="part\.contentUrl \?\? undefined"/);
    assert.match(source, /getFileIcon\(part\)/);
    assert.match(source, /getFileTypeLabel\(part\)/);
  });

  test("message bubble renders streaming drafts without visual effects", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/MessageBubble.vue", import.meta.url), "utf8");
    const styleSource = await readFile(new URL("../../../webui/src/style/main.css", import.meta.url), "utf8");

    assert.doesNotMatch(source, /blink-cursor/);
    assert.doesNotMatch(source, /streaming \? 'opacity-90'/);
    assert.doesNotMatch(styleSource, /\.blink-cursor/);
    assert.doesNotMatch(styleSource, /@keyframes blink/);
  });

  test("transcript items support only the explicit action button while keeping disclosures interactive when runtimeExcluded", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/TranscriptItem.vue", import.meta.url), "utf8");

    assert.match(source, /MoreHorizontal/);
    assert.match(source, /@click="openActions"/);
    assert.doesNotMatch(source, /@contextmenu/);
    assert.match(source, /title_generation_event/);
    assert.match(source, /item\.summary/);
    assert.match(source, /source === 'auto' \? '自动生成' : '重新生成'/);
    assert.doesNotMatch(source, /@touchstart/);
    assert.doesNotMatch(source, /function toggleExpanded\(\)\s*{\s*if \(runtimeExcluded\.value\) \{/);
    assert.doesNotMatch(source, /function toggleReasoningExpanded\(\)\s*{\s*if \(runtimeExcluded\.value\) \{/);
    assert.doesNotMatch(source, /function togglePlannerExpanded\(\)\s*{\s*if \(runtimeExcluded\.value\) \{/);
    assert.doesNotMatch(source, /TranscriptTextBlock v-if="runtimeExcluded && item\.reasoningContent"/);
    assert.doesNotMatch(source, /WorkbenchCard v-if="runtimeExcluded" title="规划输出"/);
  });

  test("transcript item renders user media content parts without hiding unresolved media", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/TranscriptItem.vue", import.meta.url), "utf8");

    assert.match(source, /item\.kind === 'user_message' \|\| item\.kind === 'user_media_message'/);
    assert.match(source, /contentPartImages\.length > 0/);
    assert.match(source, /contentPartEmojis\.length > 0/);
    assert.match(source, /contentPartFiles\.length > 0/);
    assert.match(source, /collapsed-title="展开图片元数据"/);
    assert.match(source, /collapsed-title="展开表情元数据"/);
    assert.match(source, /collapsed-title="展开文件元数据"/);
    assert.doesNotMatch(source, /<img :src="getChatFileContentUrl/);
    assert.match(source, /text="语音消息"/);
  });
