import test from "node:test";
import assert from "node:assert/strict";
import { prepareFilesForUpload } from "../../../webui/src/api/uploadPreparation.ts";
import { ApiError } from "../../../webui/src/api/client.ts";
import { formatUploadErrorMessage } from "../../../webui/src/components/sessions/composerErrors.ts";
import { buildComposerSendPayload } from "../../../webui/src/components/sessions/composerPayload.ts";
import {
  COMPOSER_IMAGE_ACCEPT,
  filterComposerImageFiles,
  isComposerImageFile
} from "../../../webui/src/components/sessions/composerAcceptedFiles.ts";
import {
  filesFromClipboardData,
  filesFromDataTransfer,
  filesFromFileList
} from "../../../webui/src/components/sessions/composerFileSources.ts";
import {
  fingerprintComposerFiles,
  selectUniqueComposerFiles
} from "../../../webui/src/components/sessions/composerFileFingerprints.ts";

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

  test("composer accepts only image files before upload", () => {
    const png = new File(["png"], "photo.png", { type: "image/png" });
    const heic = new File(["heic"], "camera.HEIC", { type: "" });
    const text = new File(["text"], "note.txt", { type: "text/plain" });
    const pdf = new File(["pdf"], "doc.pdf", { type: "application/pdf" });

    assert.equal(COMPOSER_IMAGE_ACCEPT, "image/*,.heic,.heif");
    assert.equal(isComposerImageFile(png), true);
    assert.equal(isComposerImageFile(heic), true);
    assert.equal(isComposerImageFile(text), false);
    assert.equal(isComposerImageFile(pdf), false);
    assert.deepEqual(filterComposerImageFiles([png, text, heic, pdf]), {
      accepted: [png, heic],
      rejected: [text, pdf]
    });
  });

  test("composer file source helpers preserve multiple selected files", () => {
    const first = new File(["a"], "a.png", { type: "image/png" });
    const second = new File(["b"], "b.jpg", { type: "image/jpeg" });
    const fileList = {
      0: first,
      1: second,
      length: 2
    };

    assert.deepEqual(filesFromFileList(fileList), [first, second]);
    assert.deepEqual(filesFromFileList(null), []);
  });

  test("composer file source helpers merge pasted and dropped file sources", () => {
    const first = new File(["a"], "a.png", { type: "image/png" });
    const second = new File(["b"], "b.png", { type: "image/png" });
    const fallback = new File(["fallback"], "fallback.png", {
      type: "image/png",
      lastModified: 1710000006000
    });
    const dataTransfer = {
      files: {
        0: fallback,
        length: 1
      },
      items: {
        0: { kind: "string", getAsFile: () => null },
        1: { kind: "file", getAsFile: () => first },
        2: { kind: "file", getAsFile: () => second },
        length: 3
      }
    };

    assert.deepEqual(filesFromDataTransfer(dataTransfer), [first, second, fallback]);
    assert.deepEqual(filesFromClipboardData(dataTransfer), [first, second, fallback]);
    assert.deepEqual(filesFromDataTransfer({
      files: {
        0: fallback,
        length: 1
      },
      items: { length: 0 }
    }), [fallback]);
  });

  test("composer file source helpers keep cross-source files for content fingerprint dedupe", () => {
    const itemFile = new File(["same"], "item-name.png", {
      type: "image/png",
      lastModified: 1710000003000
    });
    const listedDuplicate = new File(["same"], "listed-name.png", {
      type: "image/png",
      lastModified: 1710000003000
    });
    const next = new File(["next"], "next.png", {
      type: "image/png",
      lastModified: 1710000004000
    });

    assert.deepEqual(filesFromDataTransfer({
      files: {
        0: listedDuplicate,
        1: next,
        length: 2
      },
      items: {
        0: { kind: "file", getAsFile: () => itemFile },
        length: 1
      }
    }), [itemFile, listedDuplicate, next]);
  });

  test("composer file source helpers keep same-source files even when metadata matches", () => {
    const first = new File(["same"], "first.png", {
      type: "image/png",
      lastModified: 1710000005000
    });
    const second = new File(["same"], "second.png", {
      type: "image/png",
      lastModified: 1710000005000
    });

    assert.deepEqual(filesFromDataTransfer({
      files: {
        0: first,
        1: second,
        length: 2
      },
      items: { length: 0 }
    }), [first, second]);
  });

  test("composer file fingerprints dedupe repeated content within one upload batch", async () => {
    const first = new File(["same-content"], "first.png", { type: "image/png" });
    const duplicate = new File(["same-content"], "duplicate.png", { type: "image/png" });
    const next = new File(["next-content"], "next.png", { type: "image/png" });

    const selection = selectUniqueComposerFiles(await fingerprintComposerFiles([first, duplicate, next]), []);

    assert.equal(selection.duplicateCount, 1);
    assert.deepEqual(selection.unique.map((item) => item.file), [first, next]);
  });

  test("composer file fingerprints dedupe against already attached files", async () => {
    const attached = new File(["already-attached"], "attached.png", { type: "image/png" });
    const repeated = new File(["already-attached"], "again.png", { type: "image/png" });
    const next = new File(["fresh"], "fresh.png", { type: "image/png" });
    const [attachedFingerprint] = await fingerprintComposerFiles([attached]);

    assert.ok(attachedFingerprint);
    const selection = selectUniqueComposerFiles(
      await fingerprintComposerFiles([repeated, next]),
      [attachedFingerprint.fingerprint]
    );

    assert.equal(selection.duplicateCount, 1);
    assert.deepEqual(selection.unique.map((item) => item.file), [next]);
  });

  test("upload error message formatter keeps toast text useful for sparse errors", () => {
    assert.equal(formatUploadErrorMessage(new Error("")), "上传失败：未知错误");
    assert.equal(formatUploadErrorMessage(new ApiError(400, "")), "上传失败：HTTP 400");
    assert.equal(formatUploadErrorMessage({ error: "Workspace image validation failed" }), "上传失败：Workspace image validation failed");
    assert.equal(formatUploadErrorMessage({ message: "Payload Too Large", status: 413 }), "上传失败：Payload Too Large");
    assert.equal(formatUploadErrorMessage("network down"), "上传失败：network down");
    assert.equal(formatUploadErrorMessage(null), "上传失败：未知错误");
  });
