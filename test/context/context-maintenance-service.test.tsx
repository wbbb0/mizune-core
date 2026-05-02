import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { ContextMaintenanceService } from "../../src/context/contextMaintenanceService.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("ContextMaintenanceService compacts chunks and sweeps deleted items fail-open", async () => {
  const calls: string[] = [];
  const service = new ContextMaintenanceService(
    createTestAppConfig({
      context: {
        retention: {
          maxUserSearchChunks: 2,
          maxSearchChunkAgeDays: 90,
          summaryAfterDays: 30,
          deletedRetentionDays: 14,
          maintenanceIntervalMs: 1000
        }
      }
    }),
    {
      listUserIdsWithSearchChunks() {
        calls.push("list-users");
        return ["user_1"];
      },
      compactUserSearchChunks(input: { userId: string }) {
        calls.push(`compact:${input.userId}`);
        return { compactedCount: 3, summaryItemId: "ctx_summary_1" };
      },
      sweepUserSearchChunks(input: { userId: string }) {
        calls.push(`sweep-chunks:${input.userId}`);
        return { deletedCount: 1 };
      },
      sweepDeletedItems() {
        calls.push("sweep-deleted");
        return { deletedCount: 2 };
      }
    } as any,
    {
      async rebuildUserIndexes() {
        calls.push("rebuild-indexes");
        return {
          userCount: 1,
          embeddedCount: 4,
          indexedCount: 5,
          skippedCount: 6,
          errors: []
        };
      }
    } as any,
    pino({ level: "silent" })
  );

  const result = await service.runOnce();

  assert.deepEqual(calls, ["list-users", "compact:user_1", "sweep-chunks:user_1", "sweep-deleted", "rebuild-indexes"]);
  assert.deepEqual(result, {
    compactedCount: 3,
    sweptChunkCount: 1,
    sweptDeletedCount: 2,
    embeddedCount: 4,
    indexedCount: 5,
    skippedEmbeddingCount: 6
  });
});
