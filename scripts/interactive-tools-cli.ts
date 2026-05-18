import { readFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { AppServiceBootstrap } from "#app/bootstrap/appServiceBootstrap.ts";
import { createAppRuntime } from "#app/runtime/appRuntime.ts";
import { buildGroupSessionId, buildPrivateSessionId } from "#conversation/session/sessionIdentity.ts";
import { listSessionModes } from "#modes/registry.ts";
import { Scheduler } from "#runtime/scheduler/scheduler.ts";
import { FakeOneBotClient, type FakeOneBotSentMessage } from "#testing/fakeOneBotClient.ts";
import type { LlmToolCall, LlmToolExecutionResult } from "#llm/llmClient.ts";
import { createBuiltinToolExecutor, getBuiltinTools } from "#llm/builtinTools.ts";
import { getBuiltinToolDescriptorByName, getBuiltinToolDescriptors } from "#llm/tools/toolRegistry.ts";
import { buildBuiltinToolContext, type BuiltinToolContext } from "#llm/tools/core/shared.ts";
import {
  createInteractiveConfig,
  prepareInteractiveRuntime,
  resolveActiveInternalUserId,
  suppressProcessWarnings
} from "./interactive-runtime-support.ts";

interface CliArgs {
  instance?: string;
  routingPreset?: string;
  dataDir?: string;
  useInstanceData: boolean;
  userId: string;
  groupId?: string;
  senderName: string;
  selfId: string;
  includeDebugTools: boolean;
  enableShell: boolean;
  enableBrowser: boolean;
  enableComfy: boolean;
  enableSearch: boolean;
  tool?: string;
  argsJson?: string;
  argsFile?: string;
  batchFile?: string;
  parallel: number;
  quiet: boolean;
  json: boolean;
}

interface CliState {
  userId: string;
  senderName: string;
  chatType: "private" | "group";
  groupId?: string;
  includeDebugTools: boolean;
}

interface ToolInvocation {
  id?: string;
  tool: string;
  args?: unknown;
}

interface ToolCallOutput {
  ok: boolean;
  tool: string;
  id?: string;
  durationMs: number;
  result?: unknown;
  error?: string;
}

type RuntimeWithServices = Awaited<ReturnType<typeof createAppRuntime>> & {
  services: AppServiceBootstrap;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.json) {
    args.quiet = true;
  }
  if (args.quiet) {
    suppressProcessWarnings();
  }
  let singleInvocationArgs: unknown = null;
  if (args.tool) {
    try {
      singleInvocationArgs = await resolveInvocationArgs(args);
    } catch (error: unknown) {
      console.error(`参数解析失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
  }
  let batchInvocations: ToolInvocation[] = [];
  let batchParallel = args.parallel;
  if (args.batchFile) {
    try {
      const batch = await resolveBatchInvocations(args.batchFile);
      batchInvocations = batch.calls;
      batchParallel = args.parallel > 1 ? args.parallel : batch.parallel;
    } catch (error: unknown) {
      console.error(`批量调用解析失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
  }
  if (args.tool && args.batchFile) {
    console.error("--tool 与 --batch 不能同时使用");
    process.exitCode = 1;
    return;
  }
  if (args.instance && !process.env.CONFIG_INSTANCE) {
    process.env.CONFIG_INSTANCE = args.instance;
  }
  if (!process.env.CONFIG_INSTANCE && !process.env.CONFIG_INSTANCE_FILE) {
    throw new Error("请通过 --instance 或 CONFIG_INSTANCE 指定要复用的模型配置，例如：--instance acc1");
  }

  const fakeOneBot = new FakeOneBotClient({
    selfId: args.selfId,
    selfName: "Tool CLI Bot"
  });
  if (!args.quiet) {
    fakeOneBot.on("sent", (message: FakeOneBotSentMessage) => {
      output.write(`\n[bot -> ${message.groupId ? `group:${message.groupId}` : `user:${message.userId ?? ""}`}] ${message.text}\n> `);
    });
  }

  const runtime = await createAppRuntime({
    oneBotClient: fakeOneBot.asOneBotClient(),
    forceOneBotStartup: true,
    disableBackgroundServices: true,
    transformConfig: (config) => createInteractiveConfig(config, {
      routingPreset: args.routingPreset,
      dataDir: args.dataDir,
      useInstanceData: args.useInstanceData,
      enableShell: args.enableShell,
      enableBrowser: args.enableBrowser,
      enableComfy: args.enableComfy,
      enableSearch: args.enableSearch,
      quiet: args.quiet
    })
  }) as RuntimeWithServices;

  const scheduler = new Scheduler(
    runtime.services.scheduledJobStore,
    runtime.services.logger,
    async (job) => {
      if (!args.quiet) {
        output.write(`\n[scheduled job fired] ${job.name}: ${job.instruction}\n> `);
      }
    }
  );

  const state: CliState = {
    userId: args.userId,
    senderName: args.senderName,
    chatType: args.groupId ? "group" : "private",
    ...(args.groupId ? { groupId: args.groupId } : {}),
    includeDebugTools: args.includeDebugTools
  };

  try {
    await prepareInteractiveRuntime(runtime.services, state);
    ensureActiveSession(runtime.services, state);

    if (args.tool) {
      const result = await callTool(runtime.services, scheduler, state, {
        tool: args.tool,
        args: singleInvocationArgs
      });
      writeToolOutput(result, args);
      if (!result.ok) {
        process.exitCode = 1;
      }
      return;
    }

    if (args.batchFile) {
      const results = await runBatch(runtime.services, scheduler, state, batchInvocations, batchParallel);
      writeBatchOutput(results, args);
      if (results.some((result) => !result.ok)) {
        process.exitCode = 1;
      }
      return;
    }

    if (!args.quiet) {
      printBanner(runtime.services, state, args);
    }
    await runRepl(runtime.services, scheduler, state);
  } finally {
    await scheduler.stop();
    await runtime.shutdown();
  }
}

async function runRepl(
  services: AppServiceBootstrap,
  scheduler: Scheduler,
  state: CliState
): Promise<void> {
  const rl = createInterface({ input, output });
  const processLine = async (line: string): Promise<boolean> => {
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }
    if (trimmed.startsWith("/")) {
      return handleCliCommand(trimmed, services, scheduler, state);
    }
    const invocation = parseJsonInvocation(trimmed);
    if (!invocation) {
      output.write("无法解析输入。请输入 /call <tool> <json>，或一行 {\"tool\":\"...\",\"args\":{...}}。\n");
      return true;
    }
    writeToolOutput(await callTool(services, scheduler, state, invocation), { json: false });
    return true;
  };

  try {
    if (input.isTTY) {
      while (true) {
        const line = await questionOrNull(rl);
        if (line == null) {
          break;
        }
        if (!await processLine(line)) {
          break;
        }
      }
    } else {
      for await (const line of rl) {
        if (!await processLine(line)) {
          break;
        }
      }
    }
  } finally {
    rl.close();
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

async function handleCliCommand(
  commandLine: string,
  services: AppServiceBootstrap,
  scheduler: Scheduler,
  state: CliState
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
      await prepareInteractiveRuntime(services, state);
      ensureActiveSession(services, state);
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
      ensureActiveSession(services, state);
      output.write(`当前会话：${getActiveSessionId(services, state)}\n`);
      return true;
    case "group":
      if (!value) {
        output.write("用法：/group <groupId>\n");
        return true;
      }
      state.chatType = "group";
      state.groupId = value;
      ensureActiveSession(services, state);
      output.write(`当前会话：${getActiveSessionId(services, state)}\n`);
      return true;
    case "debug":
      state.includeDebugTools = value !== "off";
      output.write(`debug 工具：${state.includeDebugTools ? "on" : "off"}\n`);
      return true;
    case "tools":
      await printAvailableTools(services, state, value);
      return true;
    case "all-tools":
      printAllTools(services, value);
      return true;
    case "schema":
      printToolSchema(services, value);
      return true;
    case "session":
      await printSession(services, state);
      return true;
    case "call": {
      const invocation = parseCallCommand(value);
      if (!invocation.ok) {
        output.write(`${invocation.error}\n`);
        return true;
      }
      writeToolOutput(await callTool(services, scheduler, state, invocation), { json: false });
      return true;
    }
    default:
      output.write(`未知 CLI 命令：/${command}\n`);
      printHelp();
      return true;
  }
}

async function callTool(
  services: AppServiceBootstrap,
  scheduler: Scheduler,
  state: CliState,
  invocation: ToolInvocation
): Promise<ToolCallOutput> {
  const startedAt = Date.now();
  try {
    const context = await buildToolContext(services, scheduler, state);
    const executor = createBuiltinToolExecutor(context, {
      includeDebugTools: state.includeDebugTools,
      profileToolScope: null
    });
    const toolCall: LlmToolCall = {
      id: invocation.id ?? `interactive_${Date.now()}`,
      type: "function",
      function: {
        name: invocation.tool,
        arguments: JSON.stringify(invocation.args ?? {})
      }
    };
    const result = await executor(toolCall, invocation.args ?? {});
    return {
      ok: true,
      tool: invocation.tool,
      ...(invocation.id ? { id: invocation.id } : {}),
      durationMs: Date.now() - startedAt,
      result: normalizeToolResult(result)
    };
  } catch (error: unknown) {
    return {
      ok: false,
      tool: invocation.tool,
      ...(invocation.id ? { id: invocation.id } : {}),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runBatch(
  services: AppServiceBootstrap,
  scheduler: Scheduler,
  state: CliState,
  invocations: ToolInvocation[],
  parallel: number
): Promise<ToolCallOutput[]> {
  const maxConcurrency = Math.max(1, Math.min(16, Math.floor(parallel)));
  const results = new Array<ToolCallOutput>(invocations.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const invocation = invocations[index];
      if (!invocation) {
        return;
      }
      results[index] = await callTool(services, scheduler, state, invocation);
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(maxConcurrency, invocations.length) },
    () => worker()
  ));
  return results;
}

async function buildToolContext(
  services: AppServiceBootstrap,
  scheduler: Scheduler,
  state: CliState
): Promise<BuiltinToolContext> {
  const session = ensureActiveSession(services, state);
  const activeInternalUserId = await resolveActiveInternalUserId(state, services);
  const currentUser = await services.userStore.ensureInternalUser(activeInternalUserId);
  const relationship = activeInternalUserId === "owner" ? "owner" : "known";
  return buildBuiltinToolContext({
    config: services.config,
    relationship,
    replyDelivery: "onebot",
    lastMessage: {
      sessionId: session.id,
      userId: activeInternalUserId,
      senderName: state.senderName
    },
    currentUser,
    oneBotClient: services.oneBotClient,
    audioStore: services.audioStore,
    chatFileStore: services.chatFileStore,
    downloadRuntime: services.downloadRuntime,
    mediaVisionService: services.mediaVisionService,
    mediaCaptionService: services.mediaCaptionService,
    mediaInspectionService: services.mediaInspectionService,
    textInspectionService: services.textInspectionService,
    documentSummaryService: services.documentSummaryService,
    contextEmbeddingService: services.contextEmbeddingService,
    forwardResolver: services.forwardResolver,
    requestStore: services.requestStore,
    sessionManager: services.sessionManager,
    whitelistStore: services.whitelistStore,
    userStore: services.userStore,
    contextStore: services.contextStore,
    personaStore: services.personaStore,
    globalRuleStore: services.globalRuleStore,
    toolsetRuleStore: services.toolsetRuleStore,
    scenarioHostStateStore: services.scenarioHostStateStore,
    setupStore: services.setupStore,
    globalProfileReadinessStore: services.globalProfileReadinessStore,
    conversationAccess: services.conversationAccess,
    npcDirectory: services.npcDirectory,
    userIdentityStore: services.userIdentityStore,
    scheduledJobStore: services.scheduledJobStore,
    scheduler,
    messageQueue: services.messageQueue,
    shellRuntime: services.shellRuntime,
    searchService: services.searchService,
    browserService: services.browserService,
    localFileService: services.localFileService,
    comfyClient: services.comfyClient,
    comfyTaskStore: services.comfyTaskStore,
    comfyTemplateCatalog: services.comfyTemplateCatalog,
    persistSession: (sessionId, reason) => {
      void services.sessionPersistence.save(services.sessionManager.getPersistedSession(sessionId))
        .then(() => services.logger.debug({ sessionId, reason }, "interactive_tool_session_persisted"))
        .catch((error: unknown) => services.logger.error({ error, sessionId, reason }, "interactive_tool_session_persist_failed"));
    },
    listSessionModes
  });
}

function ensureActiveSession(services: AppServiceBootstrap, state: CliState) {
  const sessionId = getActiveSessionId(services, state);
  return services.sessionManager.ensureSession({
    id: sessionId,
    type: state.chatType,
    source: "onebot",
    participantRef: state.chatType === "group"
      ? { kind: "group", id: state.groupId ?? "10000" }
      : { kind: "user", id: state.userId },
    title: state.chatType === "group" ? `交互工具群 ${state.groupId ?? "10000"}` : `交互工具用户 ${state.userId}`,
    titleSource: "manual"
  });
}

function getActiveSessionId(services: AppServiceBootstrap, state: CliState): string {
  const channelId = services.config.configRuntime.instanceName;
  return state.chatType === "group"
    ? buildGroupSessionId(channelId, state.groupId ?? "10000")
    : buildPrivateSessionId(channelId, state.userId);
}

async function printAvailableTools(
  services: AppServiceBootstrap,
  state: CliState,
  filter: string
): Promise<void> {
  const activeInternalUserId = await resolveActiveInternalUserId(state, services);
  const currentUser = await services.userStore.ensureInternalUser(activeInternalUserId);
  const tools = getBuiltinTools(
    activeInternalUserId === "owner" ? "owner" : "known",
    currentUser,
    services.config,
    {
      includeDebugTools: state.includeDebugTools,
      profileToolScope: null
    }
  )
    .filter((tool) => !filter || tool.function.name.includes(filter))
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description
    }));
  output.write(JSON.stringify(tools, null, 2) + "\n");
}

