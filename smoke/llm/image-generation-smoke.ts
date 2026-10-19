import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import pino from "pino";
import { loadConfig } from "../../src/config/config.ts";
import { imageGenerationToolHandlers } from "../../src/llm/tools/runtime/imageGenerationTools.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { LocalFileService } from "../../src/services/workspace/localFileService.ts";

const { values } = parseArgs({ options: {
  instance: { type: "string", default: "acc1" },
  "config-dir": { type: "string", default: "config" },
  "output-dir": { type: "string", default: ".superpowers/image-generation-smoke" }
} });
const config = loadConfig({ ...process.env, CONFIG_DIR: resolve(values["config-dir"]), CONFIG_INSTANCE: values.instance });
const temporary = await mkdtemp(join(tmpdir(), "llm-image-smoke-"));
try {
  config.dataDir = temporary;
  config.localFiles.root = temporary;
  config.chatFiles.root = "assets";
  const localFiles = new LocalFileService(config, temporary);
  const store = new ChatFileStore(config, pino({ level: "silent" }), localFiles);
  await store.init();
  const started = Date.now();
  const result = JSON.parse(String(await imageGenerationToolHandlers.generate_image!({
    id: "image-smoke", type: "function", function: { name: "generate_image", arguments: "{}" }
  }, { prompt: "一只橘色小猫坐在蓝色茶杯旁，白色背景，简洁插画，无文字。" }, {
    config, chatFileStore: store
  } as BuiltinToolContext))) as { ok: boolean; error?: string; model_ref: string; file_id: string; width: number; height: number };
  if (!result.ok) throw new Error(result.error ?? "生图失败");
  const file = await store.getFile(result.file_id);
  if (!file) throw new Error("图片未成功入库");
  const outputDir = resolve(values["output-dir"]);
  await mkdir(outputDir, { recursive: true });
  const output = join(outputDir, file.sourceName);
  await copyFile(localFiles.resolvePath(file.chatFilePath).absolutePath, output);
  console.log(JSON.stringify({ ok: true, modelRef: result.model_ref, elapsedMs: Date.now() - started, width: result.width, height: result.height, bytes: file.sizeBytes, origin: file.origin, output }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
