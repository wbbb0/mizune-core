import type { InternalSessionTriggerExecution } from "#conversation/session/sessionTypes.ts";
import type { ShellRunOwner, ShellRuntimeEvent } from "#services/shell/types.ts";
import type { DownloadRuntimeEvent } from "#services/workspace/downloadRuntime.ts";
import { createInternalTriggerDispatcher } from "./internalTriggerDispatcher.ts";
import type { ScheduledTaskDispatcherDeps } from "./scheduledTaskDispatcherDeps.ts";

export type ComfyRuntimeEvent =
  | {
      kind: "comfy_task_completed";
      owner: ShellRunOwner;
      taskId: string;
      templateId: string;
      positivePrompt: string;
      aspectRatio: string;
      resolvedWidth: number;
      resolvedHeight: number;
      workspaceFileIds: string[];
      chatFilePaths: string[];
      comfyPromptId: string;
      autoIterationIndex: number;
      maxAutoIterations: number;
    }
  | {
      kind: "comfy_task_failed";
      owner: ShellRunOwner;
      taskId: string;
      templateId: string;
      positivePrompt: string;
      aspectRatio: string;
      resolvedWidth: number;
      resolvedHeight: number;
      comfyPromptId: string;
      lastError: string;
      autoIterationIndex: number;
      maxAutoIterations: number;
    };