function printAllTools(services: AppServiceBootstrap, filter: string): void {
  const tools = getBuiltinToolDescriptors(services.config)
    .filter((tool) => !filter || tool.definition.function.name.includes(filter))
    .map((tool) => ({
      name: tool.definition.function.name,
      accessLevel: tool.accessLevel ?? (tool.ownerOnly ? "owner" : "any"),
      debugOnly: tool.debugOnly === true,
      modelVisible: tool.modelVisible !== false,
      enabledInCurrentConfig: tool.isEnabled ? tool.isEnabled(services.config) : true
    }));
  output.write(JSON.stringify(tools, null, 2) + "\n");
}

function printToolSchema(services: AppServiceBootstrap, toolName: string): void {
  if (!toolName) {
    output.write("用法：/schema <toolName>\n");
    return;
  }
  const descriptor = getBuiltinToolDescriptorByName(toolName, services.config);
  output.write(JSON.stringify(descriptor?.definition ?? { error: `Tool not found: ${toolName}` }, null, 2) + "\n");
}

async function printSession(services: AppServiceBootstrap, state: CliState): Promise<void> {
  const activeInternalUserId = await resolveActiveInternalUserId(state, services);
  output.write(JSON.stringify({
    sessionId: getActiveSessionId(services, state),
    chatType: state.chatType,
    groupId: state.groupId ?? null,
    externalUserId: state.userId,
    activeInternalUserId,
    senderName: state.senderName,
    includeDebugTools: state.includeDebugTools
  }, null, 2) + "\n");
}

