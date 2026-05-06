import type { WorkbenchWindowContext } from "@llm-onebot/vue-workbench";

export function createSessionWindowContext(sessionId: string): WorkbenchWindowContext {
  return {
    kind: "session",
    id: sessionId
  };
}
