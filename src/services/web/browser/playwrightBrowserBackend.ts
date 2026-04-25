import type { Logger } from "pino";
import type { Browser, BrowserContext, Page } from "playwright";
import type { AppConfig } from "#config/config.ts";
import { resolveProxyUrls } from "../../proxy/index.ts";
import { cleanWhitespace, safeHost, splitIntoLines } from "./contentExtraction.ts";
import type {
  BrowserActionTarget,
  BrowserBackend,
  BrowserBackendInteractionMeta,
  BrowserBackendInteractionInput,
  BrowserBackendOpenResult,
  BrowserBackendScreenshotInput,
  BrowserElement,
  BrowserElementKind,
  BrowserInteractionAction,
  BrowserLink,
  BrowserSnapshot
} from "./types.ts";

const MAX_PAGE_LINKS = 40;
const MAX_PAGE_ELEMENTS = 40;
const LINE_TARGET_LENGTH = 160;

interface PlaywrightSessionState {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  requestedUrl: string;
  profileId: string | null;
  persistState: boolean;
  sessionStorageByOrigin: Record<string, Record<string, string>>;
}

interface PlaywrightElementSnapshot {
  candidateKey: string;
  id: number;
  kind: BrowserElementKind;
  label: string;
  whySelected: string[];
  role: string | null;
  name: string | null;
  tag: string;
  text: string;
  type: string | null;
  action: "click" | "type" | "select" | "check" | "submit";
  disabled: boolean;
  href: string | null;
  placeholder: string | null;
  valuePreview: string | null;
  checked: boolean | null;
  selected: boolean | null;
  expanded: boolean | null;
  visibility: "visible" | "hidden";
  locatorHint: string | null;
  score: number;
  top: number;
  hasImage: boolean;
  inMainContent: boolean;
  mediaUrl: string | null;
  posterUrl: string | null;
  sourceUrls: string[];
}

interface RawPageElementCandidate {
  candidateKey: string;
  role: string | null;
  ariaLabel: string | null;
  title: string | null;
  tag: string;
  text: string;
  type: string | null;
  disabled: boolean;
  href: string | null;
  placeholder: string | null;
  value: string | null;
  checked: boolean | null;
  selected: boolean | null;
  expanded: boolean | null;
  visibility: "visible" | "hidden";
  imageAlt: string | null;
  imageCount: number;
  mediaUrl: string | null;
  posterUrl: string | null;
  sourceUrls: string[];
  area: number;
  top: number;
  inMainContent: boolean;
  inNavLike: boolean;
  className: string;
}

interface PageEvaluateRect {
  width: number;
  height: number;
  top: number;
}

interface PageEvaluateStyle {
  display: string;
  visibility: string;
}

interface PageEvaluateElement {
  tagName: string;
  className?: string | { baseVal?: string | null } | null;
  innerText?: string | null;
  textContent?: string | null;
  disabled?: boolean;
  isContentEditable?: boolean;
  checked?: boolean;
  selected?: boolean;
  value?: string | null;
  placeholder?: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): PageEvaluateRect;
  closest(selector: string): PageEvaluateElement | null;
  querySelector(selector: string): PageEvaluateElement | null;
  querySelectorAll(selector: string): Iterable<PageEvaluateElement>;
}

interface PageEvaluateDocument {
  contentType?: string;
  title?: string | null;
  body?: { innerText?: string | null } | null;
  querySelectorAll(selector: string): Iterable<PageEvaluateElement>;
}

interface PageEvaluateWindow {
  innerHeight: number;
  location: { origin: string };
  getComputedStyle(element: PageEvaluateElement): PageEvaluateStyle;
  scrollBy(options: { top: number; behavior: "auto" | "smooth" }): void;
  sessionStorage?: Storage;
}

type PageEvaluateGlobals = typeof globalThis & {
  document?: PageEvaluateDocument;
  window?: PageEvaluateWindow;
};

type PlaywrightModule = typeof import("playwright");

export class PlaywrightBrowserBackend implements BrowserBackend {
  readonly name = "playwright" as const;
  private playwrightModulePromise: Promise<PlaywrightModule> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  async open(input: {
    url: string;
    requestedUrl: string;
    profileId: string | null;
    storageState: unknown | null;
    sessionStorageByOrigin: Record<string, Record<string, string>>;
    persistState: boolean;
  }): Promise<BrowserBackendOpenResult> {
    const { chromium } = await this.loadPlaywright();
    const launchOptions: Record<string, unknown> = {
      headless: this.config.browser.playwright.headless
    };
    const proxyUrls = resolveProxyUrls(this.config, "browser", { browserMethod: "playwright" });
    const proxyServer = proxyUrls.https ?? proxyUrls.http;
    if (proxyServer) {
      launchOptions.proxy = { server: proxyServer };
    }

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext(input.storageState ? { storageState: input.storageState as any } : {});
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.browser.playwright.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.browser.playwright.navigationTimeoutMs);
    await page.goto(input.url, {
      waitUntil: "domcontentloaded",
      timeout: this.config.browser.playwright.navigationTimeoutMs
    });
    await this.waitForSettledPage(page);

