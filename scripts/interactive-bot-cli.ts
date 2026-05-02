import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AppConfig } from "#config/config.ts";
import { createAppRuntime } from "#app/runtime/appRuntime.ts";
import type { AppServiceBootstrap } from "#app/bootstrap/appServiceBootstrap.ts";
import { FakeOneBotClient, type FakeOneBotSentMessage } from "#testing/fakeOneBotClient.ts";

interface CliArgs {
  instance?: string;
  routingPreset?: string;
  dataDir?: string;
  useInstanceData: boolean;
  userId: string;
  groupId?: string;
  senderName: string;
  selfId: string;
  atSelf: boolean;
}

interface CliState {
  userId: string;
  senderName: string;
  chatType: "private" | "group";
  groupId?: string;
  atSelf: boolean;
}

type RuntimeWithServices = Awaited<ReturnType<typeof createAppRuntime>> & {
  services: AppServiceBootstrap;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.instance && !process.env.CONFIG_INSTANCE) {
    process.env.CONFIG_INSTANCE = args.instance;
  }
  if (!process.env.CONFIG_INSTANCE && !process.env.CONFIG_INSTANCE_FILE) {
    throw new Error("请通过 --instance 或 CONFIG_INSTANCE 指定要复用的模型配置，例如：--instance prod_deepseek");
  }

  const fakeOneBot = new FakeOneBotClient({
    selfId: args.selfId,
    selfName: "CLI Bot"
  });
  fakeOneBot.on("sent", (message: FakeOneBotSentMessage) => {
    output.write(`\n[bot -> ${message.groupId ? `group:${message.groupId}` : `user:${message.userId ?? ""}`}] ${message.text}\n> `);
  });

  const runtime = await createAppRuntime({
    oneBotClient: fakeOneBot.asOneBotClient(),
    forceOneBotStartup: true,
    disableBackgroundServices: true,
    transformConfig: (config) => createInteractiveConfig(config, args)
  }) as RuntimeWithServices;

  const state: CliState = {
    userId: args.userId,
    senderName: args.senderName,
    chatType: args.groupId ? "group" : "private",
    ...(args.groupId ? { groupId: args.groupId } : {}),
    atSelf: args.atSelf
  };
  await prepareInteractiveRuntime(runtime.services, state);

  printBanner(runtime.services.config, state);
  const rl = createInterface({ input, output });
  const processLine = async (line: string): Promise<boolean> => {
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }
    if (trimmed.startsWith("/")) {
      return handleCliCommand(trimmed, state, runtime.services);
    }
    if (state.chatType === "group") {
      await fakeOneBot.pushGroupTextAndWait({
        groupId: state.groupId ?? "10000",
        userId: state.userId,
        senderName: state.senderName,
        text: trimmed,
        atSelf: state.atSelf
      });
    } else {
      await fakeOneBot.pushPrivateTextAndWait({
        userId: state.userId,
        senderName: state.senderName,
        text: trimmed
      });
    }
    return true;
  };
  try {
    if (input.isTTY) {
      while (true) {
        const line = await questionOrNull(rl);
        if (line == null) {
          break;
        }
        const shouldContinue = await processLine(line);
        if (!shouldContinue) {
          break;
        }
      }
    } else {
      for await (const line of rl) {
        const shouldContinue = await processLine(line);
        if (!shouldContinue) {
          break;
        }
      }
    }
  } finally {
    rl.close();
    await runtime.shutdown();
  }
}

async function questionOrNull(
  rl: ReturnType<typeof createInterface>
): Promise<string | null> {
  try {
    return await rl.question("> ");
  } catch (error: unknown) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE"
    ) {
      return null;
    }
    throw error;
  }
}

