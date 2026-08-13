import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ConfiguredMinecraftActorClientFactory } from "../../src/services/minecraft/actorClientFactory.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("configured factory 以 configDir 解析 socket 并拒绝不在 allowlist 的 endpoint", () => {
  const config = createTestAppConfig({
    minecraft: {
      enabled: true,
      endpoints: {
        dev: {
          actorId: "actor-dev",
          socketPath: "../data/dev/runtime.sock",
          modelRefs: ["main"]
        }
      }
    }
  });
  const factory = new ConfiguredMinecraftActorClientFactory(config);
  const endpoint = factory.resolveEndpoint("dev");

  assert.equal(endpoint.actor.endpoint, resolve(config.configRuntime.configDir, "../data/dev/runtime.sock"));
  assert.throws(() => factory.resolveEndpoint("unknown"), /不在服务端允许列表/u);
});

test("恢复资源必须继续符合当前模型与权限配置", () => {
  const config = createTestAppConfig({
    minecraft: {
      enabled: true,
      endpoints: {
        dev: {
          actorId: "actor-dev",
          socketPath: "/run/mizune/runtime.sock",
          modelRefs: ["main"],
          allowAutonomyPolicyChange: false,
          allowProgramDeployment: false
        }
      }
    }
  });
  const factory = new ConfiguredMinecraftActorClientFactory(config);
  const actor = factory.resolveEndpoint("dev").actor;

  assert.doesNotThrow(() => factory.create({ resourceId: "res-1", actor }));
  assert.deepEqual(factory.reconcileRecoveryState({
    ...actor,
    modelRefs: ["another-model"],
    allowProgramDeployment: true
  }), actor);
  assert.throws(() => factory.create({
    resourceId: "res-1",
    actor: { ...actor, allowProgramDeployment: true }
  }), /恢复策略与当前 endpoint 配置不一致/u);
  assert.throws(() => factory.create({
    resourceId: "res-1",
    actor: { ...actor, modelRefs: ["another-model"] }
  }), /恢复策略与当前 endpoint 配置不一致/u);
});