    const sessionState: PlaywrightSessionState = {
      browser,
      context,
      page,
      requestedUrl: input.requestedUrl,
      profileId: input.profileId,
      persistState: input.persistState,
      sessionStorageByOrigin: normalizeSessionStorageByOrigin(input.sessionStorageByOrigin)
    };
    const restoredSessionStorage = await this.restoreSessionStorageForCurrentOrigin(sessionState);
    if (restoredSessionStorage) {
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: this.config.browser.playwright.navigationTimeoutMs
      });
      await this.waitForSettledPage(page);
    }
    await this.captureCurrentOriginSessionStorage(sessionState);

    return {
      state: sessionState,
      snapshot: await this.captureSnapshot(page, input.requestedUrl, input.profileId)
    };
  }

  async interact(input: BrowserBackendInteractionInput): Promise<BrowserBackendOpenResult & {
    interaction?: BrowserBackendInteractionMeta | undefined;
  }> {
    const state = input.state as PlaywrightSessionState | undefined;
    if (!state?.page) {
      throw new Error("Playwright page session is unavailable");
    }

    const resolvedTarget = input.targetId === undefined
      ? null
      : input.snapshot.elements.find((item) => item.id === input.targetId) ?? null;

    await this.applyAction(state.page, input.action, {
      targetId: input.targetId,
      target: input.target,
      coordinate: input.coordinate,
      resolvedTarget,
      text: input.text,
      value: input.value,
      key: input.key,
      filePaths: input.filePaths,
      waitMs: input.waitMs
    });
    await this.waitForSettledPage(state.page);
    await this.captureCurrentOriginSessionStorage(state);

    return {
      state,
      snapshot: await this.captureSnapshot(state.page, state.requestedUrl, state.profileId),
      interaction: {
        resolvedTarget,
        message: buildInteractionMessage(input.action, {
          resolvedTarget,
          coordinate: input.coordinate,
          filePaths: input.filePaths
        })
      }
    };
  }

  async captureScreenshot(input: BrowserBackendScreenshotInput): Promise<Buffer> {
    const state = input.state as PlaywrightSessionState | undefined;
    if (!state?.page) {
      throw new Error("Playwright page session is unavailable");
    }
    if (input.targetId == null) {
      return state.page.screenshot({ type: "png", fullPage: true });
    }
    const locator = state.page.locator(`[data-runtime-target-id="${Number(input.targetId)}"]`).first();
    return locator.screenshot({ type: "png" });
  }

  async persistState(state: unknown): Promise<{
    storageState: unknown | null;
    sessionStorageByOrigin: Record<string, Record<string, string>>;
  }> {
    const session = state as PlaywrightSessionState | undefined;
    if (!session?.context || !session.page) {
      return {
        storageState: null,
        sessionStorageByOrigin: {}
      };
    }
    await this.captureCurrentOriginSessionStorage(session);
    return {
      storageState: await session.context.storageState(),
      sessionStorageByOrigin: normalizeSessionStorageByOrigin(session.sessionStorageByOrigin)
    };
  }

  async close(state: unknown): Promise<void> {
    const session = state as PlaywrightSessionState | undefined;
    await session?.context?.close?.().catch(() => undefined);
    await session?.browser?.close?.().catch(() => undefined);
  }

  private async loadPlaywright(): Promise<PlaywrightModule> {
    if (!this.playwrightModulePromise) {
      const dynamicImport = new Function("specifier", "return import(specifier);") as (
        specifier: string
      ) => Promise<PlaywrightModule>;
      this.playwrightModulePromise = dynamicImport("playwright").catch((error: unknown) => {
        throw new Error(`Playwright is not installed or failed to load: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return this.playwrightModulePromise;
  }

  private async captureSnapshot(page: Page, requestedUrl: string, profileId: string | null): Promise<BrowserSnapshot> {
    const contentType = await page.evaluate(() => {
      const globals = globalThis as PageEvaluateGlobals;
      return globals.document?.contentType || "text/html";
    });
    const title = cleanWhitespace(String(await page.title().catch(() => ""))) || null;
    const resolvedUrl = String(page.url() ?? requestedUrl);
    const snapshot = await page.evaluate((limits: { maxElements: number; maxLinks: number }) => {
      const globals = globalThis as PageEvaluateGlobals;
      const doc = globals.document;
      const win = globals.window;
      if (!doc || !win) {
        return {
          bodyText: "",
          elements: [],
          titleFromDom: null
        };
      }
      const selector = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "img[src]",
        "video",
        "audio",
        "[role=\"button\"]",
        "[role=\"link\"]",
        "[contenteditable=\"true\"]"
      ].join(",");

      const nodes = Array.from(doc.querySelectorAll(selector))
        .filter((node) => {
          const style = win.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
        });

      const candidates = nodes.map((node, index) => {
        const tag = node.tagName.toLowerCase();
        const ariaLabel = node.getAttribute("aria-label");
        const role = node.getAttribute("role");
        const textNode = node as unknown as { innerText?: unknown };
        const innerText = typeof textNode.innerText === "string"
          ? textNode.innerText
          : "";
        const text = (innerText || node.textContent || "").trim();
        const type = tag === "input" ? (node.getAttribute("type") || "text") : null;
        const inputType = (type || "").toLowerCase();
        const disabled = (node as { disabled?: unknown }).disabled === true || node.getAttribute("aria-disabled") === "true";
        const checked = inputType === "checkbox" || inputType === "radio"
          ? Boolean((node as { checked?: unknown }).checked === true || node.getAttribute("aria-checked") === "true")
          : null;
        const selected = tag === "option" || tag === "select"
          ? Boolean((node as { selected?: unknown }).selected === true || node.getAttribute("aria-selected") === "true")
          : null;
        const expandedAttribute = node.getAttribute("aria-expanded");
        const expanded = expandedAttribute == null ? null : expandedAttribute === "true";
        const style = win.getComputedStyle(node);
        const visibility = style.display !== "none" && style.visibility !== "hidden" ? "visible" : "hidden";
        const rect = node.getBoundingClientRect();
        const area = Math.round(rect.width * rect.height);
        const imageNode = tag === "img"
          ? node
          : (node.querySelector("img") ?? null);
        const directMediaUrl = tag === "img"
          ? node.getAttribute("src")
          : tag === "video" || tag === "audio"
              ? node.getAttribute("src")
              : null;
        const posterUrl = tag === "video" ? node.getAttribute("poster") : null;
        const sourceUrls = (tag === "video" || tag === "audio")
          ? Array.from(node.querySelectorAll("source"))
              .map((item) => item.getAttribute("src"))
              .filter((item): item is string => Boolean(item))
          : [];
        const rawClassName = (node as { className?: string | { baseVal?: string } | null }).className;
        const className = typeof rawClassName === "string"
          ? rawClassName
          : rawClassName && typeof rawClassName === "object" && "baseVal" in rawClassName
              ? String(rawClassName.baseVal ?? "")
              : "";
        const valueNode = node as unknown as { value?: unknown };
        const value = typeof valueNode.value === "string"
          ? valueNode.value
          : "";
        const inMainContent = Boolean(node.closest("main, article, [role=\"main\"], .content, .main, #content"));
        const inNavLike = Boolean(node.closest("nav, header, footer, aside, .sidebar, .menu, .pagination, .breadcrumb"));
        return {
          candidateKey: `${tag}_${index + 1}`,
          role,
          ariaLabel,
          title: node.getAttribute("title"),
          tag,
          text,
          type,
          disabled,
          href: tag === "a" ? node.getAttribute("href") : null,
          placeholder: node.getAttribute("placeholder"),
          value: value || node.getAttribute("value") || null,
          checked,
          selected,
          expanded,
          visibility,
          imageAlt: imageNode?.getAttribute("alt") ?? null,
          imageCount: tag === "img" ? 1 : (imageNode ? 1 : 0),
          mediaUrl: directMediaUrl,
          posterUrl,
          sourceUrls,
          area,
          top: Math.round(rect.top),
          inMainContent,
          inNavLike,
          className
        };
      });

      const bodyText = (typeof (doc.body as { innerText?: unknown } | null)?.innerText === "string"
        ? (doc.body as { innerText: string }).innerText
        : "").trim();
      return {
        bodyText,
        elements: candidates,
        titleFromDom: doc.title || null
      };
    }, {
      maxElements: MAX_PAGE_ELEMENTS,
      maxLinks: MAX_PAGE_LINKS
    }) as { bodyText: string; elements: RawPageElementCandidate[]; titleFromDom: string | null };

    const prioritized = prioritizeBrowserCandidates(snapshot.elements, resolvedUrl)
      .slice(0, MAX_PAGE_ELEMENTS)
      .map((item, index) => ({
        ...item,
        id: index + 1
      }));

    await page.evaluate((keys: string[]) => {
      const globals = globalThis as PageEvaluateGlobals;
      const doc = globals.document;
      if (!doc) {
        return;
      }
      for (const node of Array.from(doc.querySelectorAll("[data-runtime-target-id]"))) {
        node.setAttribute("data-runtime-target-id", "");
      }
      const selector = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "img[src]",
        "video",
        "audio",
        "[role=\"button\"]",
        "[role=\"link\"]",
        "[contenteditable=\"true\"]"
      ].join(",");
      const allNodes = Array.from(doc.querySelectorAll(selector));
      for (const [index, key] of keys.entries()) {
        const node = allNodes.find((item, itemIndex) => `${item.tagName.toLowerCase()}_${itemIndex + 1}` === key);
        if (node) {
          node.setAttribute("data-runtime-target-id", String(index + 1));
        }
      }
    }, prioritized.map((item) => item.candidateKey));

    const elements = prioritized.map((item) => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      why_selected: item.whySelected,
      role: item.role,
      name: item.name,
      tag: item.tag,
      text: cleanWhitespace(item.text),
      type: item.type,
      action: item.action,
      disabled: item.disabled,
      href: item.href,
      placeholder: item.placeholder,
      value_preview: item.valuePreview,
      checked: item.checked,
      selected: item.selected,
      expanded: item.expanded,
      visibility: item.visibility,
      locator_hint: item.locatorHint,
      has_image: item.hasImage,
      in_main_content: item.inMainContent,
      media_url: item.mediaUrl,
      poster_url: item.posterUrl,
      source_urls: item.sourceUrls
    } satisfies BrowserElement));
    const links = prioritized
      .filter((item) => item.href)
      .slice(0, MAX_PAGE_LINKS)
      .flatMap((item): BrowserLink[] => {
        try {
          const url = new URL(String(item.href), resolvedUrl).toString();
          return [{
            id: item.id,
            text: item.name || item.text || url,
            url,
            host: safeHost(url)
          }];
        } catch {
          return [];
        }
      });

    const normalizedBodyText = cleanWhitespace(snapshot.bodyText);
    const textLimit = this.config.browser.playwright.maxSnapshotChars;
    return {
      profileId,
      requestedUrl,
      resolvedUrl,
      title: title || (snapshot.titleFromDom ? cleanWhitespace(snapshot.titleFromDom) : null),
      contentType,
      lines: splitIntoLines(normalizedBodyText.slice(0, textLimit), LINE_TARGET_LENGTH),
      links,
      elements,
      truncated: normalizedBodyText.length > textLimit
    };
  }

  private async applyAction(
    page: Page,
    action: BrowserInteractionAction,
    input: {
      targetId?: number | undefined;
      target?: BrowserActionTarget | undefined;
      coordinate?: { x: number; y: number } | undefined;
      resolvedTarget: BrowserElement | null;
      text?: string | undefined;
      value?: string | undefined;
      key?: string | undefined;
      filePaths?: string[] | undefined;
      waitMs?: number | undefined;
    }
  ): Promise<void> {
    if (action === "wait") {
      await page.waitForTimeout(input.waitMs ?? 1000);
      return;
    }
    if (action === "scroll_down") {
      await page.evaluate(() => {
        const globals = globalThis as PageEvaluateGlobals;
        const win = globals.window;
        if (!win) {
          return;
        }
        win.scrollBy({ top: win.innerHeight * 0.8, behavior: "auto" });
      });
      return;
    }
    if (action === "scroll_up") {
      await page.evaluate(() => {
        const globals = globalThis as PageEvaluateGlobals;
        const win = globals.window;
        if (!win) {
          return;
        }
        win.scrollBy({ top: -win.innerHeight * 0.8, behavior: "auto" });
      });
      return;
    }
    if (action === "go_back") {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: this.config.browser.playwright.navigationTimeoutMs }).catch(() => null);
      return;
    }
    if (action === "go_forward") {
      await page.goForward({ waitUntil: "domcontentloaded", timeout: this.config.browser.playwright.navigationTimeoutMs }).catch(() => null);
      return;
    }
    if (action === "reload") {
      await page.reload({ waitUntil: "domcontentloaded", timeout: this.config.browser.playwright.navigationTimeoutMs });
      return;
    }
    if (action === "press" && input.targetId === undefined) {
      const resolvedKey = String(input.key ?? "").trim();
      if (!resolvedKey) {
        throw new Error("press action requires non-empty key");
      }
      await page.keyboard.press(resolvedKey);
      return;
    }

    if ((action === "click" || action === "hover") && input.coordinate) {
      const x = Number(input.coordinate.x);
      const y = Number(input.coordinate.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("coordinate requires finite x and y");
      }
      await page.mouse.move(x, y);
      if (action === "click") {
        await page.mouse.click(x, y);
      }
      return;
    }

    const locator = await this.resolveActionLocator(page, input);

    if (action === "click") {
      await locator.click();
      return;
    }
    if (action === "hover") {
      await locator.hover();
      return;
    }
    if (action === "type") {
      if (input.text === undefined) {
        throw new Error("type action requires text");
      }
      await locator.fill(String(input.text));
      return;
    }
    if (action === "upload") {
      if (!Array.isArray(input.filePaths) || input.filePaths.length === 0) {
        throw new Error("upload action requires non-empty file_paths");
      }
      await locator.setInputFiles(input.filePaths);
      return;
    }
    if (action === "select") {
      const resolvedValue = String(input.value ?? input.text ?? "").trim();
      if (!resolvedValue) {
        throw new Error("select action requires value");
      }
      await locator.selectOption(resolvedValue);
      return;
    }
    if (action === "press") {
      const resolvedKey = String(input.key ?? "").trim();
      if (!resolvedKey) {
        throw new Error("press action requires non-empty key");
      }
      await locator.press(resolvedKey);
      return;
    }
    if (action === "check") {
      await locator.check();
      return;
    }
    if (action === "uncheck") {
      await locator.uncheck();
      return;
    }
    if (action === "submit") {
      await locator.evaluate((node) => {
        const form = node.closest("form");
        if (form && typeof (form as { requestSubmit?: () => void }).requestSubmit === "function") {
          (form as { requestSubmit: () => void }).requestSubmit();
          return;
        }
        if (typeof (node as { click?: () => void }).click === "function") {
          (node as { click: () => void }).click();
        }
      });
      return;
    }
    throw new Error(`Unsupported browser action: ${action}`);
  }

  private async resolveActionLocator(
    page: Page,
    input: {
      targetId?: number | undefined;
      target?: BrowserActionTarget | undefined;
      resolvedTarget: BrowserElement | null;
    }
  ) {
    if (Number.isInteger(input.targetId) && Number(input.targetId) > 0) {
      const locator = page.locator(`[data-runtime-target-id="${Number(input.targetId)}"]`).first();
      const count = await locator.count();
      if (count > 0) {
        return locator;
      }
    }

    const fallbackLocator = this.buildSemanticLocator(page, input.target ?? elementToTarget(input.resolvedTarget));
    if (fallbackLocator) {
      const count = await fallbackLocator.count();
      if (count > 0) {
        return fallbackLocator.first();
      }
    }

    throw new Error("目标元素已失效，请先重新 inspect_page 再继续操作。");
  }

  private buildSemanticLocator(page: Page, target: BrowserActionTarget | undefined) {
    if (!target) {
      return null;
    }

    let locator = target.role
      ? page.getByRole(target.role as any, buildRoleOptions(target))
      : null;

    if (!locator) {
      const selectorParts: string[] = [target.tag || "*"];
      if (target.type) {
        selectorParts.push(`[type="${escapeAttributeValue(target.type)}"]`);
      }
      if (target.hrefContains) {
        selectorParts.push(`[href*="${escapeAttributeValue(target.hrefContains)}"]`);
      }
      locator = page.locator(selectorParts.join(""));
      if (target.name) {
        locator = locator.filter({ hasText: target.name });
      } else if (target.text) {
        locator = locator.filter({ hasText: target.text });
      }
    }
    if (!locator) {
      return null;
    }

    if (target.index && target.index > 0) {
      locator = locator.nth(target.index - 1);
    }
    return locator;
  }

  private async waitForSettledPage(page: Page): Promise<void> {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(this.config.browser.playwright.profileAutoSaveDebounceMs).catch(() => undefined);
  }

  private async restoreSessionStorageForCurrentOrigin(state: PlaywrightSessionState): Promise<boolean> {
    if (!state.persistState || !this.config.browser.playwright.persistSessionStorage) {
      return false;
    }
    const origin = await this.getCurrentOrigin(state.page);
    if (!origin) {
      return false;
    }
    const entries = state.sessionStorageByOrigin[origin];
    if (!entries || Object.keys(entries).length === 0) {
      return false;
    }
    await state.page.evaluate((payload: Record<string, string>) => {
      const globals = globalThis as PageEvaluateGlobals;
      const storage = globals.window?.sessionStorage;
      if (!storage) {
        return;
      }
      for (const [key, value] of Object.entries(payload)) {
        storage.setItem(key, value);
      }
    }, entries);
    return true;
  }

  private async captureCurrentOriginSessionStorage(state: PlaywrightSessionState): Promise<void> {
    if (!state.persistState || !this.config.browser.playwright.persistSessionStorage) {
      return;
    }
    const origin = await this.getCurrentOrigin(state.page);
    if (!origin) {
      return;
    }
    const entries = await state.page.evaluate(() => {
      const globals = globalThis as PageEvaluateGlobals;
      const storage = globals.window?.sessionStorage;
      if (!storage) {
        return {};
      }
      const next: Record<string, string> = {};
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key) {
          continue;
        }
        next[key] = storage.getItem(key) ?? "";
      }
      return next;
    }) as Record<string, string>;
    if (Object.keys(entries).length === 0) {
      delete state.sessionStorageByOrigin[origin];
      return;
    }
    state.sessionStorageByOrigin[origin] = entries;
  }

  private async getCurrentOrigin(page: Page): Promise<string | null> {
    try {
      const origin = await page.evaluate(() => {
        const globals = globalThis as PageEvaluateGlobals;
        return globals.window?.location?.origin ?? "";
      });
      const normalized = String(origin ?? "").trim();
      return normalized && normalized !== "null" ? normalized : null;
    } catch (error: unknown) {
      this.logger.debug({ error: error instanceof Error ? error.message : String(error) }, "browser_origin_read_failed");
      return null;
    }
  }
}

function buildInteractionMessage(
  action: BrowserInteractionAction,
  input: {
    resolvedTarget: BrowserElement | null;
    coordinate?: { x: number; y: number } | undefined;
    filePaths?: string[] | undefined;
  }
): string | undefined {
  if (action === "upload" && Array.isArray(input.filePaths) && input.filePaths.length > 0) {
    return `已上传 ${input.filePaths.length} 个文件。`;
  }
  if (input.resolvedTarget) {
    return `已命中元素 #${input.resolvedTarget.id}${input.resolvedTarget.name ? `（${input.resolvedTarget.name}）` : ""}。`;
  }
  if (input.coordinate && (action === "click" || action === "hover")) {
    return `已在坐标 (${input.coordinate.x}, ${input.coordinate.y}) 执行 ${action}。`;
  }
  return undefined;
}

function normalizeSessionStorageByOrigin(
  value: Record<string, Record<string, string>>
): Record<string, Record<string, string>> {
  const next: Record<string, Record<string, string>> = {};
  for (const [origin, entries] of Object.entries(value ?? {})) {
    const normalizedOrigin = String(origin ?? "").trim();
    if (!normalizedOrigin) {
      continue;
    }
    const normalizedEntries: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(entries ?? {})) {
      const normalizedKey = String(key ?? "");
      if (!normalizedKey) {
        continue;
      }
      normalizedEntries[normalizedKey] = String(rawValue ?? "");
    }
    if (Object.keys(normalizedEntries).length > 0) {
      next[normalizedOrigin] = normalizedEntries;
    }
  }
  return next;
}

export function prioritizeBrowserCandidates(
  candidates: RawPageElementCandidate[],
  resolvedUrl: string
): PlaywrightElementSnapshot[] {
  return candidates
    .map((candidate) => normalizeBrowserCandidate(candidate, resolvedUrl))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.top - right.top;
    });
}

