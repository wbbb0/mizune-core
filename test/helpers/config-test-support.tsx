import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";

export async function withTempDir(name: string, fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function withConfigDir(name: string, fn: (configDir: string) => Promise<void>) {
  await withTempDir(name, fn);
}

export async function writeYaml(filePath: string, value: unknown) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, YAML.stringify(value), "utf8");
}

export async function writeDefaultInstanceYaml(configDir: string, value: Record<string, unknown> = {}) {
  await writeYaml(join(configDir, "instances", "default.yml"), value);
}

export async function writeLlmCatalog(
  configDir: string,
  value: {
    providers?: Record<string, unknown>;
    models?: Record<string, unknown>;
    routingPresets?: Record<string, unknown>;
  } = {}
) {
  await writeYaml(join(configDir, "llm.providers.yml"), value.providers ?? {});
  await writeYaml(join(configDir, "llm.models.yml"), value.models ?? {});
  await writeYaml(join(configDir, "llm.routing-presets.yml"), value.routingPresets ?? {});
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
