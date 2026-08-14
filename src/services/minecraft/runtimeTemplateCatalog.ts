import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AppConfig } from "#config/config.ts";
import { parseMinecraftServerAddress, type MinecraftServerTarget } from "./serverTarget.ts";

const RESERVED_CLIENT_ENVIRONMENT = new Set([
  "MIZUNE_BRIDGE_CONTROL_TOKEN",
  "MIZUNE_RUNTIME_INSTANCE_ID",
  "MIZUNE_BRIDGE_DESCRIPTOR_FILE",
  "MIZUNE_MC_SERVER",
  "MIZUNE_MC_GAME_DIRECTORY"
]);

export interface ResolvedMinecraftClientProfile {
  profileId: string;
  identityRef: string;
  executable: string;
  arguments: string[];
  workingDirectory: string;
  gameDirectory: string;
  environment: Record<string, string>;
}

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
  clientProfile: ResolvedMinecraftClientProfile | null;
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
      const clientProfile = template.backend === "neoforge"
        ? this.resolveClientProfile(templateId, template.gameProfileId, template.identityRef)
        : null;
      if (template.backend === "neoforge" && template.loader !== "neoforge") {
        throw new Error(`Minecraft 运行模板 ${templateId} 的 NeoForge 后端必须使用 neoforge loader`);
      }
      const canonical = {
        backend: template.backend,
        minecraftVersion: template.minecraftVersion,
        loader: template.loader,
        gameProfileId: template.gameProfileId,
        identityRef: template.identityRef,
        clientProfile
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
        allowedTargets: template.allowedServers.map(parseMinecraftServerAddress),
        clientProfile
      };
    });
  }

  private resolveClientProfile(
    templateId: string,
    profileId: string,
    identityRef: string
  ): ResolvedMinecraftClientProfile {
    const profile = this.config.minecraft.clientProfiles[profileId];
    if (!profile) {
      throw new Error(`Minecraft 运行模板 ${templateId} 引用了不存在的客户端档案：${profileId}`);
    }
    if (profile.identityRef !== identityRef) {
      throw new Error(`Minecraft 运行模板 ${templateId} 的账号引用与客户端档案 ${profileId} 不一致`);
    }
    if (profile.arguments.length > 128) {
      throw new Error(`Minecraft 客户端档案 ${profileId} 的启动参数不能超过 128 项`);
    }
    if (profile.arguments.some(argument => !argument || argument.length > 4_096 || argument.includes("\0"))) {
      throw new Error(`Minecraft 客户端档案 ${profileId} 含有无效的启动参数`);
    }
    for (const [label, value] of [
      ["executable", profile.executable],
      ["workingDirectory", profile.workingDirectory],
      ["gameDirectory", profile.gameDirectory]
    ] as const) {
      if (!isAbsolute(value)) {
        throw new Error(`Minecraft 客户端档案 ${profileId} 的 ${label} 必须为绝对路径`);
      }
      if (value.length > 4_096 || value.includes("\0")) {
        throw new Error(`Minecraft 客户端档案 ${profileId} 的 ${label} 超出限制`);
      }
    }
    if (Object.keys(profile.environment).length > 64) {
      throw new Error(`Minecraft 客户端档案 ${profileId} 的环境变量不能超过 64 项`);
    }
    for (const key of Object.keys(profile.environment)) {
      const value = String(profile.environment[key]);
      if (
        key.length > 128
        || RESERVED_CLIENT_ENVIRONMENT.has(key)
        || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
        || value.length > 4_096
        || value.includes("\0")
      ) {
        throw new Error(`Minecraft 客户端档案 ${profileId} 含有不允许的环境变量：${key}`);
      }
    }
    return {
      profileId,
      identityRef: profile.identityRef,
      executable: profile.executable,
      arguments: [...profile.arguments],
      workingDirectory: profile.workingDirectory,
      gameDirectory: profile.gameDirectory,
      environment: Object.fromEntries(Object.entries(profile.environment)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, String(value)]))
    };
  }
}
