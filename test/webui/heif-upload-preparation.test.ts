import assert from "node:assert/strict";
import { prepareFilesForUpload } from "../../webui/src/api/uploadPreparation.ts";

async function runCase(name: string, fn: () => Promise<void> | void) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("prepareFilesForUpload converts heic images to jpeg before upload", async () => {
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

  await runCase("prepareFilesForUpload keeps non-heif files unchanged", async () => {
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

  await runCase("prepareFilesForUpload detects heif by extension when mime type is missing", async () => {
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
}

void main();
