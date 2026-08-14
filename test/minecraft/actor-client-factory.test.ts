import test from "node:test";
import assert from "node:assert/strict";
import { ConfiguredMinecraftActorClientFactory } from "../../src/services/minecraft/actorClientFactory.ts";
import { MinecraftRuntimeTemplateCatalog } from "../../src/services/minecraft/runtimeTemplateCatalog.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createTestMinecraftBinding, createTestMinecraftRecoveryState } from "../helpers/minecraft-actor-test-support.ts";

test("template catalog 只匹配服务端允许的目标且拒绝歧义", () => {
  const config = createTestAppConfig({
    minecraft: {
      enabled: true,
      templates: {
        dev: template(["127.0.0.1:25566"])
      }
    }
  });
  const catalog = new MinecraftRuntimeTemplateCatalog(config);

  assert.equal(catalog.resolveForTarget({
    host: "127.0.0.1",
    port: 25566,
    address: "127.0.0.1:25566",
    key: "127.0.0.1:25566"
  }).templateId, "dev");
  assert.throws(() => catalog.resolveForTarget({
    host: "127.0.0.1",
    port: 25567,
    address: "127.0.0.1:25567",
    key: "127.0.0.1:25567"
  }), /不在受控允许列表/u);
});

test("恢复资源区分不可变运行模板与可热收敛策略", () => {
  const config = createTestAppConfig({
    minecraft: {
      enabled: true,
      templates: {
        dev: template(["127.0.0.1:25566"])
      }
    }
  });
  const catalog = new MinecraftRuntimeTemplateCatalog(config);
  const resolved = catalog.list()[0]!;
  const factory = new ConfiguredMinecraftActorClientFactory(config, catalog);
  const actor = createTestMinecraftRecoveryState({
    transportKind: "unix_socket",
    endpoint: "/run/mizune/runtime.sock",
    modelRefs: ["stale-model"],
    allowProgramDeployment: true,
    binding: createTestMinecraftBinding({
      templateId: resolved.templateId,
      templateFingerprint: resolved.fingerprint,
      identityRef: resolved.identityRef
    })
  });

  const reconciled = factory.reconcileRecoveryState(actor);
  assert.deepEqual(reconciled.modelRefs, ["main"]);
  assert.equal(reconciled.allowProgramDeployment, false);
  assert.doesNotThrow(() => factory.create({ resourceId: "res-1", actor: reconciled }));
  const stale = factory.reconcileRecoveryState({
    ...reconciled,
    binding: { ...reconciled.binding, templateFingerprint: "stale" }
  });
  assert.equal(stale.binding.provisionStatus, "needs_attention");
  assert.equal(stale.binding.failureCode, "template_changed");
  assert.throws(() => factory.create({
    resourceId: "res-1",
    actor: stale
  }), /尚未就绪/u);

  const extendedAllowlistConfig = createTestAppConfig({
    minecraft: {
      enabled: true,
      templates: { dev: template(["127.0.0.1:25566", "127.0.0.1:25567"]) }
    }
  });
  const extendedCatalog = new MinecraftRuntimeTemplateCatalog(extendedAllowlistConfig);
  assert.equal(extendedCatalog.resolveById("dev").fingerprint, resolved.fingerprint);
  assert.equal(
    new ConfiguredMinecraftActorClientFactory(extendedAllowlistConfig, extendedCatalog)
      .reconcileRecoveryState(reconciled).binding.provisionStatus,
    "ready"
  );

  const changedProfileConfig = createTestAppConfig({
    minecraft: {
      enabled: true,
      templates: {
        dev: { ...template(["127.0.0.1:25566"]), gameProfileId: "other-profile" }
      }
    }
  });
  const changedProfileCatalog = new MinecraftRuntimeTemplateCatalog(changedProfileConfig);
  const changedProfile = new ConfiguredMinecraftActorClientFactory(changedProfileConfig, changedProfileCatalog)
    .reconcileRecoveryState(reconciled);
  assert.equal(changedProfile.binding.provisionStatus, "needs_attention");
  assert.equal(changedProfile.binding.failureCode, "template_changed");
});

function template(allowedServers: string[]) {
  return {
    backend: "simulation" as const,
    minecraftVersion: "1.21.1",
    loader: "vanilla" as const,
    gameProfileId: "test-profile",
    identityRef: "test-identity",
    allowedServers,
    modelRefs: ["main"],
    allowAutonomyPolicyChange: false,
    allowProgramDeployment: false
  };
}
