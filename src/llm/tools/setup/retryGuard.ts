import type { LlmToolExecutionResult } from "../../llmClient.ts";
import { projectRawToolContent } from "../core/toolResultProjection.ts";

type Result = string | LlmToolExecutionResult;
// 生命周期绑定一轮生成的 context；不跨会话、跨轮保存失败记录。
const failures = new WeakMap<object, { fingerprint: string; result: Record<string, unknown> }>();
export async function executeSetupAttempt(context: object, name: string, args: unknown, execute: () => Promise<Result>): Promise<Result> {
  const fingerprint = JSON.stringify([name, args]);
  const previous = failures.get(context);
  if (previous?.fingerprint === fingerprint) {
    return projectRawToolContent(name, JSON.stringify({ ...previous.result, repeated: true,
      nextStep: "此参数已失败，本次未重复执行。请按 issues 或 expectedSchema 改正参数；不确定时先读取当前分块或场景状态，再重新调用。" }));
  }
  const result = await execute();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(typeof result === "string" ? result : result.content); } catch { /* 非 JSON 结果不参与重试限制。 */ }
  if (parsed?.error && ["setup_input_invalid", "setup_edit_rejected"].includes(String(parsed.code))) failures.set(context, { fingerprint, result: parsed });
  else failures.delete(context);
  return result;
}
