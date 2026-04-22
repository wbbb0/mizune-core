import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

  test("chat panel uses backstage tab without transcript badge or inline delete button", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/ChatPanel.vue", import.meta.url), "utf8");

    assert.match(source, />后台</);
    assert.doesNotMatch(source, /后台记录/);
    assert.doesNotMatch(source, /session\?\.transcriptCount/);
    assert.doesNotMatch(source, /Trash2/);
    assert.match(source, /const reversedMessages = computed/);
    assert.match(source, /const reversedTranscript = computed/);
    assert.match(source, /streaming=|draftAssistantText|draftTurnId/);
  });
