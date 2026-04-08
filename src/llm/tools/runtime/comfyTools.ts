import { randomUUID } from "node:crypto";
import type { AppConfig } from "#config/config.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { setJsonPointerValue } from "#comfy/workflowPatch.ts";

function buildComfyToolDescriptor(config: AppConfig): ToolDescriptor {
  const templateEnum = config.comfy.templates
    .filter((item) => item.enabled)
    .map((item) => item.id);
  const aspectRatioEnum = Object.keys(config.comfy.aspectRatios);

  return {
    definition: {
      type: "function",
      function: {
        name: "generate_image_with_comfyui",
        description: "用已配置的 ComfyUI 模板异步发起图片生成任务。调用后不会立即得到图片，系统会在完成后把 workspace 资源信息再次交回给你。",
        parameters: {
          type: "object",
          properties: {
            template: {
              type: "string",
              enum: templateEnum
            },
            positive_prompt: {
              type: "string"
            },
            aspect_ratio: {
              type: "string",
              enum: aspectRatioEnum
            }
          },
          required: ["template", "positive_prompt", "aspect_ratio"],
          additionalProperties: false
        }
      }
    },
    isEnabled: (currentConfig) => currentConfig.comfy.enabled
  };
}

export function getComfyToolDescriptors(config: AppConfig): ToolDescriptor[] {
  return config.comfy.enabled ? [buildComfyToolDescriptor(config)] : [];
}

export const comfyToolHandlers: Record<string, ToolHandler> = {
  async generate_image_with_comfyui(_toolCall, args, context) {
    const templateId = typeof args === "object" && args && "template" in args
      ? String((args as { template?: unknown }).template ?? "").trim()
      : "";
    const positivePrompt = typeof args === "object" && args && "positive_prompt" in args
      ? String((args as { positive_prompt?: unknown }).positive_prompt ?? "").trim()
      : "";
    const aspectRatio = typeof args === "object" && args && "aspect_ratio" in args
      ? String((args as { aspect_ratio?: unknown }).aspect_ratio ?? "").trim()
      : "";

    if (!templateId || !positivePrompt || !aspectRatio) {
      return JSON.stringify({ error: "template, positive_prompt and aspect_ratio are required" });
    }

    const ratio = context.config.comfy.aspectRatios[aspectRatio];
    if (!ratio) {
      return JSON.stringify({ error: `Unknown aspect_ratio: ${aspectRatio}` });
    }

    const activeTasks = await context.comfyTaskStore.listActive();
    if (activeTasks.length >= context.config.comfy.maxConcurrentTasks) {
      return JSON.stringify({
        error: `Too many active Comfy tasks (${activeTasks.length}/${context.config.comfy.maxConcurrentTasks})`
      });
    }

    const currentAutoIteration = context.activeInternalTrigger?.kind === "comfy_task_completed" || context.activeInternalTrigger?.kind === "comfy_task_failed"
      ? context.activeInternalTrigger.autoIterationIndex
      : null;
    const maxAutoIterations = context.activeInternalTrigger?.kind === "comfy_task_completed" || context.activeInternalTrigger?.kind === "comfy_task_failed"
      ? context.activeInternalTrigger.maxAutoIterations
      : null;
    if (currentAutoIteration != null && maxAutoIterations != null && currentAutoIteration >= maxAutoIterations) {
      return JSON.stringify({
        error: `Comfy auto-iteration limit reached (${currentAutoIteration}/${maxAutoIterations})`
      });
    }

    const template = context.comfyTemplateCatalog.getTemplate(templateId);
    if (!template) {
      return JSON.stringify({ error: `Unknown or unavailable Comfy template: ${templateId}` });
    }

    const workflow = structuredClone(template.workflow) as Record<string, unknown>;
    setJsonPointerValue(workflow, template.parameterBindings.positivePromptPath, positivePrompt);
    setJsonPointerValue(workflow, template.parameterBindings.widthPath, ratio.width);
    setJsonPointerValue(workflow, template.parameterBindings.heightPath, ratio.height);

    const submitted = await context.comfyClient.submitPrompt({
      workflow,
      clientId: `llm-bot-${randomUUID()}`
    });
    if (Object.keys(submitted.nodeErrors).length > 0) {
      return JSON.stringify({
        error: "Comfy submit returned node_errors",
        nodeErrors: submitted.nodeErrors
      });
    }

    const created = await context.comfyTaskStore.create({
      sessionId: context.lastMessage.sessionId,
      userId: context.lastMessage.userId,
      templateId: template.id,
      workflowFile: template.workflowFile,
      workflowSnapshot: workflow,
      positivePrompt,
      aspectRatio,
      resolvedWidth: ratio.width,
      resolvedHeight: ratio.height,
      comfyPromptId: submitted.promptId,
      status: "queued",
      resultFileIds: [],
      resultFiles: [],
      autoIterationIndex: currentAutoIteration == null ? 0 : currentAutoIteration + 1,
      maxAutoIterations: maxAutoIterations ?? template.resultPolicy.maxAutoIterations,
      lastError: null,
      startedAtMs: null,
      finishedAtMs: null
    });

    return JSON.stringify({
      ok: true,
      taskId: created.id,
      promptId: created.comfyPromptId,
      template: created.templateId,
      aspectRatio: created.aspectRatio,
      message: "已调起 ComfyUI 任务，结果稍后会异步回到当前会话"
    });
  }
};
