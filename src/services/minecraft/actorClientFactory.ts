import { isDeepStrictEqual } from "node:util";
import type { AppConfig } from "#config/config.ts";
import type { MinecraftActorRecoveryState } from "#runtime/resources/resourceTypes.ts";
import { ProtocolMinecraftActorClient, type MinecraftActorClient } from "./actorClient.ts";
import type { MinecraftActorClientFactory } from "./actorResourceManager.ts";
import type { MinecraftActorProvisioningStore } from "./actorProvisioningStore.ts";
import type {
  MinecraftRuntimeTemplateCatalog,
  ResolvedMinecraftRuntimeTemplate
} from "./runtimeTemplateCatalog.ts";
import { parseMinecraftServerAddress } from "./serverTarget.ts";
import { UnixSocketMinecraftActorTransport } from "./unixSocketTransport.ts";

export class ConfiguredMinecraftActorClientFactory implements MinecraftActorClientFactory {
  constructor(
    private readonly config: AppConfig,
    private readonly templates: MinecraftRuntimeTemplateCatalog,
    private readonly provisioningStore: Pick<MinecraftActorProvisioningStore, "getActiveIncarnation">
  ) {}

  async create(input: {
    resourceId: string;
    actor: MinecraftActorRecoveryState;
  }): Promise<MinecraftActorClient> {
    const actor = this.reconcileRecoveryState(input.actor);
    if (actor.binding.desiredState !== "open" || actor.binding.provisionStatus !== "ready") {
      throw new Error(`Minecraft Actor Runtime 尚未就绪：${input.resourceId}`);
    }
    if (actor.transportKind !== "unix_socket" || actor.protocolVersion !== 2) {
      throw new Error(`Minecraft Actor transport 不受当前运行时支持：${actor.transportKind}`);
    }
    await this.requireActiveIncarnation(input.resourceId, actor.endpoint);
    const transport = new UnixSocketMinecraftActorTransport({
      socketPath: actor.endpoint,
      actorId: actor.actorId,
      requestTimeoutMs: this.config.minecraft.requestTimeoutMs,
      connectTimeoutMs: this.config.minecraft.connectTimeoutMs,
      maxFrameBytes: this.config.minecraft.maxFrameBytes,
      resolveRuntimeCredentials: async () => {
        const current = await this.requireActiveIncarnation(input.resourceId, actor.endpoint);
        return {
          runtimeInstanceId: current.runtimeInstanceId,
          authTokenFile: current.tokenFile
        };
      }
    });
    return new ProtocolMinecraftActorClient(actor.actorId, transport);
  }

  private async requireActiveIncarnation(resourceId: string, socketPath: string) {
    const incarnation = await this.provisioningStore.getActiveIncarnation(resourceId);
    if (
      !incarnation
      || incarnation.status !== "running"
      || incarnation.socketPath !== socketPath
    ) {
      throw new Error(`Minecraft Actor Runtime 实例身份尚未就绪：${resourceId}`);
    }
    return incarnation;
  }

  reconcileRecoveryState(actor: MinecraftActorRecoveryState): MinecraftActorRecoveryState {
    const target = parseMinecraftServerAddress(actor.binding.serverAddress);
    let template: ResolvedMinecraftRuntimeTemplate;
    try {
      template = this.templates.resolveById(actor.binding.templateId);
    } catch {
      return needsAttention(actor, "template_missing", "绑定的 Minecraft 运行模板已不存在");
    }
    const withCurrentPolicy = {
      ...actor,
      modelRefs: [...template.modelRefs],
      allowAutonomyPolicyChange: template.allowAutonomyPolicyChange,
      allowProgramDeployment: template.allowProgramDeployment
    };
    if (!this.templates.allowsTarget(template, target)) {
      return needsAttention(withCurrentPolicy, "server_not_allowed", "目标服务器已不在运行模板允许列表中");
    }
    if (
      template.fingerprint !== actor.binding.templateFingerprint
      || template.identityRef !== actor.binding.identityRef
      || template.backend !== actor.binding.backend
    ) {
      return needsAttention(withCurrentPolicy, "template_changed", "Minecraft Runtime 的不可变模板参数已变化");
    }
    if (
      isDeepStrictEqual(template.modelRefs, actor.modelRefs)
      && template.allowAutonomyPolicyChange === actor.allowAutonomyPolicyChange
      && template.allowProgramDeployment === actor.allowProgramDeployment
    ) {
      return actor;
    }
    return withCurrentPolicy;
  }
}

function needsAttention(
  actor: MinecraftActorRecoveryState,
  failureCode: string,
  failureMessage: string
): MinecraftActorRecoveryState {
  return {
    ...actor,
    binding: {
      ...actor.binding,
      provisionStatus: "needs_attention",
      provisionPhase: "resolving_template",
      failureCode,
      failureMessage,
      retryAtMs: null,
      attemptId: null
    }
  };
}
