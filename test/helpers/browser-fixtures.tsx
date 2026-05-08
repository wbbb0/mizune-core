import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import type { BrowserService } from "../../src/services/web/browser/browserService.ts";
import type {
  OpenPageResult,
  BrowserRenderResult,
  ClosePageResult,
  InspectPageResult,
  InteractWithPageResult,
  BrowserInteractionSuccessResult
} from "../../src/services/web/browser/types.ts";

export function createBrowserRenderResult(
  overrides: Partial<BrowserRenderResult> = {}
): BrowserRenderResult {
  return {
    resource_id: "res_browser_1",
    backend: "playwright",
    profile_id: null,
    requestedUrl: "https://openai.com",
    resolvedUrl: "https://openai.com",
    title: "OpenAI",
    contentType: "text/html",
    lines: ["L1 OpenAI homepage"],
    links: [],
    elements: [],
    lineStart: 1,
    lineEnd: 1,
    truncated: false,
    ...overrides
  };
}

export function createBrowserOpenResult(
  overrides: Partial<OpenPageResult> = {}
): OpenPageResult {
  return {
    ok: true,
    ...createBrowserRenderResult(),
    ...overrides
  };
}

export function createBrowserInspectResult(
  overrides: Partial<InspectPageResult> = {}
): InspectPageResult {
  return {
    ok: true,
    ...createBrowserRenderResult(),
    pattern: null,
    matches: [],
    ...overrides
  };
}

export function createBrowserInteractResult(
  overrides: Partial<BrowserInteractionSuccessResult> = {}
): InteractWithPageResult {
  return {
    ok: true as const,
    resource_id: "res_browser_1",
    action: "click",
    snapshot: createBrowserInspectResult(),
    resolved_target: null,
    candidate_count: 0,
    disambiguation_required: false,
    candidates: [],
    message: "已执行页面动作：click。",
    ...overrides
  } as InteractWithPageResult;
}

export function createBrowserCloseResult(
  overrides: Partial<ClosePageResult> = {}
): ClosePageResult {
  return {
    ok: true,
    resource_id: "res_browser_1",
    closed: true,
    ...overrides
  };
}

