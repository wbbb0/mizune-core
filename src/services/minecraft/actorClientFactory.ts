import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AppConfig } from "#config/config.ts";
import type { MinecraftActorRecoveryState } from "#runtime/resources/resourceTypes.ts";
import { ProtocolMinecraftActorClient, type MinecraftActorClient } from "./actorClient.ts";
import type { MinecraftActorClientFactory } from "./actorResourceManager.ts";
import { UnixSocketMinecraftActorTransport } from "./unixSocketTransport.ts";

export interface ResolvedMinecraftActorEndpoint {
  endpointId: string;
  actor: MinecraftActorRecoveryState;
}

export class ConfiguredMinecraftActorClientFactory implements MinecraftActorClientFactory {
  constructor(private readonly config: AppConfig) {}

  resolveEndpoint(endpointId: string): ResolvedMinecraftActorEndpoint {
    const normalizedId = endpointId.trim();
    if (!normalizedId) throw new Error("Minecraft endpoint_id 不能为空");
    if (!this.config.minecraft.enabled) throw new Error("Minecraft Actor 功能未启用");
    const configured = this.config.minecraft.endpoints[normalizedId];
    if (!configured) throw new Error(`Minecraft endpoint 不在服务端允许列表：${normalizedId}`);
    if (configured.modelRefs.length === 0) {
      throw new Error(`Minecraft endpoint ${normalizedId} 未配置决策模型`);
    }
    const socketPath = resolveSocketPath(this.config.configRuntime.configDir, configured.socketPath);
    return {
      endpointId: normalizedId,
      actor: {
        actorId: configured.actorId,
        transportKind: "unix_socket",
        endpoint: socketPath,
        protocolVersion: 1,
        persistentState: configured.initialPersistentState,
        currentGoal: configured.initialGoal,
        modelRefs: [...configured.modelRefs],
        allowAutonomyPolicyChange: configured.allowAutonomyPolicyChange,
        allowProgramDeployment: configured.allowProgramDeployment,
        lastEventSequence: 0
      }
    };
  }

  listEndpointIds(): string[] {
    return this.config.minecraft.enabled ? Object.keys(this.config.minecraft.endpoints).sort() : [];
  }

  create(input: {
    resourceId: string;
    actor: MinecraftActorRecoveryState;
  }): MinecraftActorClient {
    const endpoint = this.findAllowedRecoveryEndpoint(input.actor);
    const transport = new UnixSocketMinecraftActorTransport({
      socketPath: endpoint.actor.endpoint,
      actorId: endpoint.actor.actorId,
      requestTimeoutMs: this.config.minecraft.requestTimeoutMs,
      connectTimeoutMs: this.config.minecraft.connectTimeoutMs,
      maxFrameBytes: this.config.minecraft.maxFrameBytes
    });
    return new ProtocolMinecraftActorClient(endpoint.actor.actorId, transport);
  }

  reconcileRecoveryState(actor: MinecraftActorRecoveryState): MinecraftActorRecoveryState {
    const endpoint = this.findRecoveryEndpointByIdentity(actor);
    return {
      ...actor,
      modelRefs: [...endpoint.actor.modelRefs],
      allowAutonomyPolicyChange: endpoint.actor.allowAutonomyPolicyChange,
      allowProgramDeployment: endpoint.actor.allowProgramDeployment
    };
  }

  private findAllowedRecoveryEndpoint(actor: MinecraftActorRecoveryState): ResolvedMinecraftActorEndpoint {
    const resolved = this.findRecoveryEndpointByIdentity(actor);
    if (
      !isDeepStrictEqual(resolved.actor.modelRefs, actor.modelRefs)
      || resolved.actor.allowAutonomyPolicyChange !== actor.allowAutonomyPolicyChange
      || resolved.actor.allowProgramDeployment !== actor.allowProgramDeployment
    ) {
      throw new Error(`Minecraft Actor 恢复策略与当前 endpoint 配置不一致：${actor.actorId}`);
    }
    return resolved;
  }

  private findRecoveryEndpointByIdentity(actor: MinecraftActorRecoveryState): ResolvedMinecraftActorEndpoint {
    if (actor.transportKind !== "unix_socket" || actor.protocolVersion !== 1) {
      throw new Error(`Minecraft Actor transport 不受当前运行时支持：${actor.transportKind}`);
    }
    for (const endpointId of Object.keys(this.config.minecraft.endpoints)) {
      const resolved = this.resolveEndpoint(endpointId);
      if (resolved.actor.actorId === actor.actorId && resolved.actor.endpoint === actor.endpoint) {
        return resolved;
      }
    }
    throw new Error(`Minecraft Actor 恢复端点已不在服务端允许列表：${actor.actorId}`);
  }
}

function resolveSocketPath(configDir: string, socketPath: string): string {
  const normalized = socketPath.trim();
  if (!normalized || normalized.includes("\0")) throw new Error("Minecraft socketPath 无效");
  return isAbsolute(normalized) ? resolve(normalized) : resolve(configDir, normalized);
}
