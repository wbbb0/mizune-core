import assert from "node:assert/strict";
import { buildComposerSendPayload } from "../../webui/src/components/sessions/composerPayload.ts";

async function runCase(name: string, fn: () => Promise<void> | void) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("composer payload sends image attachments as both imageIds and attachmentIds", () => {
    const payload = buildComposerSendPayload({
      userId: "10001",
      text: "看看这张图",
      attachments: [{
        fileId: "img-1",
        fileRef: "upload_image1.png",
        kind: "image",
        sourceName: "upload_image1.png",
        chatFilePath: "workspace/media/upload_image1.png",
        mimeType: "image/png",
        sizeBytes: 128
      }, {
        fileId: "file-1",
        fileRef: "note.txt",
        kind: "file",
        sourceName: "note.txt",
        chatFilePath: "workspace/media/note.txt",
        mimeType: "text/plain",
        sizeBytes: 32
      }, {
        fileId: "gif-1",
        fileRef: "anim.gif",
        kind: "animated_image",
        sourceName: "anim.gif",
        chatFilePath: "workspace/media/anim.gif",
        mimeType: "image/gif",
        sizeBytes: 64
      }]
    });

    assert.deepEqual(payload, {
      userId: "10001",
      text: "看看这张图",
      imageIds: ["img-1", "gif-1"],
      attachmentIds: ["img-1", "file-1", "gif-1"]
    });
  });

  await runCase("composer payload keeps pure text messages free of attachments", () => {
    const payload = buildComposerSendPayload({
      userId: "10002",
      text: "纯文本"
    });

    assert.deepEqual(payload, {
      userId: "10002",
      text: "纯文本",
      imageIds: [],
      attachmentIds: []
    });
  });
}

void main();
