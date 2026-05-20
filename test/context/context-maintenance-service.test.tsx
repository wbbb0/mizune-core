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
          sessionFactRetentionDays: 14,
          summaryAfterDays: 30,
          unreachableAuditAfterDays: 60,
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
      },
      sweepExpiredSessionFacts() {
        calls.push("sweep-session-facts");
        return { deletedCount: 7 };
      },
      auditMemoryVisibility(input: { staleAfterMs: number }) {
        calls.push(`audit:${input.staleAfterMs}`);
        return { auditedCount: 8, itemIds: ["mem_1"] };
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

  assert.deepEqual(calls, ["list-users", "compact:user_1", "sweep-chunks:user_1", "sweep-deleted", "sweep-session-facts", `audit:${60 * 24 * 60 * 60 * 1000}`, "rebuild-indexes"]);
  assert.deepEqual(result, {
    compactedCount: 3,
    sweptChunkCount: 1,
    sweptSessionFactCount: 7,
    sweptDeletedCount: 2,
    embeddedCount: 4,
    indexedCount: 5,
    skippedEmbeddingCount: 6,
    auditedMemoryCount: 8
  });
});

test("ContextMaintenanceService keeps indexing fail-open when visibility audit fails", async () => {
  const calls: string[] = [];
  const service = new ContextMaintenanceService(
    createTestAppConfig(),
    {
      listUserIdsWithSearchChunks() {
        calls.push("list-users");
        return [];
      },
      sweepDeletedItems() {
        calls.push("sweep-deleted");
        return { deletedCount: 0 };
      },
      sweepExpiredSessionFacts() {
        calls.push("sweep-session-facts");
        return { deletedCount: 0 };
      },
      auditMemoryVisibility() {
        calls.push("audit");
        throw new Error("audit down");
      }
    } as any,
    {
      async rebuildUserIndexes() {
        calls.push("rebuild-indexes");
        return {
          userCount: 0,
          embeddedCount: 1,
          indexedCount: 2,
          skippedCount: 3,
          errors: []
        };
      }
    } as any,
    pino({ level: "silent" })
  );

  const result = await service.runOnce();
  assert.deepEqual(calls, ["list-users", "sweep-deleted", "sweep-session-facts", "audit", "rebuild-indexes"]);
  assert.equal(result.auditedMemoryCount, 0);
  assert.equal(result.embeddedCount, 1);
  assert.equal(result.indexedCount, 2);
});
