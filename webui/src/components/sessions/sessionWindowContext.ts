import type { WindowContext } from "@/components/workbench/windows/types";

export function createSessionWindowContext(sessionId: string): WindowContext {
  return {
    kind: "session",
    id: sessionId
  };
}
