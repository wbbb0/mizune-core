import { stat } from "node:fs/promises";
import type { DecisionContentPart, DecisionInput } from "#llm/provider/nativeCapabilityTypes.ts";
import type { BuiltinToolContext } from "./shared.ts";
import { getStringArg } from "./toolArgHelpers.ts";
import { parseReferenceImageSelectors, resolveStaticImageAsset } from "./imageAssetReferences.ts";

/** Model-provided evidence is data. Only registered image assets are dereferenced. */
export async function buildDecisionToolInput(args: unknown, context: BuiltinToolContext): Promise<DecisionInput> {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const input = getStringArg(args, "input");
  if (!input.trim()) throw new Error("决策文本证据不能为空");
  const selectors = parseReferenceImageSelectors(record.reference_images);
  const data = record.data;
  if (data === undefined && selectors.length === 0) return input;
  const content: DecisionContentPart[] = [{ type: "input_text", text: input }];
  if (data !== undefined) {
    if (!isRecord(data) && (!Array.isArray(data) || data.some(item => !isRecord(item)))) {
      throw new Error("决策 data 必须是 JSON 对象或对象数组");
    }
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > 256 * 1024) throw new Error("决策 JSON 证据超过 256 KiB 限制");
    content.push({ type: "input_json", data });
  }
  if (selectors.length > 0 && !context.config.chatFiles.enabled) throw new Error("图片资产功能未启用");
  let inputBytes = 0;
  let preparedBytes = 0;
  for (const selector of selectors) {
    context.abortSignal?.throwIfAborted();
    const file = await resolveStaticImageAsset(context, selector);
    const info = await stat(await context.chatFileStore.resolveAbsolutePath(file.fileId));
    inputBytes += info.size;
    if (!info.isFile() || inputBytes > context.config.chatFiles.maxUploadBytes) throw new Error("决策参考图总大小超过资产大小限制");
    // Reuse the existing media preparation service, including its content access guard.
    const prepared = await context.mediaVisionService.prepareFileForModel(file.fileId);
    context.abortSignal?.throwIfAborted();
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(prepared.inputUrl)) {
      throw new Error("图片准备服务没有返回有效的内联图片");
    }
    preparedBytes += Buffer.byteLength(prepared.inputUrl.slice(prepared.inputUrl.indexOf(",") + 1), "base64");
    if (preparedBytes > context.config.chatFiles.maxUploadBytes) throw new Error("决策参考图编码后总大小超过资产大小限制");
    content.push({ type: "input_image", image_url: prepared.inputUrl });
  }
  return [{ role: "user", content }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
