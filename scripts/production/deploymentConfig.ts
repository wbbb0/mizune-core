import { readFile } from "node:fs/promises";
import YAML from "yaml";

export interface ProductionInstance {
  name: string;
  healthUrl: string;
  enableOnBoot?: boolean;
}

export interface ProductionDeploymentConfig {
  instances: ProductionInstance[];
  retainReleases: number;
  healthTimeoutMs: number;
}

function requirePositiveInteger(value: unknown, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || Number(resolved) <= 0) {
    throw new Error(`${field} 必须是正整数`);
  }
  return Number(resolved);
}

export function parseProductionDeploymentConfig(value: unknown): ProductionDeploymentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("正式部署配置必须是对象");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.instances) || record.instances.length === 0) {
    throw new Error("正式部署配置至少需要一个 instances 条目");
  }

  const names = new Set<string>();
  const instances = record.instances.map((item, index): ProductionInstance => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`instances[${index}] 必须是对象`);
    }
    const candidate = item as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error(`instances[${index}].name 不合法`);
    }
    if (name === "dev" || name.startsWith("dev-")) {
      throw new Error(`开发实例 ${name} 不能加入正式部署清单`);
    }
    if (names.has(name)) {
      throw new Error(`正式实例 ${name} 重复`);
    }
    names.add(name);

    const healthUrl = typeof candidate.healthUrl === "string" ? candidate.healthUrl.trim() : "";
    const parsedUrl = new URL(healthUrl);
    if (parsedUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)) {
      throw new Error(`instances[${index}].healthUrl 必须是本机 HTTP 地址`);
    }
    if (parsedUrl.pathname !== "/healthz") {
      throw new Error(`instances[${index}].healthUrl 必须指向 /healthz`);
    }

    const enableOnBoot = candidate.enableOnBoot;
    if (enableOnBoot !== undefined && typeof enableOnBoot !== "boolean") {
      throw new Error(`instances[${index}].enableOnBoot 必须是布尔值`);
    }
    return {
      name,
      healthUrl: parsedUrl.href,
      ...(enableOnBoot === undefined ? {} : { enableOnBoot })
    };
  });

  return {
    instances,
    retainReleases: requirePositiveInteger(record.retainReleases, 3, "retainReleases"),
    healthTimeoutMs: requirePositiveInteger(record.healthTimeoutMs, 30_000, "healthTimeoutMs")
  };
}

export async function loadProductionDeploymentConfig(path: string): Promise<ProductionDeploymentConfig> {
  const source = await readFile(path, "utf8");
  return parseProductionDeploymentConfig(YAML.parse(source));
}
