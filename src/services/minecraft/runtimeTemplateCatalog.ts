import { createHash } from "node:crypto";
import type { AppConfig } from "#config/config.ts";
import { parseMinecraftServerAddress, type MinecraftServerTarget } from "./serverTarget.ts";

export interface ResolvedMinecraftRuntimeTemplate {
  templateId: string;
  fingerprint: string;
  backend: "simulation" | "neoforge";
  minecraftVersion: string;
  loader: "vanilla" | "neoforge" | "fabric";
  gameProfileId: string;
  identityRef: string;
  modelRefs: string[];
  allowAutonomyPolicyChange: boolean;
  allowProgramDeployment: boolean;
  initialPersistentState: string;
  allowedTargets: MinecraftServerTarget[];
}

export class MinecraftRuntimeTemplateCatalog {
  constructor(private readonly config: AppConfig) {}

  resolveForTarget(target: MinecraftServerTarget): ResolvedMinecraftRuntimeTemplate {
    if (!this.config.minecraft.enabled) throw new Error("Minecraft Actor 功能未启用");
    const matches = this.list().filter(template => (
      template.allowedTargets.some(allowed => allowed.key === target.key)
    ));
    if (matches.length === 0) {
      throw new Error(`Minecraft 服务器不在受控允许列表中：${target.address}`);
    }
    if (matches.length > 1) {
      throw new Error(`Minecraft 服务器匹配多个运行模板，服务端配置必须消除歧义：${target.address}`);
    }
    return matches[0]!;
  }

  resolveById(templateId: string): ResolvedMinecraftRuntimeTemplate {
    const template = this.list().find(candidate => candidate.templateId === templateId);
    if (!template) throw new Error(`Minecraft 运行模板不存在：${templateId}`);
    return template;
  }

  allowsTarget(template: ResolvedMinecraftRuntimeTemplate, target: MinecraftServerTarget): boolean {
    return template.allowedTargets.some(allowed => allowed.key === target.key);
  }

  list(): ResolvedMinecraftRuntimeTemplate[] {
    if (!this.config.minecraft.enabled) return [];
    return Object.entries(this.config.minecraft.templates).map(([templateId, template]) => {
      if (template.modelRefs.length === 0) {
        throw new Error(`Minecraft 运行模板 ${templateId} 未配置决策模型`);
      }
      const canonical = {
        backend: template.backend,
        minecraftVersion: template.minecraftVersion,
        loader: template.loader,
        gameProfileId: template.gameProfileId,
        identityRef: template.identityRef
      };
      return {
        templateId,
        fingerprint: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
        backend: template.backend,
        minecraftVersion: template.minecraftVersion,
        loader: template.loader,
        gameProfileId: template.gameProfileId,
        identityRef: template.identityRef,
        modelRefs: [...template.modelRefs],
        allowAutonomyPolicyChange: template.allowAutonomyPolicyChange,
        allowProgramDeployment: template.allowProgramDeployment,
        initialPersistentState: template.initialPersistentState,
        allowedTargets: template.allowedServers.map(parseMinecraftServerAddress)
      };
    });
  }
}