function createInteractiveConfig(config: AppConfig, args: CliArgs): AppConfig {
  const dataDir = args.useInstanceData
    ? config.dataDir
    : args.dataDir ?? `data/interactive-${config.configRuntime.instanceName}`;
  return {
    ...config,
    dataDir,
    llm: {
      ...config.llm,
      ...(args.routingPreset ? { routingPreset: args.routingPreset } : {})
    },
    whitelist: {
      enabled: false
    },
    onebot: {
      ...config.onebot,
      enabled: true,
      wsUrl: "ws://127.0.0.1/interactive-fake-onebot",
      httpUrl: "http://127.0.0.1/interactive-fake-onebot"
    },
    internalApi: {
      ...config.internalApi,
      enabled: false,
      webui: {
        ...config.internalApi.webui,
        enabled: false
      }
    },
    scheduler: {
      ...config.scheduler,
      enabled: false
    },
    shell: {
      ...config.shell,
      enabled: false
    },
    browser: {
      ...config.browser,
      enabled: false
    },
    comfy: {
      ...config.comfy,
      enabled: false
    },
    search: {
      ...config.search,
      googleGrounding: {
        ...config.search.googleGrounding,
        enabled: false
      },
      aliyunIqs: {
        ...config.search.aliyunIqs,
        enabled: false
      }
    },
    conversation: {
      ...config.conversation,
      setup: {
        ...config.conversation.setup,
        skipPersonaInitialization: true
      },
      debounce: {
        ...config.conversation.debounce,
        defaultBaseSeconds: 0.1,
        minBaseSeconds: 0.1,
        maxBaseSeconds: 0.2,
        finalMultiplier: 1,
        plannerWaitMultiplier: 1,
        randomRatioMin: 1,
        randomRatioMax: 1
      },
      outbound: {
        ...config.conversation.outbound,
        disableStreamingSplit: true,
        baseDelayMs: 0,
        charDelayMs: 0,
        maxDelayMs: 0,
        randomFactorMin: 1,
        randomFactorMax: 1
      }
    }
  };
}

async function handleCliCommand(
  commandLine: string,
  state: CliState,
  services: AppServiceBootstrap
): Promise<boolean> {
  const [command, ...rest] = commandLine.slice(1).split(/\s+/u);
  const value = rest.join(" ").trim();
  switch (command) {
    case "help":
      printHelp();
      return true;
    case "quit":
    case "exit":
      return false;
    case "user":
      if (!value) {
        output.write("用法：/user <userId>\n");
        return true;
      }
      state.userId = value;
      output.write(`当前用户：${state.userId}\n`);
      return true;
    case "name":
      if (!value) {
        output.write("用法：/name <senderName>\n");
        return true;
      }
      state.senderName = value;
      output.write(`当前昵称：${state.senderName}\n`);
      return true;
    case "private":
      state.chatType = "private";
      delete state.groupId;
      output.write("当前模式：私聊\n");
      return true;
    case "group":
      if (!value) {
        output.write("用法：/group <groupId>\n");
        return true;
      }
      state.chatType = "group";
      state.groupId = value;
      output.write(`当前模式：群聊 ${value}\n`);
      return true;
    case "at":
      state.atSelf = value !== "off";
      output.write(`群聊 @bot：${state.atSelf ? "on" : "off"}\n`);
      return true;
    case "status":
      await printStatus(state, services);
      return true;
    case "context":
      await printContextItems(state, services);
      return true;
    case "rebuild-context":
      output.write("开始补齐 embedding 并重建索引...\n");
      const rebuildUserId = await resolveActiveInternalUserId(state, services);
      output.write(`${JSON.stringify(await services.contextRetrievalService.rebuildUserIndexes({
        userId: rebuildUserId,
        embeddingBatchSize: 64
      }), null, 2)}\n`);
      return true;
    case "retrieve":
      if (!value) {
        output.write("用法：/retrieve <query>\n");
        return true;
      }
      await printRetrievedContext(state, services, value);
      return true;
    case "wait":
      await waitForRuntimeIdle(services, parsePositiveInteger(value) ?? 30_000);
      return true;
    default:
      output.write(`未知 CLI 命令：/${command}\n`);
      printHelp();
      return true;
  }
}

function printBanner(config: AppConfig, state: CliState): void {
  output.write([
    "交互式 Bot 测试 CLI 已启动。",
    `instance: ${config.configRuntime.instanceName}`,
    `dataDir: ${config.dataDir}`,
    `routingPreset: ${config.llm.routingPreset || "<empty>"}`,
    `mode: ${state.chatType}${state.groupId ? `:${state.groupId}` : ""}`,
    `user: ${state.userId}`,
    "输入 /help 查看命令。普通文本会作为用户消息进入正式消息链路。"
  ].join("\n") + "\n");
}

function printHelp(): void {
  output.write([
    "可用命令：",
    "/user <id>              切换发送用户",
    "/name <name>            切换发送昵称",
    "/private                切换私聊",
    "/group <id>             切换群聊",
    "/at on|off              群聊时是否 @ bot",
    "/status                 查看运行状态",
    "/context                查看当前用户 context items",
    "/retrieve <query>       以当前用户身份执行 context 召回",
    "/rebuild-context        补齐当前用户 embedding 并重建索引",
    "/wait [ms]              等待会话处理完成，默认 30000ms",
    "/quit                   退出"
  ].join("\n") + "\n");
}

