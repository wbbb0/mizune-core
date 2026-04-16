import assert from "node:assert/strict";
import pino from "pino";
import type { OneBotApiResponse } from "../../../src/services/onebot/types.ts";
import { createOneBotTypingAdapter } from "../../../src/services/onebot/typingAdapter.ts";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";
import { runCase } from "../../helpers/config-test-support.tsx";

function createOkResponse<T extends OneBotApiResponse>(): T {
  return {
    status: "ok",
    retcode: 0,
    data: null
  } as T;
}

async function main() {
  await runCase("generic provider keeps typing as a no-op", async () => {
    const config = createTestAppConfig({
      onebot: {
        provider: "generic"
      }
    });
    let called = 0;
    const adapter = createOneBotTypingAdapter(config, pino({ level: "silent" }), async <T extends OneBotApiResponse>() => {
      called += 1;
      return createOkResponse<T>();
    });

    const applied = await adapter.setTyping({
      enabled: true,
      chatType: "private",
      userId: "123"
    });

    assert.equal(applied, false);
    assert.equal(called, 0);
  });

  await runCase("napcat private typing uses set_input_status start event", async () => {
    const config = createTestAppConfig({
      onebot: {
        provider: "napcat"
      }
    });
    const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    const adapter = createOneBotTypingAdapter(
      config,
      pino({ level: "silent" }),
      async <T extends OneBotApiResponse>(endpoint: string, body: Record<string, unknown>) => {
      calls.push({ endpoint, body });
      return createOkResponse<T>();
      }
    );

    const applied = await adapter.setTyping({
      enabled: true,
      chatType: "private",
      userId: "123"
    });

    assert.equal(applied, true);
    assert.deepEqual(calls, [{
      endpoint: "set_input_status",
      body: {
        user_id: 123,
        event_type: 1
      }
    }]);
  });

  await runCase("napcat group typing stays disabled by default", async () => {
    const config = createTestAppConfig({
      onebot: {
        provider: "napcat"
      }
    });
    let called = 0;
    const adapter = createOneBotTypingAdapter(config, pino({ level: "silent" }), async <T extends OneBotApiResponse>() => {
      called += 1;
      return createOkResponse<T>();
    });

    const applied = await adapter.setTyping({
      enabled: true,
      chatType: "group",
      userId: "123",
      groupId: "456"
    });

    assert.equal(applied, false);
    assert.equal(called, 0);
  });

  await runCase("napcat group typing includes group_id when enabled", async () => {
    const config = createTestAppConfig({
      onebot: {
        provider: "napcat",
        typing: {
          group: true
        }
      }
    });
    const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    const adapter = createOneBotTypingAdapter(
      config,
      pino({ level: "silent" }),
      async <T extends OneBotApiResponse>(endpoint: string, body: Record<string, unknown>) => {
      calls.push({ endpoint, body });
      return createOkResponse<T>();
      }
    );

    const applied = await adapter.setTyping({
      enabled: false,
      chatType: "group",
      userId: "123",
      groupId: "456"
    });

    assert.equal(applied, true);
    assert.deepEqual(calls, [{
      endpoint: "set_input_status",
      body: {
        user_id: 123,
        group_id: 456,
        event_type: 2
      }
    }]);
  });

  await runCase("napcat typing failures are swallowed", async () => {
    const config = createTestAppConfig({
      onebot: {
        provider: "napcat"
      }
    });
    const adapter = createOneBotTypingAdapter(config, pino({ level: "silent" }), async () => {
      throw new Error("unsupported");
    });

    const applied = await adapter.setTyping({
      enabled: true,
      chatType: "private",
      userId: "123"
    });

    assert.equal(applied, false);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
