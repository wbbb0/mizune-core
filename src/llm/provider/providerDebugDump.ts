import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import type { LlmProviderRequestContext } from "./providerTypes.ts";

export async function dumpProviderRequest(
  context: LlmProviderRequestContext,
  payload: {
    endpoint: string;
    requestBody: unknown;
    messages: unknown;
    force?: boolean;
  }
): Promise<void> {
  if (!payload.force && !context.config.llm.debugDump.enabled) {
    return;
  }

  await writeDebugDump(context, "request", {
    model: getPrimaryModelProfile(context.config, context.modelRef)?.model ?? null,
    modelRef: context.modelRef,
    resolvedModel: context.model,
    dumpedAt: new Date().toISOString(),
    endpoint: payload.endpoint,
    requestBody: payload.requestBody,
    messages: payload.messages
  });
}

export async function dumpProviderResponse(
  context: LlmProviderRequestContext,
  payload: unknown,
  options?: { force?: boolean }
): Promise<void> {
  if (!options?.force && !context.config.llm.debugDump.enabled) {
    return;
  }

  await writeDebugDump(context, "response", {
    model: getPrimaryModelProfile(context.config, context.modelRef)?.model ?? null,
    modelRef: context.modelRef,
    dumpedAt: new Date().toISOString(),
    ...((typeof payload === "object" && payload != null) ? payload : { payload })
  });
}

async function writeDebugDump(
  context: LlmProviderRequestContext,
  kind: "request" | "response",
  payload: unknown
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");
  const effectiveDataDir = context.config.dataDir === "data"
    ? join("data", context.config.configRuntime.instanceName)
    : context.config.dataDir;
  const dumpDir = resolve(process.cwd(), effectiveDataDir, "dump");
  const filePath = join(dumpDir, kind === "request" ? "last-request.json" : "last-response.json");
  await mkdir(dumpDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}
