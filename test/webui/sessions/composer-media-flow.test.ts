import test from "node:test";
import assert from "node:assert/strict";
import { prepareFilesForUpload } from "../../../webui/src/api/uploadPreparation.ts";
import { buildComposerSendPayload } from "../../../webui/src/components/sessions/composerPayload.ts";

  test("composer payload sends image attachments as both imageIds and attachmentIds", () => {
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

  test("composer payload keeps pure text messages free of attachments", () => {
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

  test("prepareFilesForUpload converts heic images to jpeg before upload", async () => {
    const original = new File(["heic-bytes"], "IMG_0001.HEIC", {
      type: "image/heic",
      lastModified: 1710000000000
    });

    const prepared = await prepareFilesForUpload([original], {
      convertHeifToJpeg: async (file) => new File(["jpeg-bytes"], "ignored.jpg", {
        type: "image/jpeg",
        lastModified: file.lastModified
      })
    });

    assert.equal(prepared.length, 1);
    assert.equal(prepared[0]?.name, "IMG_0001.jpg");
    assert.equal(prepared[0]?.type, "image/jpeg");
    assert.equal(prepared[0]?.lastModified, 1710000000000);
    assert.notEqual(prepared[0], original);
  });

  test("prepareFilesForUpload keeps non-heif files unchanged", async () => {
    const png = new File(["png-bytes"], "photo.png", {
      type: "image/png",
      lastModified: 1710000001000
    });

    const prepared = await prepareFilesForUpload([png], {
      convertHeifToJpeg: async () => {
        throw new Error("should not be called");
      }
    });

    assert.equal(prepared.length, 1);
    assert.equal(prepared[0], png);
  });

  test("prepareFilesForUpload detects heif by extension when mime type is missing", async () => {
    const original = new File(["heif-bytes"], "camera.heif", {
      type: "",
      lastModified: 1710000002000
    });

    const prepared = await prepareFilesForUpload([original], {
      convertHeifToJpeg: async (file) => new File(["jpeg-bytes"], "ignored.jpg", {
        type: "image/jpeg",
        lastModified: file.lastModified
      })
    });

    assert.equal(prepared[0]?.name, "camera.jpg");
    assert.equal(prepared[0]?.type, "image/jpeg");
  });
