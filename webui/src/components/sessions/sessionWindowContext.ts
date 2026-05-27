import type { WorkbenchWindowContext } from "@workbench-kit/vue";

export function createSessionWindowContext(sessionId: string): WorkbenchWindowContext {
  return {
    kind: "session",
    id: sessionId
  };
}