export function createScheduledTaskDispatcher(
  deps: ScheduledTaskDispatcherDeps,
  handlers: {
    runInternalTriggerSession: (sessionId: string, trigger: InternalSessionTriggerExecution) => Promise<void>;
    wakeInlineBatch: (sessionId: string) => void;
  }
) {
  const dispatcher = createInternalTriggerDispatcher(deps, handlers);

  return {
    async dispatchScheduledPrompt(input: {
      sessionId: string;
      jobName: string;
      instruction: string;
    }): Promise<void> {
      await dispatcher.dispatchTrigger({
        sessionId: input.sessionId,
        queueLogEvent: "scheduled_job_queued",
        createTrigger: (target): InternalSessionTriggerExecution => target.type === "group"
          ? {
              kind: "scheduled_instruction",
              targetType: "group",
              ...(target.groupId ? { targetGroupId: target.groupId } : {}),
              targetSenderName: target.senderName,
              jobName: input.jobName,
              instruction: input.instruction,
              enqueuedAt: Date.now()
            }
          : {
              kind: "scheduled_instruction",
              targetType: "private",
              targetUserId: target.userId,
              targetSenderName: target.senderName,
              jobName: input.jobName,
              instruction: input.instruction,
              enqueuedAt: Date.now()
            }
      });
    },
    async dispatchInternalTrigger(
      sessionId: string,
      triggerFactory: (target: {
        type: "private" | "group";
        userId: string;
        groupId?: string;
        senderName: string;
      }) => InternalSessionTriggerExecution
    ): Promise<void> {
      await dispatcher.dispatchTrigger({
        sessionId,
        queueLogEvent: "internal_trigger_queued",
        createTrigger: triggerFactory
      });
    },
    async dispatchTerminalEvent(event: ShellRuntimeEvent): Promise<void> {
      await dispatcher.dispatchTrigger({
        sessionId: event.owner.sessionId,
        targetHint: {
          userId: event.owner.userId,
          senderName: event.owner.senderName
        },
        queueLogEvent: "terminal_event_queued",
        createTrigger: (target): InternalSessionTriggerExecution => {
          const common = {
            targetType: target.type,
            ...(target.type === "private"
              ? { targetUserId: target.userId }
              : (target.groupId ? { targetGroupId: target.groupId } : {})),
            targetSenderName: target.senderName,
            jobName: event.kind === "session_closed"
              ? `终端任务已结束 (${event.command.slice(0, 48)})`
              : `终端可能等待输入 (${event.command.slice(0, 48)})`,
            instruction: event.kind === "session_closed"
              ? "后台终端任务已结束。请根据输出判断是否成功，并继续完成用户原始任务；如果失败，说明原因并尝试修复。"
              : "后台终端任务可能正在等待输入。请根据提示判断是否可以继续输入；不确定时向用户询问。",
            enqueuedAt: Date.now(),
            resourceId: event.resourceId,
            command: event.command,
            cwd: event.cwd
          };
          if (event.kind === "session_closed") {
            return {
              kind: "terminal_session_closed",
              ...common,
              exitCode: event.exitCode,
              signal: event.signal,
              output: event.output,
              outputTruncated: event.outputTruncated
            } as InternalSessionTriggerExecution;
          }
          return {
            kind: "terminal_input_required",
            ...common,
            promptKind: event.promptKind,
            promptText: event.promptText,
            promptSignature: event.promptSignature,
            detectedAtMs: event.detectedAtMs,
            outputTail: event.outputTail
          } as InternalSessionTriggerExecution;
        }
      });
    },
    async dispatchDownloadEvent(event: DownloadRuntimeEvent): Promise<void> {
      await dispatcher.dispatchTrigger({
        sessionId: event.owner.sessionId,
        targetHint: {
          userId: event.owner.userId,
          senderName: event.owner.senderName
        },
        queueLogEvent: "download_event_queued",
        createTrigger: (target): InternalSessionTriggerExecution => {
          const common = {
            targetType: target.type,
            ...(target.type === "private"
              ? { targetUserId: target.userId }
              : (target.groupId ? { targetGroupId: target.groupId } : {})),
            targetSenderName: target.senderName,
            jobName: event.kind === "download_completed"
              ? `下载已完成 (${event.file.sourceName.slice(0, 48)})`
              : `下载失败 (${event.sourceUrl.slice(0, 48)})`,
            instruction: event.kind === "download_completed"
              ? "后台下载已完成。系统已把文件导入 asset，请根据用户原始任务判断下一步；需要发送给用户时可调用 asset_send_to_chat。"
              : "后台下载失败。请根据错误判断是否需要重试、换来源或告知用户。",
            enqueuedAt: Date.now(),
            resourceId: event.resourceId,
            sourceUrl: event.sourceUrl
          };
          if (event.kind === "download_completed") {
            return {
              kind: "download_completed",
              ...common,
              fileId: event.file.fileId,
              fileRef: event.file.fileRef,
              chatFilePath: event.file.chatFilePath,
              sourceName: event.file.sourceName,
              mimeType: event.file.mimeType,
              sizeBytes: event.file.sizeBytes,
              fileKind: event.file.kind
            } as InternalSessionTriggerExecution;
          }
          return {
            kind: "download_failed",
            ...common,
            error: event.error
          } as InternalSessionTriggerExecution;
        }
      });
    },
    async dispatchComfyEvent(event: ComfyRuntimeEvent): Promise<void> {
      await dispatcher.dispatchTrigger({
        sessionId: event.owner.sessionId,
        targetHint: {
          userId: event.owner.userId,
          senderName: event.owner.senderName
        },
        queueLogEvent: "comfy_event_queued",
        createTrigger: (target): InternalSessionTriggerExecution => {
          const common = {
            targetType: target.type,
            ...(target.type === "private"
              ? { targetUserId: target.userId }
              : (target.groupId ? { targetGroupId: target.groupId } : {})),
            targetSenderName: target.senderName,
            jobName: event.kind === "comfy_task_completed"
              ? `ComfyUI 图片已完成 (${event.templateId})`
              : `ComfyUI 图片失败 (${event.templateId})`,
            instruction: event.kind === "comfy_task_completed"
              ? "你之前发起的图片生成任务已经完成。系统已把结果导入 workspace，请自行判断接下来要做什么。"
              : "你之前发起的图片生成任务失败了。请自行判断接下来要做什么。",
            enqueuedAt: Date.now(),
            taskId: event.taskId,
            templateId: event.templateId,
            positivePrompt: event.positivePrompt,
            aspectRatio: event.aspectRatio,
            resolvedWidth: event.resolvedWidth,
            resolvedHeight: event.resolvedHeight,
            comfyPromptId: event.comfyPromptId,
            autoIterationIndex: event.autoIterationIndex,
            maxAutoIterations: event.maxAutoIterations
          };
          if (event.kind === "comfy_task_completed") {
            return {
              kind: "comfy_task_completed",
              ...common,
              workspaceFileIds: event.workspaceFileIds,
              chatFilePaths: event.chatFilePaths
            } as InternalSessionTriggerExecution;
          }
          return {
            kind: "comfy_task_failed",
            ...common,
            lastError: event.lastError
          } as InternalSessionTriggerExecution;
        }
      });
    }
  };
}
