import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import sharp from "sharp";
import { getBuiltinTools } from "../../src/llm/tools/index.ts";
import { imageTransformToolHandlers } from "../../src/llm/tools/runtime/imageTransformTools.ts";
import { selfAccountToolDescriptors, selfAccountToolHandlers } from "../../src/llm/tools/runtime/accountTools.ts";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { LocalFileService } from "../../src/services/workspace/localFileService.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createFunctionToolCall, parseJsonToolResult } from "../helpers/tool-test-support.tsx";

test("asset_image_transform crops, rotates, resizes, converts format, and stores a new asset", async () => {
  const harness = await createImageToolHarness();
  try {
    const source = await harness.chatFileStore.importBuffer({
      buffer: await createSolidPng(4, 3),
      sourceName: "source.png",
      mimeType: "image/png",
      kind: "image",
      origin: "user_upload"
    });

    const result = parseJsonToolResult<{
      ok: boolean;
      asset_ref: string;
      file_id: string;
      output: { width: number; height: number; format: string; mime_type: string };
      file: { origin: string };
    }>(await imageTransformToolHandlers.asset_image_transform!(
      createFunctionToolCall("asset_image_transform"),
      {
        asset_ref: source.fileRef,
        crop: { left: 1, top: 0, width: 2, height: 3 },
        rotate_degrees: 90,
        resize: { width: 10, height: 6, mode: "stretch" },
        format: "webp",
        quality: 80
      },
      harness.context
    ));

    assert.equal(result.ok, true);
    assert.equal(result.output.width, 10);
    assert.equal(result.output.height, 6);
    assert.equal(result.output.format, "webp");
    assert.equal(result.output.mime_type, "image/webp");
    assert.equal(result.file.origin, "image_transform");

    const stored = await harness.chatFileStore.getFile(result.file_id);
    assert.ok(stored);
    assert.equal(stored.origin, "image_transform");
    assert.equal(stored.mimeType, "image/webp");
    const metadata = await sharp(await readFile(await harness.chatFileStore.resolveAbsolutePath(stored.fileId))).metadata();
    assert.equal(metadata.width, 10);
    assert.equal(metadata.height, 6);
  } finally {
    await harness.cleanup();
  }
});

test("asset_image_transform accepts a local path and keeps cropped resolution by default", async () => {
  const harness = await createImageToolHarness();
  try {
    await writeFile(join(harness.localFileService.rootDir, "input.png"), await createSolidPng(5, 4));

    const result = parseJsonToolResult<{
      ok: boolean;
      asset_ref: string;
      file_id: string;
      output: { width: number; height: number; format: string };
    }>(await imageTransformToolHandlers.asset_image_transform!(
      createFunctionToolCall("asset_image_transform"),
      {
        path: "input.png",
        crop: { left: 1, top: 1, width: 3, height: 2 }
      },
      harness.context
    ));

    assert.equal(result.ok, true);
    assert.equal(result.output.width, 3);
    assert.equal(result.output.height, 2);
    assert.equal(result.output.format, "png");
    const stored = await harness.chatFileStore.getFile(result.file_id);
    assert.ok(stored);
    assert.equal(stored.sourceContext.source_type, "path");
    assert.equal(stored.sourceContext.source_ref, "input.png");
  } finally {
    await harness.cleanup();
  }
});

test("asset_image_transform preserves local jpeg format by default", async () => {
  const harness = await createImageToolHarness();
  try {
    await writeFile(join(harness.localFileService.rootDir, "input.jpg"), await sharp(await createSolidPng(5, 4)).jpeg().toBuffer());

    const result = parseJsonToolResult<{
      ok: boolean;
      file_id: string;
      output: { format: string; mime_type: string };
    }>(await imageTransformToolHandlers.asset_image_transform!(
      createFunctionToolCall("asset_image_transform"),
      {
        path: "input.jpg",
        resize: { width: 3 }
      },
      harness.context
    ));

    assert.equal(result.ok, true);
    assert.equal(result.output.format, "jpeg");
    assert.equal(result.output.mime_type, "image/jpeg");
    const stored = await harness.chatFileStore.getFile(result.file_id);
    assert.equal(stored?.mimeType, "image/jpeg");
  } finally {
    await harness.cleanup();
  }
});

test("asset_image_transform rejects oversized output before rendering", async () => {
  const harness = await createImageToolHarness();
  try {
    const source = await harness.chatFileStore.importBuffer({
      buffer: await createSolidPng(2, 2),
      sourceName: "source.png",
      mimeType: "image/png",
      kind: "image",
      origin: "user_upload"
    });

    const result = parseJsonToolResult<{ ok: boolean; error: string }>(await imageTransformToolHandlers.asset_image_transform!(
      createFunctionToolCall("asset_image_transform"),
      {
        asset_ref: source.fileRef,
        resize: { width: 9000, height: 9000, mode: "stretch" }
      },
      harness.context
    ));

    assert.equal(result.ok, false);
    assert.match(result.error, /resize\.width must be <= 8192|too large/u);
  } finally {
    await harness.cleanup();
  }
});