export function createBrowserToolContext(
  browserService: Partial<BrowserService>
): BuiltinToolContext {
  const resolvedBrowserService = {
    ...browserService,
    async resolveDownloadAssetSource(input: any) {
      return {
        ok: true,
        source_url: input.url ?? "https://example.com/download.bin",
        source_name: input.sourceName ?? null,
        kind: input.kind ?? null,
        resource_id: input.resourceId ?? null,
        target_id: input.targetId ?? null
      };
    }
  };
  return {
    browserService: resolvedBrowserService as unknown as BuiltinToolContext["browserService"],
    config: null as unknown as BuiltinToolContext["config"],
    relationship: "owner",
    replyDelivery: "onebot",
    lastMessage: {
      sessionId: "qqbot:p:test",
      userId: "10001",
      senderName: "Tester"
    },
    currentUser: null,
    oneBotClient: null as unknown as BuiltinToolContext["oneBotClient"],
    audioStore: null as unknown as BuiltinToolContext["audioStore"],
    mediaVisionService: {
      async prepareFileForModel(fileId: string) {
        return {
          fileId,
          inputUrl: `data:image/png;base64,${fileId}`,
          kind: "image" as const,
          transport: "data_url" as const,
          animated: false,
          durationMs: null,
          sampledFrameCount: null
        };
      }
    } as unknown as BuiltinToolContext["mediaVisionService"],
    mediaCaptionService: {
      async getCaptionMap() {
        return new Map<string, string>();
      }
    } as unknown as BuiltinToolContext["mediaCaptionService"],
    mediaInspectionService: {
      async inspectPreparedMedia() {
        return {
          ok: true,
          requestedCount: 0,
          results: []
        };
      }
    } as unknown as BuiltinToolContext["mediaInspectionService"],
    textInspectionService: {
      async inspectPreparedText() {
        return {
          ok: true,
          requestedCount: 0,
          results: []
        };
      }
    } as unknown as BuiltinToolContext["textInspectionService"],
    chatFileStore: {
      async prepareImageFileForModel(fileId: string) {
        return {
          file: {
            fileId,
            fileRef: `shot_${fileId.slice(-8)}.png`,
            kind: "image",
            origin: "browser_screenshot",
            chatFilePath: `workspace/media/${fileId}.png`,
            sourceName: `${fileId}.png`,
            mimeType: "image/png",
            sizeBytes: 4,
            createdAtMs: Date.now(),
            sourceContext: {},
            legacyImageId: fileId,
            caption: null
          },
          inputUrl: `data:image/png;base64,${fileId}`,
          caption: null
        };
      },
      async getMany() {
        return [];
      },
      async getFile(fileId: string) {
        return {
          fileId,
          fileRef: `shot_${fileId.slice(-8)}.png`,
          kind: "image" as const,
          origin: "browser_screenshot" as const,
          chatFilePath: `workspace/media/${fileId}.png`,
          sourceName: `${fileId}.png`,
          mimeType: "image/png",
          sizeBytes: 4,
          createdAtMs: Date.now(),
          sourceContext: {},
          caption: null
        };
      },
      async resolveAbsolutePath() {
        return "/tmp/fake.png";
      },
      async importRemoteSource() {
        return {
          fileId: "file_1",
          fileRef: "file_1.bin",
          kind: "file" as const,
          sourceName: "downloaded.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 1
        };
      }
    } as unknown as BuiltinToolContext["chatFileStore"],
    downloadRuntime: {
      async start(input: any) {
        const downloaded = await (browserService.downloadAsset as any)?.({
          url: input.sourceUrl,
          sourceName: input.sourceName,
          kind: input.kind,
          resourceId: input.sourceContext?.resource_id,
          targetId: input.sourceContext?.target_id
        });
        return {
          ok: true,
          resource_id: "res_download_1",
          status: "completed",
          source_url: input.sourceUrl,
          source_name: input.sourceName ?? downloaded?.source_name ?? null,
          origin: input.origin,
          downloaded_bytes: downloaded?.sizeBytes ?? 0,
          total_bytes: downloaded?.sizeBytes ?? null,
          percent: 100,
          mime_type: downloaded?.mimeType ?? null,
          file_id: downloaded?.file_id ?? "file_1",
          file_ref: null,
          chat_file_path: null,
          kind: downloaded?.kind ?? input.kind ?? "file",
          size_bytes: downloaded?.sizeBytes ?? null,
          error: null,
          created_at_ms: Date.now(),
          updated_at_ms: Date.now()
        };
      },
      list() {
        return [];
      }
    } as unknown as BuiltinToolContext["downloadRuntime"],
    forwardResolver: null as unknown as BuiltinToolContext["forwardResolver"],
    requestStore: null as unknown as BuiltinToolContext["requestStore"],
    sessionManager: null as unknown as BuiltinToolContext["sessionManager"],
    whitelistStore: null as unknown as BuiltinToolContext["whitelistStore"],
    userStore: null as unknown as BuiltinToolContext["userStore"],
    contextStore: null as unknown as BuiltinToolContext["contextStore"],
    personaStore: null as unknown as BuiltinToolContext["personaStore"],
    globalRuleStore: null as unknown as BuiltinToolContext["globalRuleStore"],
    toolsetRuleStore: null as unknown as BuiltinToolContext["toolsetRuleStore"],
    scenarioHostStateStore: null as unknown as BuiltinToolContext["scenarioHostStateStore"],
    setupStore: null as unknown as BuiltinToolContext["setupStore"],
    globalProfileReadinessStore: null as unknown as BuiltinToolContext["globalProfileReadinessStore"],
    conversationAccess: null as unknown as BuiltinToolContext["conversationAccess"],
    npcDirectory: null as unknown as BuiltinToolContext["npcDirectory"],
    scheduledJobStore: null as unknown as BuiltinToolContext["scheduledJobStore"],
    scheduler: null as unknown as BuiltinToolContext["scheduler"],
    messageQueue: null as unknown as BuiltinToolContext["messageQueue"],
    shellRuntime: null as unknown as BuiltinToolContext["shellRuntime"],
    searchService: null as unknown as BuiltinToolContext["searchService"],
    comfyClient: null as unknown as BuiltinToolContext["comfyClient"],
    comfyTaskStore: null as unknown as BuiltinToolContext["comfyTaskStore"],
    comfyTemplateCatalog: null as unknown as BuiltinToolContext["comfyTemplateCatalog"],
    localFileService: {
      resolvePath(relativePath = ".") {
        return {
          relativePath,
          absolutePath: `/tmp/workspace/${relativePath}`
        };
      }
    } as unknown as BuiltinToolContext["localFileService"],
    activeInternalTrigger: null
  };
}
