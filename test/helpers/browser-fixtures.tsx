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
  return {
    browserService: browserService as unknown as BuiltinToolContext["browserService"],
    config: null as unknown as BuiltinToolContext["config"],
    relationship: "owner",
    replyDelivery: "onebot",
    lastMessage: {
      sessionId: "private:test",
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
    mediaWorkspace: {
      async prepareImageFileForModel(fileId: string) {
        return {
          file: {
            fileId,
            fileRef: `shot_${fileId.slice(-8)}.png`,
            kind: "image",
            origin: "browser_screenshot",
            workspacePath: `workspace/media/${fileId}.png`,
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
          workspacePath: `workspace/media/${fileId}.png`,
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
    } as unknown as BuiltinToolContext["mediaWorkspace"],
    forwardResolver: null as unknown as BuiltinToolContext["forwardResolver"],
    requestStore: null as unknown as BuiltinToolContext["requestStore"],
    sessionManager: null as unknown as BuiltinToolContext["sessionManager"],
    whitelistStore: null as unknown as BuiltinToolContext["whitelistStore"],
    userStore: null as unknown as BuiltinToolContext["userStore"],
    personaStore: null as unknown as BuiltinToolContext["personaStore"],
    globalMemoryStore: null as unknown as BuiltinToolContext["globalMemoryStore"],
    operationNoteStore: null as unknown as BuiltinToolContext["operationNoteStore"],
    setupStore: null as unknown as BuiltinToolContext["setupStore"],
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
    workspaceService: {
      resolvePath(relativePath = ".") {
        return {
          relativePath,
          absolutePath: `/tmp/workspace/${relativePath}`
        };
      }
    } as unknown as BuiltinToolContext["workspaceService"],
    activeInternalTrigger: null
  };
}