test("self account avatar tool only exposes asset selectors and sends the resolved asset path", async () => {
  const avatarDescriptor = selfAccountToolDescriptors.find((item) => item.definition.function.name === "self_account_avatar_set");
  assert.ok(avatarDescriptor);
  const properties = avatarDescriptor.definition.function.parameters?.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties).sort(), ["asset_id", "asset_ref"]);
  assert.deepEqual(avatarDescriptor.definition.function.parameters?.anyOf, [
    { required: ["asset_ref"] },
    { required: ["asset_id"] }
  ]);

  const harness = await createImageToolHarness();
  const avatarCalls: string[] = [];
  try {
    const source = await harness.chatFileStore.importBuffer({
      buffer: await createSolidPng(2, 2),
      sourceName: "avatar.png",
      mimeType: "image/png",
      kind: "image",
      origin: "user_upload"
    });
    const expectedPath = await harness.chatFileStore.resolveAbsolutePath(source.fileId);
    const context = {
      ...harness.context,
      oneBotClient: {
        async setQQAvatar(path: string) {
          avatarCalls.push(path);
          return { status: "ok", retcode: 0, data: null };
        }
      }
    };

    const result = parseJsonToolResult<{ ok: boolean; asset_ref: string }>(
      await selfAccountToolHandlers.self_account_avatar_set!(
        createFunctionToolCall("self_account_avatar_set"),
        { asset_ref: source.fileRef },
        context
      )
    );

    assert.equal(result.ok, true);
    assert.equal(result.asset_ref, source.fileRef);
    assert.deepEqual(avatarCalls, [expectedPath]);

    const rejected = parseJsonToolResult<{ ok: boolean; error: string }>(
      await selfAccountToolHandlers.self_account_avatar_set!(
        createFunctionToolCall("self_account_avatar_set"),
        { asset_ref: source.fileRef, asset_id: source.fileId },
        context
      )
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /mutually exclusive/u);
  } finally {
    await harness.cleanup();
  }
});

test("NapCat owner tools expose account management while hiding it from known users", async () => {
  const config = createTestAppConfig({
    onebot: {
      provider: "napcat"
    },
    chatFiles: {
      enabled: true
    }
  });
  const ownerNames = getBuiltinTools("owner", config).map((tool) => tool.function.name);
  assert.ok(ownerNames.includes("self_account_view"));
  assert.ok(ownerNames.includes("self_account_avatar_set"));
  assert.ok(ownerNames.includes("self_account_signature_set"));
  assert.ok(ownerNames.includes("asset_image_transform"));

  const knownNames = getBuiltinTools("known", config).map((tool) => tool.function.name);
  assert.ok(!knownNames.includes("self_account_view"));
  assert.ok(!knownNames.includes("self_account_avatar_set"));
  assert.ok(!knownNames.includes("self_account_signature_set"));
  assert.ok(knownNames.includes("asset_image_transform"));

  const noLocalFilesConfig = createTestAppConfig({
    localFiles: {
      enabled: false
    },
    chatFiles: {
      enabled: true
    }
  });
  const noLocalNames = getBuiltinTools("known", noLocalFilesConfig).map((tool) => tool.function.name);
  assert.ok(noLocalNames.includes("asset_image_transform"));
});

async function createImageToolHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-onebot-image-transform-"));
  const config = createTestAppConfig({
    localFiles: {
      enabled: true,
      root: "data"
    },
    chatFiles: {
      enabled: true,
      root: "chat-files",
      maxUploadBytes: 1024 * 1024
    }
  });
  const logger = pino({ level: "silent" });
  const localFileService = new LocalFileService(config, dataDir);
  await localFileService.init();
  const chatFileStore = new ChatFileStore(config, logger, localFileService, dataDir);
  await chatFileStore.init();
  const context = {
    config,
    relationship: "owner",
    chatFileStore,
    localFileService,
    debugSnapshot: {
      visibleToolNames: [
        "asset_media_view",
        "asset_media_inspect",
        "asset_send_to_chat",
        "asset_local_path",
        "asset_export_to_filesystem"
      ]
    },
    oneBotClient: {}
  } as any;

  return {
    chatFileStore,
    localFileService,
    context,
    async cleanup() {
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

async function createSolidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 }
    }
  }).png().toBuffer();
}