function normalizeBrowserCandidate(
  candidate: RawPageElementCandidate,
  resolvedUrl: string
): PlaywrightElementSnapshot {
  const role = inferImplicitRole(candidate);
  const action = inferInteractionAction(candidate);
  const name = deriveSemanticName(candidate, resolvedUrl);
  return {
    candidateKey: candidate.candidateKey,
    id: 0,
    kind: inferElementKind(candidate, role),
    label: buildElementLabel(candidate, name, role),
    whySelected: buildWhySelected(candidate, role),
    role,
    name,
    tag: candidate.tag,
    text: candidate.text,
    type: candidate.type,
    action,
    disabled: candidate.disabled,
    href: candidate.href ? resolveMaybeRelativeUrl(candidate.href, resolvedUrl) : null,
    placeholder: normalizeNullable(candidate.placeholder),
    valuePreview: previewValue(candidate.value, candidate.type),
    checked: candidate.checked,
    selected: candidate.selected,
    expanded: candidate.expanded,
    visibility: candidate.visibility,
    locatorHint: buildLocatorHint({
      role,
      name,
      tag: candidate.tag,
      text: candidate.text,
      type: candidate.type,
      placeholder: candidate.placeholder,
      href: candidate.href
    }),
    score: scoreBrowserCandidate(candidate, role),
    top: candidate.top,
    hasImage: candidate.imageCount > 0,
    inMainContent: candidate.inMainContent,
    mediaUrl: resolveMaybeRelativeUrl(candidate.mediaUrl, resolvedUrl),
    posterUrl: resolveMaybeRelativeUrl(candidate.posterUrl, resolvedUrl),
    sourceUrls: (Array.isArray(candidate.sourceUrls) ? candidate.sourceUrls : [])
      .map((item) => resolveMaybeRelativeUrl(item, resolvedUrl))
      .filter((item): item is string => Boolean(item))
  };
}

