import type { Logger } from "pino";
import { buildGenerationFailureAssistantMessage } from "./generationExecutorSupport.ts";

/** One attempt per response, including failures while reporting the original error. */
export function createGenerationFailureLifecycle(input: {
  logger: Logger;
  sessionId: string;
  stage?: "prepare" | "generate" | "delivery";
  isCurrent: () => boolean;
  record: (error: unknown, message: string) => void;
}) {
  let reported = false;
  return {
    async report(error: unknown, notify?: (message: string) => Promise<void>, stage = input.stage ?? "generate"): Promise<void> {
      if (reported || !input.isCurrent()) return;
      reported = true;
      input.logger.error({ err: error, sessionId: input.sessionId, stage }, "generation_failed");
      const message = buildGenerationFailureAssistantMessage();
      try {
        input.record(error, message);
      } catch (recordError) {
        input.logger.warn({ err: recordError, sessionId: input.sessionId }, "generation_failure_record_failed");
      }
      try {
        if (input.isCurrent()) await notify?.(message);
      } catch (notificationError) {
        input.logger.warn({ err: notificationError, sessionId: input.sessionId }, "generation_failure_notification_failed");
      }
    }
  };
}
