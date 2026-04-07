export type BrowserBackendName = "playwright";
export const BROWSER_INTERACTION_ACTIONS = [
  "click",
  "type",
  "upload",
  "select",
  "hover",
  "press",
  "check",
  "uncheck",
  "submit",
  "scroll_down",
  "scroll_up",
  "wait",
  "go_back",
  "go_forward",
  "reload"
] as const;
export type BrowserInteractionAction = (typeof BROWSER_INTERACTION_ACTIONS)[number];

export function isBrowserInteractionAction(value: string): value is BrowserInteractionAction {
  return (BROWSER_INTERACTION_ACTIONS as readonly string[]).includes(value);
}

export interface BrowserActionTarget {
  role?: string | undefined;
  name?: string | undefined;
  text?: string | undefined;
  tag?: string | undefined;
  type?: string | undefined;
  hrefContains?: string | undefined;
  index?: number | undefined;
}

export interface BrowserCoordinate {
  x: number;
  y: number;
}

export interface BrowserLink {
  id: number;
  text: string;
  url: string;
  host: string | null;
}

export type BrowserElementKind =
  | "link"
  | "image_link"
  | "image"
  | "video"
  | "audio"
  | "button"
  | "textbox"
  | "checkbox"
  | "radio"
  | "select"
  | "tab"
  | "menuitem"
  | "summary"
  | "interactive";

export interface BrowserElement {
  id: number;
  kind: BrowserElementKind;
  label: string;
  why_selected: string[];
  role: string | null;
  name: string | null;
  tag: string;
  text: string;
  type: string | null;
  action: "click" | "type" | "select" | "check" | "submit";
  disabled: boolean;
  href: string | null;
  placeholder: string | null;
  value_preview: string | null;
  checked: boolean | null;
  selected: boolean | null;
  expanded: boolean | null;
  visibility: "visible" | "hidden";
  locator_hint: string | null;
  has_image: boolean;
  in_main_content: boolean;
  media_url: string | null;
  poster_url: string | null;
  source_urls: string[];
}

export interface BrowserLineMatch {
  lineNumber: number;
  text: string;
}

export interface BrowserSnapshot {
  profileId: string | null;
  requestedUrl: string;
  resolvedUrl: string;
  title: string | null;
  contentType: string | null;
  lines: string[];
  links: BrowserLink[];
  elements: BrowserElement[];
  truncated: boolean;
}

export interface BrowserRenderResult {
  resource_id: string;
  backend: BrowserBackendName;
  profile_id: string | null;
  requestedUrl: string;
  resolvedUrl: string;
  title: string | null;
  contentType: string | null;
  lines: string[];
  links: BrowserLink[];
  elements: BrowserElement[];
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
}

export interface OpenPageResult extends BrowserRenderResult {
  ok: true;
}

export interface InspectPageResult extends BrowserRenderResult {
  ok: true;
  pattern: string | null;
  matches: BrowserLineMatch[];
}

export interface BrowserInteractionFailureResult {
  ok: false;
  resource_id: string;
  action: BrowserInteractionAction;
  snapshot: InspectPageResult;
  resolved_target: BrowserElement | null;
  candidate_count: number;
  disambiguation_required: boolean;
  candidates: BrowserElement[];
  message: string;
}

export interface BrowserInteractionSuccessResult {
  ok: true;
  resource_id: string;
  action: BrowserInteractionAction;
  snapshot: InspectPageResult;
  resolved_target: BrowserElement | null;
  candidate_count: number;
  disambiguation_required: false;
  candidates: BrowserElement[];
  message: string;
}
export type InteractWithPageResult = BrowserInteractionSuccessResult | BrowserInteractionFailureResult;

export interface ClosePageResult {
  ok: true;
  resource_id: string;
  closed: true;
}

export interface OpenPageInput {
  refId?: string | undefined;
  url?: string | undefined;
  description?: string | undefined;
  line?: number | undefined;
  ownerSessionId?: string | undefined;
}

