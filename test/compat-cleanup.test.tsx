import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { OneBotClient } from "../src/services/onebot/onebotClient.ts";
import { ScheduledJobStore } from "../src/runtime/scheduler/jobStore.ts";
import { parseToolArguments } from "../src/llm/shared/toolArgs.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("scheduled job store clears legacy prompt-only records", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-scheduled-job-compat-test-"));
    const logger = pino({ level: "silent" });
    const filePath = join(dataDir, "scheduled-jobs.json");
    try {
      await writeFile(filePath, JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "job-1",
            name: "legacy job",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: {
              kind: "delay",
              delayMs: 60000
            },
            prompt: "legacy prompt field",
            targets: [
              {
                sessionId: "private:owner"
              }
            ],
            state: {
              nextRunAtMs: null,
              lastRunAtMs: null,
              lastRunStatus: null,
              lastDurationMs: null,
              lastError: null,
              consecutiveErrors: 0
            }
          }
        ]
      }, null, 2));

      const store = new ScheduledJobStore(dataDir, logger);
      await store.init();
      assert.deepEqual(await store.list(), []);

      const persisted = JSON.parse(await readFile(filePath, "utf8"));
      assert.deepEqual(persisted, {
        version: 1,
        jobs: []
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await runCase("tool argument parser preserves oversized numeric ids as strings", async () => {
    const parsed = parseToolArguments(
      '{"forward_id":7618160446138694072,"message_id":1234567890123456789,"link_id":7}',
      pino({ level: "silent" }),
      {
        toolName: "view_forward_record",
        toolCallId: "tool-call-1"
      }
    );

    assert.deepEqual(parsed, {
      forward_id: "7618160446138694072",
      message_id: "1234567890123456789",
      link_id: 7
    });
  });

  await runCase("onebot getForwardMessage surfaces API failures", async () => {
    const server = createServer((req, res) => {
      if (req.url !== "/get_forward_msg") {
        res.writeHead(404).end();
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        status: "failed",
        retcode: 200,
        data: null,
        message: "消息已过期或者为内层消息，无法获取转发消息"
      }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    try {
      const client = new OneBotClient({
        onebot: {
          wsUrl: "ws://127.0.0.1:3001",
          httpUrl: `http://127.0.0.1:${address.port}`,
          accessToken: "test-token"
        }
      } as any, pino({ level: "silent" }));

      await assert.rejects(
        client.getForwardMessage("7618168520610781740"),
        /消息已过期或者为内层消息，无法获取转发消息/
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
