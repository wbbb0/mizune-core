import type { WorkbenchWindowContext } from "@/components/workbench/windows/types";

export function createSessionWindowContext(sessionId: string): WorkbenchWindowContext {
  return {
    kind: "session",
    id: sessionId
  };
}
