import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "#config/config.ts";
import { ContextExtractionService, type ContextExtractionTurn } from "#context/contextExtractionService.ts";
import { ContextStore } from "#context/contextStore.ts";
import { LlmClient } from "#llm/llmClient.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";

const logger = {
  trace() {},
  debug() {},
  info() {},
  warn(payload?: unknown, message?: string) {
    if (process.env.SMOKE_LOG_LEVEL === "warn" || process.env.SMOKE_LOG_LEVEL === "debug") {
      console.error(JSON.stringify({ level: "warn", message, payload }));
    }
  },
  error(payload?: unknown, message?: string) {
    console.error(JSON.stringify({ level: "error", message, payload }));
  },
  child() {
    return logger;
  }
} as any;

const CASES = [
  {
    name: "session-purpose-private",
    sessionId: "smoke:p:user_1",
    userId: "user_1",
    chatType: "private" as const,
    messages: [{ userId: "user_1", senderName: "测试用户", text: "此会话专门用于记忆系统一阶段测试。", receivedAt: 1000 }],
    expect: { sessionContains: "记忆系统一阶段测试", userContains: null }
  },
  {
    name: "user-fact-nickname",
    sessionId: "smoke:p:user_1",
    userId: "user_1",
    chatType: "private" as const,
    messages: [{ userId: "user_1", senderName: "测试用户", text: "以后请叫我阿明。", receivedAt: 2000 }],
    expect: { sessionContains: null, userContains: "阿明" }
  },
  {
    name: "one-off-task-no-memory",
    sessionId: "smoke:p:user_1",
    userId: "user_1",
    chatType: "private" as const,
    messages: [{ userId: "user_1", senderName: "测试用户", text: "帮我临时算一下 37 加 58。", receivedAt: 3000 }],
    expect: { sessionContains: null, userContains: null }
  },
  {
    name: "group-session-purpose",
    sessionId: "smoke:g:group_1",
    userId: "user_1",
    chatType: "group" as const,
    messages: [
      { userId: "user_1", senderName: "Alice", text: "本群此会话专门讨论记忆系统联调。", receivedAt: 4000 },
      { userId: "user_2", senderName: "Bob", text: "收到，我也参与。", receivedAt: 4100 }
    ],
    expect: { sessionContains: "记忆系统联调", userContains: null }
  },
  {
    name: "global-rule-ignored",
    sessionId: "smoke:p:user_1",
    userId: "user_1",
    chatType: "private" as const,
    messages: [{ userId: "user_1", senderName: "测试用户", text: "以后所有任务默认先列三步计划。", receivedAt: 5000 }],
    expect: { sessionContains: null, userContains: null }
  }
];

type SmokeCase = typeof CASES[number];

function parseArgs(): {
  preset: string;
  instance: string;
  caseNames: Set<string> | null;
  timeoutMs: number;
  keepData: boolean;
} {
  const args = process.argv.slice(2);
  let preset = "local_qwen";
  let instance = "web";
  let caseNames: Set<string> | null = null;
  let timeoutMs = 180_000;
  let keepData = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--preset" && next) {
      preset = next;
      index += 1;
    } else if (arg === "--instance" && next) {
      instance = next;
      index += 1;
    } else if (arg === "--case" && next) {
      caseNames = new Set(next.split(",").map((item) => item.trim()).filter(Boolean));
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      timeoutMs = Number(next);
      index += 1;
    } else if (arg === "--keep-data") {
      keepData = true;
    }
  }
  return { preset, instance, caseNames, timeoutMs, keepData };
}

function patchConfig(input: AppConfig, preset: string, timeoutMs: number): AppConfig {
  return {
    ...input,
    dataDir: "",
    llm: {
      ...input.llm,
      enabled: true,
      routingPreset: preset,
      firstTokenTimeoutMs: timeoutMs,
      summarizer: {
        ...input.llm.summarizer,
        enabled: true,
        timeoutMs,
        enableThinking: false
      }
    },
    context: {
      ...input.context,
      extraction: {
        ...input.context.extraction,
        enabled: true,
        minConfidence: 0.7,
        timeoutMs,
        enableThinking: false
      }
    }
  };
}

function buildTurn(item: SmokeCase): ContextExtractionTurn {
  return {
    sessionId: item.sessionId,
    userId: item.userId,
    chatType: item.chatType,
    senderName: item.messages.find((message) => message.userId === item.userId)?.senderName ?? item.userId,
    userMessages: item.messages,
    assistantText: "收到。",
    completedAt: Date.now()
  };
}

function containsText(items: Array<{ title: string; content: string }>, text: string | null): boolean {
  if (!text) {
    return items.length === 0;
  }
  return items.some((item) => `${item.title}\n${item.content}`.includes(text));
}

async function main(): Promise<void> {
  const args = parseArgs();
  const selectedCases = args.caseNames
    ? CASES.filter((item) => args.caseNames?.has(item.name))
    : CASES;
  if (selectedCases.length === 0) {
    throw new Error(`No cases selected. Available: ${CASES.map((item) => item.name).join(", ")}`);
  }

  const rawConfig = loadConfig({
    ...process.env,
    CONFIG_INSTANCE: args.instance
  });
  const dataDir = await mkdtemp(join(tmpdir(), "context-memory-smoke-"));
  const config = patchConfig(rawConfig, args.preset, args.timeoutMs);
  config.dataDir = dataDir;

  const store = new ContextStore(dataDir, config, logger);
  await store.init();
  const llmClient = new LlmClient(config, logger);
  const service = new ContextExtractionService(config, llmClient, store, logger);
  const modelRefs = getModelRefsForRole(config, "summarizer");
  console.log(JSON.stringify({
    preset: args.preset,
    instance: args.instance,
    dataDir,
    summarizerRefs: modelRefs,
    configured: llmClient.isConfigured(modelRefs),
    cases: selectedCases.map((item) => item.name)
  }, null, 2));

  if (!llmClient.isConfigured(modelRefs)) {
    throw new Error(`Summarizer is not configured for preset ${args.preset}: ${modelRefs.join(", ")}`);
  }

  const results = [];
  try {
    for (const item of selectedCases) {
      const beforeUserFacts = store.listUserFacts(item.userId);
      const beforeSessionFacts = store.listSessionFacts(item.sessionId);
      const result = await service.processTurns({
        sessionId: item.sessionId,
        userId: item.userId,
        turns: [buildTurn(item)]
      });
      const userFacts = store.listUserFacts(item.userId);
      const sessionFacts = store.listSessionFacts(item.sessionId);
      const newUserFacts = userFacts.filter((fact) => !beforeUserFacts.some((before) => before.id === fact.id));
      const newSessionFacts = sessionFacts.filter((fact) => !beforeSessionFacts.some((before) => before.id === fact.id));
      const userOk = containsText(newUserFacts, item.expect.userContains);
      const sessionOk = containsText(newSessionFacts, item.expect.sessionContains);
      const ok = userOk && sessionOk;
      results.push({
        name: item.name,
        ok,
        result,
        newUserFacts,
        newSessionFacts,
        userOk,
        sessionOk
      });
      console.log(JSON.stringify(results[results.length - 1], null, 2));
    }
  } finally {
    store.close();
    if (!args.keepData) {
      await rm(dataDir, { recursive: true, force: true });
    } else {
      console.error(`Kept smoke data at ${dataDir}`);
    }
  }

  const failed = results.filter((item) => !item.ok);
  if (failed.length > 0) {
    throw new Error(`Smoke failed: ${failed.map((item) => item.name).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
