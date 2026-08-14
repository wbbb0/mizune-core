import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "#config/config.ts";
import { LlmClient } from "#llm/llmClient.ts";
import type {
  MinecraftActorClient,
  MinecraftRuntimeCapabilities
} from "#services/minecraft/actorClient.ts";
import { MinecraftDecisionRunner } from "#services/minecraft/decisionRunner.ts";
import type {
  MinecraftActorSnapshot,
  MinecraftCommandResult,
  MinecraftObservationEnvelope,
  MinecraftProgramDocument,
  MinecraftRuntimeEvent
} from "#services/minecraft/actorTypes.ts";
import pino from "pino";

const execFileAsync = promisify(execFile);

interface CliArgs {
  instance: string;
  modelRef: string;
  smokeCase: "behavior" | "program";
  runs: number;
  timeoutMs: number;
}

interface ActorTrace {
  calls: string[];
  validatedPrograms: MinecraftProgramDocument[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ ...process.env, CONFIG_INSTANCE: args.instance });
  const logger = pino({ level: process.env.SMOKE_LOG_LEVEL ?? "warn" });
  const llm = new LlmClient(config, logger);
  if (!llm.isConfigured(args.modelRef)) {
    throw new Error(`模型未配置：${args.modelRef}`);
  }

  const results = [];
  for (let run = 1; run <= args.runs; run += 1) {
    const trace: ActorTrace = { calls: [], validatedPrograms: [] };
    const runner = new MinecraftDecisionRunner(llm, createSmokeActor(trace), logger);
    const startedAtMs = Date.now();
    const result = await runner.run({
      actorId: "smoke-actor",
      persistentState: "位于出生点，当前无活动任务。",
      currentGoal: args.smokeCase === "behavior" ? "保证自身安全" : "维护附近掉落物",
      wakeReason: args.smokeCase === "behavior"
        ? {
            type: "safety_interrupt",
            summary: "附近出现一只僵尸，当前生命 20。读取必要状态，提交一个高层行为保护自己，然后结束本次决策。",
            occurredAtMs: Date.now()
          }
        : {
            type: "owner_program_request",
            summary: "编写并部署一个 Python 行为程序：读取 16 格内最近的掉落物，存在时前往其位置。使用 async def main(ctx)，允许普通 if 和计算。",
            occurredAtMs: Date.now()
          },
      modelRef: args.modelRef,
      timeoutMs: args.timeoutMs,
      allowProgramDeployment: args.smokeCase === "program"
    });

    if (
      args.smokeCase === "behavior"
      && !trace.calls.some(call => call.startsWith("startBehavior:") || call.startsWith("submitTask:"))
    ) {
      throw new Error(`第 ${run} 次未提交高层行为或任务：${trace.calls.join(", ")}`);
    }
    if (args.smokeCase === "program") {
      if (!trace.calls.includes("validateProgram") || !trace.calls.includes("activateProgram")) {
        throw new Error(`第 ${run} 次未完成 validate -> activate：${trace.calls.join(", ")}`);
      }
      const source = trace.validatedPrograms.at(-1)?.source;
      if (!source) throw new Error(`第 ${run} 次没有提交 Python 源码`);
      await validatePythonSource(source);
    }

    results.push({
      run,
      durationMs: Date.now() - startedAtMs,
      toolCallCount: result.toolCallCount,
      summary: result.completion.summary,
      currentGoal: result.completion.currentGoal,
      calls: trace.calls,
      usage: result.usage
    });
  }

  console.log(JSON.stringify({
    instance: args.instance,
    modelRef: args.modelRef,
    case: args.smokeCase,
    timeoutMs: args.timeoutMs,
    enableThinking: false,
    preferNativeNoThinkingChatEndpoint: true,
    results
  }, null, 2));
}