function inferImplicitRole(candidate: RawPageElementCandidate): string | null {
  if (candidate.role) {
    return candidate.role;
  }
  if (candidate.tag === "a" && candidate.href) {
    return "link";
  }
  if (candidate.tag === "button") {
    return "button";
  }
  if (candidate.tag === "select") {
    return "combobox";
  }
  if (candidate.tag === "summary") {
    return "button";
  }
  if (candidate.tag === "textarea") {
    return "textbox";
  }
  if (candidate.tag === "input") {
    const inputType = String(candidate.type ?? "text").toLowerCase();
    if (inputType === "checkbox") {
      return "checkbox";
    }
    if (inputType === "radio") {
      return "radio";
    }
    if (inputType === "submit" || inputType === "button") {
      return "button";
    }
    return "textbox";
  }
  return null;
}

function inferInteractionAction(candidate: RawPageElementCandidate): PlaywrightElementSnapshot["action"] {
  const inputType = String(candidate.type ?? "").toLowerCase();
  if (candidate.tag === "select") {
    return "select";
  }
  if (inputType === "checkbox" || inputType === "radio") {
    return "check";
  }
  if (candidate.tag === "input" || candidate.tag === "textarea") {
    return "type";
  }
  if (candidate.tag === "button" || inputType === "submit") {
    return "submit";
  }
  return "click";
}

