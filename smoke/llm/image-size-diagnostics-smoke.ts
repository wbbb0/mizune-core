import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import pino from "pino";
import { loadConfig } from "#config/config.ts";
import { generateConfiguredImage } from "../../src/services/images/imageGeneration.ts";
import { ImageGenerationError } from "../../src/services/images/imageGenerationError.ts";
import { getRequestDiagnostic } from "#llm/provider/requestDiagnostics.ts";

// 一次真实编辑调用；仅本脚本生成的参考图，不读取任何正式资产。
const config = loadConfig({ ...process.env, CONFIG_INSTANCE: process.env.CONFIG_INSTANCE ?? "acc2" });
const temporary = await mkdtemp(join(tmpdir(), "image-size-smoke-"));
config.dataDir = temporary;
const started = Date.now();
try {
  const reference = await sharp({create:{width:64,height:64,channels:3,background:"white"}}).png().toBuffer();
  const image = await generateConfiguredImage(config, {
    prompt: "请把参考图编辑成白色背景、中央一个简单蓝色圆形的极简几何图案，不要文字。",
    size: "2880x2880", referenceImages: [{buffer:reference}], skipDebugDump:true,
    abortSignal: AbortSignal.timeout(300000), logger:pino({level:"silent"})
  });
  console.log(JSON.stringify({case:"synthetic-2880-edit",passed:true,elapsedMs:Date.now()-started,modelRef:image.modelRef,width:image.width,height:image.height,bytes:image.buffer.length}));
} catch(error) {
  console.log(JSON.stringify({case:"synthetic-2880-edit",passed:false,elapsedMs:Date.now()-started,errorName:error instanceof Error?error.name:"unknown",diagnostic:getRequestDiagnostic(error),...(error instanceof ImageGenerationError?{stage:error.details.stage,kind:error.details.kind,httpStatus:error.details.httpStatus}: {})}));
} finally {await rm(temporary,{recursive:true,force:true});}
