import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RuntimeResourceRecord } from "#runtime/resources/resourceTypes.ts";
import type { MinecraftActorRequestPriority } from "./actorControlStore.ts";
import type { MinecraftActorProvisioningStore } from "./actorProvisioningStore.ts";
import type { MinecraftRuntimeTemplateCatalog } from "./runtimeTemplateCatalog.ts";
import { parseMinecraftServerAddress } from "./serverTarget.ts";
import type { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";

export interface MinecraftActorDelegateInput {
  serverAddress: string;
  instruction: string;
  ownerSessionId: string;
  ownerPrincipalId: string;
  idempotencyKey: string;
  constraints?: string | null;
  priority?: MinecraftActorRequestPriority;
  title?: string | null;
}

export interface MinecraftActorDelegateResult {
  resource: RuntimeResourceRecord;
  requestId: string;
  revision: number;
  created: boolean;
  replayed: boolean;
}

export class MinecraftActorProvisioningService {
  constructor(
    private readonly templates: MinecraftRuntimeTemplateCatalog,
    private readonly store: MinecraftActorProvisioningStore,
    private readonly registry: RuntimeResourceRegistry,
    private readonly runtimeDir: string,
    private readonly now: () => number = Date.now
  ) {}

  async delegate(input: MinecraftActorDelegateInput): Promise<MinecraftActorDelegateResult> {
    const target = parseMinecraftServerAddress(input.serverAddress);
    const template = this.templates.resolveForTarget(target);
    const resourceId = `res_minecraft_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const actorId = `mc_actor_${randomUUID().replaceAll("-", "")}`;
    const endpoint = resolve(this.runtimeDir, resourceId, "runtime.sock");
    const title = input.title?.trim() || target.address;
    const receipt = await this.store.delegate({
      resourceId,
      ownerPrincipalId: input.ownerPrincipalId,
      ownerSessionId: input.ownerSessionId,
      idempotencyKey: input.idempotencyKey,
      title,
      summary: `正在准备连接 ${target.address}`,
      instruction: input.instruction,
      ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      nowMs: this.now(),
      actor: {
        actorId,
        transportKind: "unix_socket",
        endpoint,
        protocolVersion: 2,
        persistentState: template.initialPersistentState,
        currentGoal: input.instruction,
        modelRefs: [...template.modelRefs],
        allowAutonomyPolicyChange: template.allowAutonomyPolicyChange,
        allowProgramDeployment: template.allowProgramDeployment,
        lastEventSequence: 0,
        binding: {
          serverAddress: target.address,
          serverHost: target.host,
          serverPort: target.port,
          serverKey: target.key,
          templateId: template.templateId,
          templateFingerprint: template.fingerprint,
          identityRef: template.identityRef,
          backend: template.backend,
          desiredState: "open",
          provisionStatus: "pending",
          provisionPhase: "validating_target",
          failureCode: null,
          failureMessage: null,
          retryAtMs: null,
          attemptId: null
        }
      }
    });
    const resource = await this.registry.get(receipt.resourceId);
    if (!resource?.minecraftActor) {
      throw new Error(`Minecraft Actor 委派事务未创建资源：${receipt.resourceId}`);
    }
    return { resource, ...receipt };
  }
}