function inferElementKind(candidate: RawPageElementCandidate, role: string | null): BrowserElementKind {
  const inputType = String(candidate.type ?? "").toLowerCase();
  if (candidate.tag === "img") {
    return "image";
  }
  if (candidate.tag === "video") {
    return "video";
  }
  if (candidate.tag === "audio") {
    return "audio";
  }
  if (candidate.tag === "a" && candidate.imageCount > 0) {
    return "image_link";
  }
  if (role === "link") {
    return "link";
  }
  if (role === "button") {
    return "button";
  }
  if (role === "textbox") {
    return "textbox";
  }
  if (role === "checkbox") {
    return "checkbox";
  }
  if (role === "radio") {
    return "radio";
  }
  if (candidate.tag === "select" || role === "combobox") {
    return "select";
  }
  if (role === "tab") {
    return "tab";
  }
  if (role === "menuitem") {
    return "menuitem";
  }
  if (candidate.tag === "summary") {
    return "summary";
  }
  if (inputType === "checkbox") {
    return "checkbox";
  }
  if (inputType === "radio") {
    return "radio";
  }
  return "interactive";
}

function deriveSemanticName(candidate: RawPageElementCandidate, resolvedUrl: string): string | null {
  const primary = normalizeNullable(candidate.ariaLabel)
    || normalizeNullable(candidate.title)
    || normalizeNullable(candidate.imageAlt)
    || normalizeNullable(candidate.text)
    || normalizeNullable(candidate.value);
  if (primary) {
    return primary;
  }
  const hrefName = summarizeUrlTail(candidate.href, resolvedUrl);
  if (hrefName) {
    return hrefName;
  }
  return summarizeUrlTail(candidate.mediaUrl, resolvedUrl) || summarizeUrlTail(candidate.posterUrl, resolvedUrl);
}