export interface InspectPageInput {
  resourceId: string;
  line?: number | undefined;
  pattern?: string | undefined;
}

export interface InteractWithPageInput {
  resourceId: string;
  action: BrowserInteractionAction;
  targetId?: number | undefined;
  target?: BrowserActionTarget | undefined;
  coordinate?: BrowserCoordinate | undefined;
  text?: string | undefined;
  value?: string | undefined;
  key?: string | undefined;
  filePaths?: string[] | undefined;
  waitMs?: number | undefined;
  line?: number | undefined;
}

export interface BrowserPageListResult {
  ok: true;
  pages: Array<{
    resource_id: string;
    status: "active" | "expired" | "closed" | "unrecoverable";
    title: string | null;
    description: string | null;
    summary: string;
    requestedUrl: string;
    resolvedUrl: string;
    backend: BrowserBackendName;
    profile_id: string | null;
    createdAtMs: number;
    lastAccessedAtMs: number;
    expiresAtMs: number | null;
  }>;
}

export interface BrowserScreenshotResult {
  ok: true;
  resource_id: string;
  profile_id: string | null;
  imageId: string;
  mimeType: string;
  sizeBytes: number;
  mode: "page" | "element";
  target_id: number | null;
}

export interface DownloadBrowserAssetInput {
  url?: string | undefined;
  resourceId?: string | undefined;
  targetId?: number | undefined;
  filename?: string | undefined;
  kind?: "image" | "animated_image" | "video" | "audio" | "file" | undefined;
}

export interface DownloadBrowserAssetResult {
  ok: true;
  asset_id: string;
  kind: "image" | "animated_image" | "video" | "audio" | "file";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  origin: "browser_download";
  source_url: string;
  resource_id: string | null;
  target_id: number | null;
}

export interface BrowserProfileSummary {
  profile_id: string;
  ownerSessionId: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  origins: string[];
  hasStorageState: boolean;
  hasSessionStorage: boolean;
}

export interface BrowserProfileListResult {
  ok: true;
  profiles: BrowserProfileSummary[];
}

export interface BrowserProfileInspectResult {
  ok: true;
  profile: BrowserProfileSummary;
}

export interface BrowserProfileMutationResult {
  ok: true;
  profile_id: string;
  saved?: true;
  cleared?: true;
}

export interface BrowserBackendOpenResult {
  state: unknown;
  snapshot: BrowserSnapshot;
}

export interface BrowserBackendInteractionInput {
  snapshot: BrowserSnapshot;
  state: unknown;
  action: BrowserInteractionAction;
  targetId?: number | undefined;
  target?: BrowserActionTarget | undefined;
  coordinate?: BrowserCoordinate | undefined;
  text?: string | undefined;
  value?: string | undefined;
  key?: string | undefined;
  filePaths?: string[] | undefined;
  waitMs?: number | undefined;
}

export interface BrowserBackendInteractionMeta {
  resolvedTarget?: BrowserElement | null;
  message?: string | undefined;
}

export interface BrowserBackendScreenshotInput {
  state: unknown;
  targetId?: number | undefined;
}

export interface BrowserBackend {
  readonly name: BrowserBackendName;
  open(input: {
    url: string;
    requestedUrl: string;
    profileId: string | null;
    storageState: unknown | null;
    sessionStorageByOrigin: Record<string, Record<string, string>>;
    persistState: boolean;
  }): Promise<BrowserBackendOpenResult>;
  interact(input: BrowserBackendInteractionInput): Promise<BrowserBackendOpenResult & {
    interaction?: BrowserBackendInteractionMeta | undefined;
  }>;
  captureScreenshot(input: BrowserBackendScreenshotInput): Promise<Buffer>;
  persistState(state: unknown): Promise<{
    storageState: unknown | null;
    sessionStorageByOrigin: Record<string, Record<string, string>>;
  }>;
  close(state: unknown): Promise<void>;
}
