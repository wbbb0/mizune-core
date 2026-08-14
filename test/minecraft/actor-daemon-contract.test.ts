import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolMinecraftActorClient } from "../../src/services/minecraft/actorClient.ts";
import { UnixSocketMinecraftActorTransport } from "../../src/services/minecraft/unixSocketTransport.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIME_SOURCE = join(PROJECT_ROOT, "vendor/mizune-mc-runtime/src");

test("父项目客户端与 Python daemon 完成真实握手、程序部署和行为调用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mizune-daemon-contract-"));
  const socketPath = join(directory, "runtime.sock");
  const databasePath = join(directory, "runtime.sqlite");
  const daemon = startDaemon(socketPath, databasePath);
  const transport = new UnixSocketMinecraftActorTransport({
    socketPath,
    actorId: "actor-contract",
    requestTimeoutMs: 3_000,
    connectTimeoutMs: 1_000,
    maxFrameBytes: 1_048_576
  });

  try {
    await waitForSocket(socketPath, daemon);
    const client = new ProtocolMinecraftActorClient("actor-contract", transport);
    const initial = await client.getSnapshot();
    assert.equal(initial.actorRevision, 0);
    assert.equal((await client.observe({ scope: "self" })).actorId, "actor-contract");

    const source = [
      "async def main(ctx):",
      "    target = ctx.entities.nearest(type=\"minecraft:item\", radius=16)",
      "    if target is not None:",
      "        await ctx.movement.go_to(target.position, tolerance=1)",
      ""
    ].join("\n");
    const validation = await client.validateProgram({
      protocolVersion: 1,
      programId: "contract-program",
      programVersion: 1,
      expectedActorRevision: initial.actorRevision,
      language: "python",
      apiVersion: "mizune.mc.v1",
      entrypoint: "main",
      source,
      sourceHash: `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`,
      requiredCapabilities: ["minecraft.movement.go_to@1"],
      metadata: { summary: "跨语言契约测试" }
    });
    assert.equal(validation.ok, true);
    assert.ok(validation.draft);

    const activation = await client.activateProgram({
      draftId: validation.draft.draftId,
      expectedActorRevision: initial.actorRevision,
      idempotencyKey: "contract-activate-v1",
      decisionReason: "验证跨语言程序事务"
    });
    assert.equal(activation.ok, true);
    assert.equal((await client.getActiveProgram()).value?.programId, "contract-program");

    const beforeBehavior = await client.getSnapshot();
    const behavior = await client.startBehavior({
      kind: "go_to",
      position: { x: 10, y: 64, z: 0 },
      tolerance: 1,
      expectedActorRevision: beforeBehavior.actorRevision,
      expectedObservationRevision: beforeBehavior.observationRevision,
      idempotencyKey: "contract-go-to-v1",
      decisionReason: "验证跨语言行为命令"
    });
    assert.equal(behavior.ok, true);
    assert.equal((await client.getSnapshot()).activeBehavior?.capability, "minecraft.movement.go_to@1");
    assert.ok((await client.listEvents()).length > 0);
  } finally {
    await transport.close();
    await stopDaemon(daemon);
    await rm(directory, { recursive: true, force: true });
  }
});

function startDaemon(socketPath: string, databasePath: string): ChildProcess {
  return spawn("python3", [
    "-m",
    "mizune_mc_runtime.daemon",
    "--socket",
    socketPath,
    "--database",
    databasePath,
    "--actor-id",
    "actor-contract",
    "--runtime-instance-id",
    "runtime-contract",
    "--pid-file",
    join(dirname(socketPath), "runtime.pid.json")
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH
        ? `${RUNTIME_SOURCE}${delimiter}${process.env.PYTHONPATH}`
        : RUNTIME_SOURCE
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
}

async function waitForSocket(socketPath: string, daemon: ChildProcess): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`Python daemon 提前退出：${await readStderr(daemon)}`);
    }
    try {
      await access(socketPath);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error("等待 Python daemon socket 超时");
}

async function stopDaemon(daemon: ChildProcess): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  const exited = new Promise<void>(resolve => daemon.once("exit", () => resolve()));
  daemon.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>(resolve => setTimeout(resolve, 1_000))
  ]);
  if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
}

async function readStderr(daemon: ChildProcess): Promise<string> {
  const stream = daemon.stderr;
  if (!stream) return "无 stderr";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim() || "无 stderr";
}
