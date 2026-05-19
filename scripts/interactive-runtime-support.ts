import type { AppConfig } from "#config/config.ts";
import type { AppServiceBootstrap } from "#app/bootstrap/appServiceBootstrap.ts";

export interface InteractiveRuntimeConfigArgs {
  routingPreset?: string;
  dataDir?: string;
  useInstanceData: boolean;
  enableShell?: boolean;
  enableBrowser?: boolean;
  enableComfy?: boolean;
  enableSearch?: boolean;
  enableInternalApi?: boolean;
  quiet?: boolean;
}

export interface InteractiveRuntimeActor {
  userId: string;
}

export function suppressProcessWarnings(): void {
  process.emitWarning = (() => undefined) as typeof process.emitWarning;
}

export function createInteractiveConfig(config: AppConfig, args: InteractiveRuntimeConfigArgs): AppConfig {
  const dataDir = args.useInstanceData
    ? config.dataDir
    : args.dataDir ?? `data/interactive-${config.configRuntime.instanceName}`;
  const enableSearch = args.enableSearch === true;
  return {
    ...config,
    dataDir,
    ...(args.quiet === true ? { logLevel: "silent" } : {}),
    llm: {
      ...config.llm,
      ...(args.routingPreset ? { routingPreset: args.routingPreset } : {})
    },
    whitelist: {
      enabled: false
    },
    onebot: {
      ...config.onebot,
      enabled: true,
      wsUrl: "ws://127.0.0.1/interactive-fake-onebot",
      httpUrl: "http://127.0.0.1/interactive-fake-onebot"
    },
    internalApi: {
      ...config.internalApi,
      enabled: args.enableInternalApi === true,
      webui: {
        ...config.internalApi.webui,
        enabled: args.enableInternalApi === true
      }
    },
    scheduler: {
      ...config.scheduler,
      enabled: false
    },
    shell: {
      ...config.shell,
      enabled: args.enableShell === true
    },
    browser: {
      ...config.browser,
      enabled: args.enableBrowser === true
    },
    comfy: {
      ...config.comfy,
      enabled: args.enableComfy === true
    },
    search: {
      ...config.search,
      googleGrounding: {
        ...config.search.googleGrounding,
        enabled: enableSearch && config.search.googleGrounding.enabled
      },
      aliyunIqs: {
        ...config.search.aliyunIqs,
        enabled: enableSearch && config.search.aliyunIqs.enabled
      }
    },
    conversation: {
      ...config.conversation,
      setup: {
        ...config.conversation.setup,
        skipPersonaInitialization: true
      },
      debounce: {
        ...config.conversation.debounce,
        defaultBaseSeconds: 0.1,
        minBaseSeconds: 0.1,
        maxBaseSeconds: 0.2,
        finalMultiplier: 1,
        plannerWaitMultiplier: 1,
        randomRatioMin: 1,
        randomRatioMax: 1
      },
      outbound: {
        ...config.conversation.outbound,
        disableStreamingSplit: true,
        baseDelayMs: 0,
        charDelayMs: 0,
        maxDelayMs: 0,
        randomFactorMin: 1,
        randomFactorMax: 1
      }
    }
  };
}

export async function prepareInteractiveRuntime(
  services: AppServiceBootstrap,
  actor: InteractiveRuntimeActor
): Promise<void> {
  const channelId = services.config.configRuntime.instanceName;
  const currentUserInternalId = await services.userIdentityStore.findInternalUserId({
    channelId,
    externalId: actor.userId
  });
  if (!await services.userIdentityStore.hasOwnerIdentity()) {
    if (!currentUserInternalId) {
      await services.userIdentityStore.bindOwnerIdentity({
        channelId,
        externalId: actor.userId
      });
    } else if (currentUserInternalId !== "owner") {
      await services.userIdentityStore.bindOwnerIdentity({
        channelId,
        externalId: `${actor.userId}:interactive-owner`
      });
    }
  }
  await services.setupStore.advanceAfterOwnerBound(await services.personaStore.get());
  await services.globalProfileReadinessStore.setPersonaReadiness("ready");
  await services.globalProfileReadinessStore.setRpReadiness("ready");
  await services.globalProfileReadinessStore.setScenarioReadiness("ready");
}

export async function resolveActiveInternalUserId(
  actor: InteractiveRuntimeActor,
  services: AppServiceBootstrap
): Promise<string> {
  return await services.userIdentityStore.findInternalUserId({
    channelId: services.config.configRuntime.instanceName,
    externalId: actor.userId
  }) ?? actor.userId;
}