function buildElementLabel(candidate: RawPageElementCandidate, name: string | null, role: string | null): string {
  const prefix = (() => {
    if (candidate.tag === "img") {
      return "图片";
    }
    if (candidate.tag === "video") {
      return "视频";
    }
    if (candidate.tag === "audio") {
      return "音频";
    }
    if (candidate.tag === "a" && candidate.imageCount > 0) {
      return "图片入口";
    }
    if (role === "button") {
      return "按钮";
    }
    if (role === "textbox") {
      return "输入框";
    }
    if (role === "checkbox") {
      return "复选框";
    }
    if (candidate.tag === "select" || role === "combobox") {
      return "下拉框";
    }
    if (role === "link") {
      return "链接";
    }
    return "目标";
  })();
  return name ? `${prefix}: ${name}` : prefix;
}

function buildWhySelected(candidate: RawPageElementCandidate, role: string | null): string[] {
  const reasons: string[] = [];
  const sourceUrls = Array.isArray(candidate.sourceUrls) ? candidate.sourceUrls : [];
  if (candidate.inMainContent) {
    reasons.push("主内容");
  }
  if (candidate.imageCount > 0) {
    reasons.push("含图片");
  }
  if (candidate.mediaUrl || candidate.posterUrl || sourceUrls.length > 0) {
    reasons.push("可下载媒体");
  }
  if (candidate.href && /\/(post|article|product|item|show|detail|view)\//i.test(candidate.href)) {
    reasons.push("像详情入口");
  }
  if (role === "textbox" || role === "checkbox" || role === "combobox") {
    reasons.push("表单控件");
  }
  if (candidate.inNavLike && reasons.length === 0) {
    reasons.push("导航区域");
  }
  if (reasons.length === 0) {
    reasons.push("可交互");
  }
  return reasons.slice(0, 2);
}

