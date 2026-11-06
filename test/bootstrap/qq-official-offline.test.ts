import "../helpers/network-interfaces-fixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppRuntime } from "../../src/app/runtime/appRuntime.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("QQ 凭据缺失时完整应用仍可完成启动并正常停止", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-offline-runtime-"));
  const previousEnv = { CONFIG_DIR: process.env.CONFIG_DIR, CONFIG_INSTANCE: process.env.CONFIG_INSTANCE, CONFIG_INSTANCE_FILE: process.env.CONFIG_INSTANCE_FILE };
  const configDir = join(dataDir, "config");
  await mkdir(join(configDir, "instances"), { recursive: true });
  await writeFile(join(configDir, "instances/offline.yml"), "{}\n");
  process.env.CONFIG_DIR = configDir;
  process.env.CONFIG_INSTANCE = "offline";
  delete process.env.CONFIG_INSTANCE_FILE;
  let runtime: Awaited<ReturnType<typeof createAppRuntime>> | undefined;
  try {
    runtime = await createAppRuntime({
      transformConfig: () => createTestAppConfig({ dataDir, onebot: { enabled: false }, qqOfficial: { enabled: true, appId: "app", appSecret: "" } }),
      disableBackgroundServices: true
    });
    assert(runtime.services?.qqOfficialClient);
    assert.equal(runtime.services!.config.qqOfficial.enabled, true);
  } finally {
    await runtime?.shutdown();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