async function prepareInteractiveRuntime(services: AppServiceBootstrap, state: CliState): Promise<void> {
  const channelId = services.config.configRuntime.instanceName;
  const currentUserInternalId = await services.userIdentityStore.findInternalUserId({
    channelId,
    externalId: state.userId
  });
  if (!await services.userIdentityStore.hasOwnerIdentity()) {
    if (!currentUserInternalId) {
      await services.userIdentityStore.bindOwnerIdentity({
        channelId,
        externalId: state.userId
      });
    } else if (currentUserInternalId !== "owner") {
      await services.userIdentityStore.bindOwnerIdentity({
        channelId,
        externalId: `${state.userId}:interactive-owner`
      });
    }
  }
  await services.setupStore.advanceAfterOwnerBound(await services.personaStore.get());
  await services.globalProfileReadinessStore.setPersonaReadiness("ready");
  await services.globalProfileReadinessStore.setRpReadiness("ready");
  await services.globalProfileReadinessStore.setScenarioReadiness("ready");
}

async function resolveActiveInternalUserId(
  state: CliState,
  services: AppServiceBootstrap
): Promise<string> {
  return await services.userIdentityStore.findInternalUserId({
    channelId: services.config.configRuntime.instanceName,
    externalId: state.userId
  }) ?? state.userId;
}

async function printStatus(state: CliState, services: AppServiceBootstrap): Promise<void> {
  const contextStats = services.contextStore.getContextStats();
  const setupState = await services.setupStore.get();
  const activeInternalUserId = await resolveActiveInternalUserId(state, services);
  output.write(JSON.stringify({
    chatType: state.chatType,
    externalUserId: state.userId,
    activeInternalUserId,
    groupId: state.groupId ?? null,
    atSelf: state.atSelf,
    setupState,
    sessions: services.sessionManager.listSessions().map((session) => ({
      id: session.id,
      modeId: session.modeId,
      transcriptCount: session.internalTranscript.length,
      pendingCount: session.pendingMessages.length,
      phase: session.phase
    })),
    context: {
      store: services.contextStore.getStatus(),
      embedding: services.contextEmbeddingService.getStatus(),
      stats: contextStats,
      lastRetrieval: services.contextRetrievalService.getLastDebugReport()
    }
  }, null, 2) + "\n");
}

async function printContextItems(state: CliState, services: AppServiceBootstrap): Promise<void> {
  const activeInternalUserId = await resolveActiveInternalUserId(state, services);
  const result = services.contextStore.listContextItems({
    userId: activeInternalUserId,
    limit: 20
  });
  output.write(JSON.stringify({
    externalUserId: state.userId,
    activeInternalUserId,
    ...result
  }, null, 2) + "\n");
}

async function printRetrievedContext(
  state: CliState,
  services: AppServiceBootstrap,
  queryText: string
): Promise<void> {
  const activeInternalUserId = await resolveActiveInternalUserId(state, services);
  const results = await services.contextRetrievalService.retrieveUserContext({
    userId: activeInternalUserId,
    queryText
  });
  output.write(JSON.stringify({
    externalUserId: state.userId,
    activeInternalUserId,
    queryText,
    results,
    debug: services.contextRetrievalService.getLastDebugReport()
  }, null, 2) + "\n");
}

async function waitForRuntimeIdle(
  services: AppServiceBootstrap,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const active = services.sessionManager.listSessions().filter((session) => (
      session.pendingMessages.length > 0
      || session.pendingInternalTriggers.length > 0
      || session.debounceTimer != null
      || session.phase.kind !== "idle"
    ));
    if (active.length === 0) {
      output.write(`运行时已空闲，用时 ${Date.now() - startedAt}ms。\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  output.write(`等待超时：${timeoutMs}ms。\n`);
}

function parsePositiveInteger(value: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    useInstanceData: false,
    userId: "10001",
    senderName: "CLI User",
    selfId: "10000",
    atSelf: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    switch (current) {
      case "--instance":
        if (next) {
          args.instance = next;
          index += 1;
        }
        break;
      case "--routing-preset":
        if (next) {
          args.routingPreset = next;
          index += 1;
        }
        break;
      case "--data-dir":
        if (next) {
          args.dataDir = next;
          index += 1;
        }
        break;
      case "--use-instance-data":
        args.useInstanceData = true;
        break;
      case "--user":
        if (next) {
          args.userId = next;
          index += 1;
        }
        break;
      case "--name":
        if (next) {
          args.senderName = next;
          index += 1;
        }
        break;
      case "--group":
        if (next) {
          args.groupId = next;
          index += 1;
        }
        break;
      case "--self":
        if (next) {
          args.selfId = next;
          index += 1;
        }
        break;
      case "--no-at":
        args.atSelf = false;
        break;
      default:
        break;
    }
  }
  return args;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