function scoreBrowserCandidate(candidate: RawPageElementCandidate, role: string | null): number {
  let score = 0;
  if (candidate.inMainContent) {
    score += 60;
  }
  if (candidate.inNavLike) {
    score -= 45;
  }
  if (candidate.imageCount > 0) {
    score += 55;
  }
  if (candidate.mediaUrl || candidate.posterUrl || (candidate.sourceUrls?.length ?? 0) > 0) {
    score += 40;
  }
  if (candidate.href) {
    score += 18;
  }
  if (candidate.tag === "button" || role === "button") {
    score += 20;
  }
  if (role === "textbox" || role === "checkbox" || role === "combobox") {
    score += 24;
  }
  if (candidate.tag === "summary") {
    score += 12;
  }
  if (candidate.area >= 12_000) {
    score += 18;
  } else if (candidate.area >= 3_000) {
    score += 10;
  }
  if (/thumb|cover|card|gallery|result|tile|poster/i.test(candidate.className)) {
    score += 18;
  }
  if (candidate.href && /\/(post|article|product|item|show|detail|view)\//i.test(candidate.href)) {
    score += 28;
  }
  return score;
}

function buildLocatorHint(input: {
  role: string | null;
  name: string | null;
  tag: string;
  text: string;
  type: string | null;
  placeholder: string | null;
  href: string | null;
}): string | null {
  const sanitize = (value: string | null | undefined) => String(value ?? "").replace(/"/g, "").trim();
  if (input.role && input.name) {
    return `role=${input.role}[name*="${sanitize(input.name)}"]`;
  }
  if (input.placeholder) {
    return `${input.tag}[placeholder*="${sanitize(input.placeholder)}"]`;
  }
  if (input.href) {
    return `${input.tag}[href*="${sanitize(input.href)}"]`;
  }
  if (input.type) {
    return `${input.tag}[type="${sanitize(input.type)}"]`;
  }
  if (input.text) {
    return `${input.tag}:text("${sanitize(input.text).slice(0, 40)}")`;
  }
  return input.tag || null;
}

function previewValue(value: string | null, type: string | null): string | null {
  const normalized = normalizeNullable(value);
  if (!normalized) {
    return null;
  }
  if (String(type ?? "").toLowerCase() === "password") {
    return "<hidden>";
  }
  return normalized.slice(0, 80);
}

function resolveMaybeRelativeUrl(value: string | null | undefined, resolvedUrl: string): string | null {
  const normalized = normalizeNullable(value);
  if (!normalized) {
    return null;
  }
  try {
    return new URL(normalized, resolvedUrl).toString();
  } catch {
    return normalized;
  }
}

function normalizeNullable(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function summarizeUrlTail(rawUrl: string | null | undefined, resolvedUrl: string): string | null {
  const normalized = resolveMaybeRelativeUrl(rawUrl, resolvedUrl);
  if (!normalized) {
    return null;
  }
  try {
    const url = new URL(normalized);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const candidate = decodeURIComponent(lastSegment || url.hostname).replace(/[-_]+/g, " ").trim();
    return candidate || url.hostname;
  } catch {
    return normalized;
  }
}

function elementToTarget(element: BrowserElement | null): BrowserActionTarget | undefined {
  if (!element) {
    return undefined;
  }
  return {
    role: element.role ?? undefined,
    name: element.name ?? undefined,
    text: element.text || undefined,
    tag: element.tag,
    type: element.type ?? undefined,
    hrefContains: element.href ?? undefined
  };
}

function buildRoleOptions(target: BrowserActionTarget): { name?: string } {
  return target.name ? { name: target.name } : {};
}

function escapeAttributeValue(value: string): string {
  return value.replace(/"/g, "");
}