function createSmokeActor(trace: ActorTrace): MinecraftActorClient {
  let actorRevision = 3;
  const snapshot = (): MinecraftActorSnapshot => ({
    protocolVersion: 1,
    actorId: "smoke-actor",
    actorRevision,
    observationRevision: 7,
    self: selfState(),
    activeBehavior: null,
    actionLease: null,
    activeTask: null,
    queuedTaskCount: 0,
    autonomyPolicy: {
      enabled: false,
      idleDelayMs: 10_000,
      collectItems: true,
      explore: true,
      combatHostiles: false,
      exploreRadius: 12,
      combatStopHealth: 8
    }
  });
  const observation = (value: MinecraftObservationEnvelope["value"]): MinecraftObservationEnvelope => ({
    protocolVersion: 1,
    actorId: "smoke-actor",
    actorRevision,
    observationRevision: 7,
    observedAtMs: Date.now(),
    self: selfState(),
    value
  });
  const success = (idempotencyKey: string): MinecraftCommandResult => ({
    protocolVersion: 1,
    commandId: `command-${trace.calls.length}`,
    idempotencyKey,
    ok: true,
    status: "accepted",
    reason: null,
    retryability: "none",
    actorRevision: ++actorRevision,
    observationRevision: 7,
    value: {}
  });

  return {
    async getCapabilities(): Promise<MinecraftRuntimeCapabilities> {
      return {
        rpcMethods: [
          "actor.get_snapshot", "observation.get", "behavior.start", "behavior.cancel",
          "task.submit", "task.cancel", "autonomy.set_policy", "program.get_active",
          "program.validate", "program.activate", "events.list"
        ],
        observationScopes: ["self", "environment", "inventory", "entities", "player", "chat", "tasks"],
        behaviorCapabilities: [
          "minecraft.movement.go_to@1",
          "minecraft.follow_and_assist@1",
          "minecraft.interaction.entity@1",
          "minecraft.inventory.collect_item@1",
          "minecraft.chat.send@1",
          "minecraft.combat.engage@1"
        ],
        runtimeFeatures: ["simulation@1"]
      };
    },
    async getSnapshot() {
      trace.calls.push("getSnapshot");
      return snapshot();
    },
    async observe(request) {
      trace.calls.push(`observe:${request.scope}`);
      if (request.scope === "entities") {
        return observation([{
          ref: "opaque-hostile-zombie",
          kind: "hostile",
          typeId: "minecraft:zombie",
          position: { x: 3, y: 64, z: 0 },
          health: 20,
          visible: true
        }]);
      }
      return observation(request.scope === "self" ? selfState() : null);
    },
    async startBehavior(command) {
      trace.calls.push(`startBehavior:${command.kind}`);
      return success(command.idempotencyKey);
    },
    async cancelBehavior(command) {
      trace.calls.push("cancelBehavior");
      return success(command.idempotencyKey);
    },
    async submitTask(command) {
      trace.calls.push(`submitTask:${command.kind}`);
      return success(command.idempotencyKey);
    },
    async cancelTask(command) {
      trace.calls.push("cancelTask");
      return success(command.idempotencyKey);
    },
    async setAutonomy(command) {
      trace.calls.push("setAutonomy");
      return success(command.idempotencyKey);
    },
    async getActiveProgram() {
      trace.calls.push("getActiveProgram");
      return { ...observation(null), value: null };
    },
    async validateProgram(document) {
      trace.calls.push("validateProgram");
      trace.validatedPrograms.push(document);
      return {
        protocolVersion: 1,
        ok: true,
        draft: { draftId: "draft-smoke", validatedAtMs: Date.now(), program: document },
        diagnostics: []
      };
    },
    async activateProgram(command) {
      trace.calls.push("activateProgram");
      return success(command.idempotencyKey);
    },
    async listEvents(): Promise<MinecraftRuntimeEvent[]> {
      trace.calls.push("listEvents");
      return [];
    },
    close() {
      return;
    }
  };
}

async function validatePythonSource(source: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "minecraft-program-smoke-"));
  const path = join(directory, "program.py");
  try {
    await writeFile(path, source, "utf8");
    const runtimeRoot = fileURLToPath(new URL("../../vendor/mizune-mc-runtime", import.meta.url));
    await execFileAsync("/usr/bin/python3", ["-m", "mizune_mc_runtime.script_validation", path], {
      cwd: runtimeRoot,
      env: { ...process.env, PYTHONPATH: join(runtimeRoot, "src") },
      timeout: 5_000
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): CliArgs {
  let instance = "web";
  let modelRef = "ds_deepseek_v4_flash";
  let smokeCase: CliArgs["smokeCase"] = "behavior";
  let runs = 1;
  let timeoutMs = 10_000;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--instance":
        if (value) instance = value;
        index += 1;
        break;
      case "--model-ref":
        if (value) modelRef = value;
        index += 1;
        break;
      case "--case":
        if (value === "behavior" || value === "program") smokeCase = value;
        else throw new Error("--case 仅支持 behavior 或 program");
        index += 1;
        break;
      case "--runs":
        runs = Number(value);
        index += 1;
        break;
      case "--timeout-ms":
        timeoutMs = Number(value);
        index += 1;
        break;
    }
  }
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw new Error("--runs 必须是 1..20 的整数");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("--timeout-ms 必须至少为 1000");
  return { instance, modelRef, smokeCase, runs, timeoutMs };
}

function selfState() {
  return { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, connected: true };
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
