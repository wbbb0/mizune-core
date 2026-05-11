import type { Logger } from "pino";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { RuntimeResourceRegistry } from "../../src/runtime/resources/runtimeResourceRegistry.ts";
import { RuntimeResourceStore } from "../../src/runtime/resources/runtimeResourceStore.ts";
import type { RuntimeResourceStatus } from "../../src/runtime/resources/resourceTypes.ts";

export function createRuntimeResourceHarness(dataDir: string, logger: Logger) {
  const stateDatabase = new StateDatabase(dataDir, logger);
  const runtimeResourceStore = new RuntimeResourceStore(stateDatabase);
  const runtimeResourceRegistry = new RuntimeResourceRegistry(runtimeResourceStore);
  return {
    stateDatabase,
    runtimeResourceStore,
    runtimeResourceRegistry
  };
}

export async function waitForRuntimeResourceStatus(input: {
  store: RuntimeResourceStore;
  resourceId: string;
  status: RuntimeResourceStatus;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 300);
  while (Date.now() < deadline) {
    const record = await input.store.getRow(input.resourceId);
    if (record?.status === input.status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for runtime resource ${input.resourceId} to become ${input.status}`);
}