function parseCallCommand(value: string): ({ ok: true } & ToolInvocation) | { ok: false; error: string } {
  const [tool, rest] = splitFirstWord(value);
  if (!tool) {
    return { ok: false, error: "用法：/call <toolName> <jsonArgs>" };
  }
  try {
    return {
      ok: true,
      tool,
      args: rest ? JSON.parse(rest) : {}
    };
  } catch (error: unknown) {
    return { ok: false, error: `JSON 参数解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseJsonInvocation(line: string): ToolInvocation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed == null) {
    return null;
  }
  const record = parsed as { tool?: unknown; name?: unknown; args?: unknown; arguments?: unknown };
  const tool = String(record.tool ?? record.name ?? "").trim();
  if (!tool) {
    return null;
  }
  return {
    ...(record.id != null ? { id: String(record.id) } : {}),
    tool,
    args: record.args ?? record.arguments ?? {}
  };
}

function splitFirstWord(value: string): [string, string] {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  return [match?.[1] ?? "", match?.[2] ?? ""];
}

async function resolveInvocationArgs(args: CliArgs): Promise<unknown> {
  if (args.argsFile) {
    return JSON.parse(await readFile(args.argsFile, "utf8"));
  }
  return args.argsJson ? JSON.parse(args.argsJson) : {};
}

async function resolveBatchInvocations(path: string): Promise<{ calls: ToolInvocation[]; parallel: number }> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const callsInput = Array.isArray(parsed)
    ? parsed
    : (typeof parsed === "object" && parsed != null && Array.isArray((parsed as { calls?: unknown }).calls)
      ? (parsed as { calls: unknown[] }).calls
      : null);
  if (!callsInput) {
    throw new Error("batch 文件必须是调用数组，或形如 {\"calls\":[...],\"parallel\":2}");
  }
  const calls = callsInput.map((item, index) => normalizeBatchInvocation(item, index));
  const configuredParallel = typeof parsed === "object" && parsed != null && "parallel" in parsed
    ? Number((parsed as { parallel: unknown }).parallel)
    : 1;
  return {
    calls,
    parallel: Number.isFinite(configuredParallel) && configuredParallel > 0 ? Math.floor(configuredParallel) : 1
  };
}

function normalizeBatchInvocation(item: unknown, index: number): ToolInvocation {
  if (typeof item !== "object" || item == null) {
    throw new Error(`batch 调用 #${index + 1} 必须是对象`);
  }
  const record = item as { id?: unknown; tool?: unknown; name?: unknown; args?: unknown; arguments?: unknown };
  const tool = String(record.tool ?? record.name ?? "").trim();
  if (!tool) {
    throw new Error(`batch 调用 #${index + 1} 缺少 tool`);
  }
  return {
    ...(record.id != null ? { id: String(record.id) } : {}),
    tool,
    args: record.args ?? record.arguments ?? {}
  };
}

function writeToolOutput(result: ToolCallOutput, options: Pick<CliArgs, "json"> | { json: boolean }): void {
  output.write(JSON.stringify(result, null, options.json ? 0 : 2) + "\n");
}

function writeBatchOutput(results: ToolCallOutput[], options: Pick<CliArgs, "json"> | { json: boolean }): void {
  const payload = {
    ok: results.every((result) => result.ok),
    total: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results
  };
  output.write(JSON.stringify(payload, null, options.json ? 0 : 2) + "\n");
}

function normalizeToolResult(result: string | LlmToolExecutionResult): unknown {
  if (typeof result === "string") {
    return parseJsonIfPossible(result);
  }
  return {
    content: parseJsonIfPossible(result.content),
    ...(result.supplementalMessages ? { supplementalMessages: result.supplementalMessages } : {}),
    ...(result.terminalResponse ? { terminalResponse: result.terminalResponse } : {})
  };
}

function parseJsonIfPossible(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function printBanner(services: AppServiceBootstrap, state: CliState, args: CliArgs): void {
  output.write([
    "交互式工具测试 CLI 已启动。",
    `instance: ${services.config.configRuntime.instanceName}`,
    `dataDir: ${services.config.dataDir}`,
    `routingPreset: ${services.config.llm.routingPreset || "<empty>"}`,
    `sessionId: ${getActiveSessionId(services, state)}`,
    `debugTools: ${state.includeDebugTools ? "on" : "off"}`,
    `enabled: shell=${args.enableShell ? "on" : "off"}, browser=${args.enableBrowser ? "on" : "off"}, search=${args.enableSearch ? "on" : "off"}, comfy=${args.enableComfy ? "on" : "off"}`,
    "输入 /help 查看命令。"
  ].join("\n") + "\n");
}

function printHelp(): void {
  output.write([
    "可用命令：",
    "/tools [filter]                 列出当前可调用工具",
    "/all-tools [filter]             列出所有注册工具及当前配置可用性",
    "/schema <toolName>              查看工具 schema",
    "/call <toolName> <jsonArgs>     调用工具",
    "/session                        查看当前调用上下文",
    "/user <id>                      切换用户",
    "/name <name>                    切换昵称",
    "/private                        切换私聊会话",
    "/group <id>                     切换群聊会话",
    "/debug on|off                   是否暴露 debug 工具",
    "/quit                           退出",
    "也可以输入一行 JSON：{\"tool\":\"get_persona\",\"args\":{}}",
    "单次/批量：--tool <name> --args <json>，或 --batch <json-file> --parallel <n>"
  ].join("\n") + "\n");
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    useInstanceData: false,
    userId: "10001",
    senderName: "Tool CLI User",
    selfId: "10000",
    includeDebugTools: false,
    enableShell: false,
    enableBrowser: false,
    enableComfy: false,
    enableSearch: false,
    parallel: 1,
    quiet: false,
    json: false
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
      case "--include-debug-tools":
        args.includeDebugTools = true;
        break;
      case "--enable-shell":
        args.enableShell = true;
        break;
      case "--enable-browser":
        args.enableBrowser = true;
        break;
      case "--enable-comfy":
        args.enableComfy = true;
        break;
      case "--enable-search":
        args.enableSearch = true;
        break;
      case "--tool":
        if (next) {
          args.tool = next;
          index += 1;
        }
        break;
      case "--args":
        if (next) {
          args.argsJson = next;
          index += 1;
        }
        break;
      case "--args-file":
        if (next) {
          args.argsFile = next;
          index += 1;
        }
        break;
      case "--batch":
        if (next) {
          args.batchFile = next;
          index += 1;
        }
        break;
      case "--parallel":
        if (next) {
          const parsed = Number.parseInt(next, 10);
          args.parallel = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
          index += 1;
        }
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--json":
        args.json = true;
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
