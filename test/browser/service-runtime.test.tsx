import assert from "node:assert/strict";
import { BrowserService } from "../../src/services/web/browser/browserService.ts";
import { prioritizeBrowserCandidates } from "../../src/services/web/browser/playwrightBrowserBackend.ts";
import { createForwardFeatureConfig, runCase } from "../helpers/forward-test-support.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

function createBrowserService() {
  const config = createForwardFeatureConfig();
  config.browser.playwright.enabled = true;
  return new BrowserService(
    config,
    createSilentLogger(),
    () => null,
    "/tmp",
    {
      async importBuffer() {
        return { assetId: "img_uploaded_1" };
      },
      async importRemoteSource() {
        return {
          assetId: "asset_uploaded_1",
          kind: "file" as const,
          filename: "downloaded.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 1
        };
      }
    }
  );
}

async function main() {
  await runCase("browser service supports inspect patterns and screenshot capture on playwright backend", async () => {
    const service = createBrowserService();
    const screenshots: Array<{ targetId?: number }> = [];
    (service as any).playwrightBackend = {
      name: "playwright",
      async open(input: { url: string; requestedUrl: string; profileId: string | null }) {
        return {
          state: { requestedUrl: input.requestedUrl, resolvedUrl: input.url, profileId: input.profileId },
          snapshot: {
            profileId: input.profileId,
            requestedUrl: input.requestedUrl,
            resolvedUrl: input.url,
            title: "Gemini launch",
            contentType: "text/html",
            lines: ["Gemini officially launches in Hong Kong", "Web version first", "Future expansion to mobile app on March 16"],
            links: [{ id: 1, text: "Read follow up", url: "https://example.com/follow-up", host: "example.com" }],
            elements: [{
              id: 1,
              kind: "link",
              label: "链接: Read follow up",
              why_selected: ["主内容"],
              role: "link",
              name: "Read follow up",
              tag: "a",
              text: "Read follow up",
              type: null,
              action: "click",
              disabled: false,
              href: "https://example.com/follow-up",
              placeholder: null,
              value_preview: null,
              checked: null,
              selected: null,
              expanded: null,
              visibility: "visible",
              locator_hint: "a[href*=\"follow-up\"]",
              has_image: false,
              in_main_content: true,
              media_url: null,
              poster_url: null,
              source_urls: []
            }],
            truncated: false
          }
        };
      },
      async interact(input: { state: unknown; snapshot: any }) {
        return {
          state: input.state,
          snapshot: input.snapshot
        };
      },
      async captureScreenshot(input: { targetId?: number }) {
        screenshots.push(input.targetId === undefined ? {} : { targetId: input.targetId });
        return Buffer.from("fake-png");
      },
      async persistState() {
        return {
          storageState: { cookies: [] },
          sessionStorageByOrigin: { "https://example.com": { otp: "123456" } }
        };
      },
      async close() {}
    };

    const page = await service.openPage({ url: "https://example.com/with-links", ownerSessionId: "private:10001" });
    const inspected = await service.inspectPage({ resourceId: page.resource_id, pattern: "web version|March 16" });
    assert.equal(inspected.matches.length > 0, true);
    assert.equal(page.links.length, 1);
    assert.equal(page.profile_id?.startsWith("browser_profile_"), true);

    const pageShot = await service.capturePageScreenshot(page.resource_id);
    const elementShot = await service.captureElementScreenshot(page.resource_id, 1);
    assert.equal(pageShot.imageId, "img_uploaded_1");
    assert.equal(elementShot.mode, "element");
    assert.deepEqual(screenshots, [{}, { targetId: 1 }]);
  });

  await runCase("browser service reload closes existing playwright sessions", async () => {
    const service = createBrowserService();
    const closedStates: unknown[] = [];
    (service as any).playwrightBackend = {
      name: "playwright",
      async open(input: { url: string; requestedUrl: string; profileId: string | null }) {
        return {
          state: { requestedUrl: input.requestedUrl, resolvedUrl: input.url },
          snapshot: {
            profileId: input.profileId,
              requestedUrl: input.requestedUrl,
              resolvedUrl: input.url,
              title: "Reload test",
              contentType: "text/html",
              lines: ["L1 reload test"],
              links: [],
              elements: [],
              truncated: false
          }
        };
      },
      async interact() {
        throw new Error("should not interact in reload test");
      },
      async captureScreenshot() {
        return Buffer.from("fake");
      },
      async persistState() {
        return {
          storageState: null,
          sessionStorageByOrigin: {}
        };
      },
      async close(state: unknown) {
        closedStates.push(state);
      }
    };

    const page = await service.openPage({ url: "https://example.com/reload", ownerSessionId: "private:10001" });
    await service.reloadConfig();

    assert.equal(closedStates.length, 1);
    await assert.rejects(service.inspectPage({ resourceId: page.resource_id }), /Unknown resource_id/);
  });

  await runCase("browser sessions expire after ttl and active access extends ttl", async () => {
    const service = createBrowserService();
    (service as any).config.browser.sessionTtlMs = 3_600_000;
    const closedStates: unknown[] = [];
    let now = 1_000;
    const originalNow = Date.now;

    Date.now = () => now;
    try {
      (service as any).playwrightBackend = {
        name: "playwright",
        async open(input: { url: string; requestedUrl: string; profileId: string | null }) {
          return {
            state: { requestedUrl: input.requestedUrl, resolvedUrl: input.url },
            snapshot: {
              profileId: input.profileId,
              requestedUrl: input.requestedUrl,
              resolvedUrl: input.url,
              title: "TTL test",
              contentType: "text/html",
              lines: ["L1 ttl test"],
              links: [],
              elements: [],
              truncated: false
            }
          };
        },
        async interact() {
          throw new Error("should not interact in ttl test");
        },
        async captureScreenshot() {
          return Buffer.from("fake");
        },
        async persistState() {
          return {
            storageState: null,
            sessionStorageByOrigin: {}
          };
        },
        async close(state: unknown) {
          closedStates.push(state);
        }
      };

      const page = await service.openPage({ url: "https://example.com/ttl", ownerSessionId: "private:10001" });
      now += 1_800_000;
      await service.inspectPage({ resourceId: page.resource_id });
      now += 1_800_000;
      await service.inspectPage({ resourceId: page.resource_id });
      now += 3_600_001;

      await assert.rejects(service.inspectPage({ resourceId: page.resource_id }), /Unknown resource_id/);
      const listed = await service.listPages();
      const records = await (service as any).resourceRegistry.list("browser_page");
      assert.equal(closedStates.length, 1);
      assert.deepEqual(listed.pages, []);
      assert.equal(records[0]?.status, "expired");
    } finally {
      Date.now = originalNow;
    }
  });

  await runCase("browser service supports semantic target resolution and forwards expanded actions", async () => {
    const service = createBrowserService();
    const backendCalls: Array<{
      action: string;
      targetId?: number;
      key?: string;
      coordinate?: { x: number; y: number };
      filePaths?: string[];
    }> = [];
    (service as any).playwrightBackend = {
      name: "playwright",
      async open(input: { url: string; requestedUrl: string; profileId: string | null }) {
        return {
          state: { requestedUrl: input.requestedUrl, resolvedUrl: input.url },
          snapshot: {
            profileId: input.profileId,
            requestedUrl: input.requestedUrl,
            resolvedUrl: input.url,
            title: "Search page",
            contentType: "text/html",
            lines: ["L1 Search"],
            links: [],
            elements: [{
              id: 1,
              kind: "textbox",
              label: "输入框: 搜索框",
              why_selected: ["表单控件", "主内容"],
              role: "textbox",
              name: "搜索框",
              tag: "input",
              text: "",
              type: "text",
              action: "type",
              disabled: false,
              href: null,
              placeholder: "搜索",
              value_preview: null,
              checked: null,
              selected: null,
              expanded: null,
              visibility: "visible",
              locator_hint: "input[placeholder*=\"搜索\"]",
              has_image: false,
              in_main_content: true,
              media_url: null,
              poster_url: null,
              source_urls: []
            }],
            truncated: false
          }
        };
      },
      async interact(input: {
        state: unknown;
        snapshot: any;
        action: string;
        targetId?: number;
        key?: string;
        coordinate?: { x: number; y: number };
        filePaths?: string[];
      }) {
        backendCalls.push({
          action: input.action,
          ...(input.targetId != null ? { targetId: input.targetId } : {}),
          ...(input.key ? { key: input.key } : {}),
          ...(input.coordinate ? { coordinate: input.coordinate } : {}),
          ...(input.filePaths ? { filePaths: input.filePaths } : {})
        });
        return {
          state: input.state,
          snapshot: input.snapshot,
          interaction: {
            resolvedTarget: input.targetId != null ? input.snapshot.elements[0] : null,
            message: input.targetId != null ? "已命中元素 #1（搜索框）。" : undefined
          }
        };
      },
      async captureScreenshot() {
        return Buffer.from("fake");
      },
      async persistState() {
        return {
          storageState: null,
          sessionStorageByOrigin: {}
        };
      },
      async close() {}
    };

    const page = await service.openPage({ url: "https://example.com/search", ownerSessionId: "private:10001" });
    const typed = await service.interactWithPage({
      resourceId: page.resource_id,
      action: "type",
      target: { role: "textbox", name: "搜索框" },
      text: "OpenAI"
    });
    const pressed = await service.interactWithPage({
      resourceId: page.resource_id,
      action: "press",
      key: "Enter"
    });
    const clickedByCoordinate = await service.interactWithPage({
      resourceId: page.resource_id,
      action: "click",
      coordinate: { x: 320, y: 240 }
    });
    const uploaded = await service.interactWithPage({
      resourceId: page.resource_id,
      action: "upload",
      targetId: 1,
      filePaths: ["/tmp/workspace/uploads/demo.txt"]
    });

    assert.equal(typed.ok, true);
    assert.equal(typed.resolved_target?.id, 1);
    assert.equal(typed.candidate_count, 1);
    assert.equal(pressed.ok, true);
    assert.equal(clickedByCoordinate.ok, true);
    assert.equal(clickedByCoordinate.resolved_target, null);
    assert.equal(uploaded.ok, true);
    assert.deepEqual(
      backendCalls.map((item) => ({
        action: item.action,
        targetId: item.targetId ?? null,
        key: item.key ?? null,
        coordinate: item.coordinate ?? null,
        filePaths: item.filePaths ?? null
      })),
      [
        { action: "type", targetId: 1, key: null, coordinate: null, filePaths: null },
        { action: "press", targetId: null, key: "Enter", coordinate: null, filePaths: null },
        { action: "click", targetId: null, key: null, coordinate: { x: 320, y: 240 }, filePaths: null },
        { action: "upload", targetId: 1, key: null, coordinate: null, filePaths: ["/tmp/workspace/uploads/demo.txt"] }
      ]
    );
  });

  await runCase("browser service returns recoverable diagnostics for ambiguous semantic targets", async () => {
    const service = createBrowserService();
    let backendCalled = false;
    (service as any).playwrightBackend = {
      name: "playwright",
      async open(input: { url: string; requestedUrl: string; profileId: string | null }) {
        return {
          state: { requestedUrl: input.requestedUrl, resolvedUrl: input.url },
          snapshot: {
            profileId: input.profileId,
            requestedUrl: input.requestedUrl,
            resolvedUrl: input.url,
            title: "Filters",
            contentType: "text/html",
            lines: ["L1 Filters"],
            links: [],
            elements: [
              {
                id: 1,
                kind: "checkbox",
                label: "复选框: 仅看已发布",
                why_selected: ["表单控件", "主内容"],
                role: "checkbox",
                name: "仅看已发布",
                tag: "input",
                text: "仅看已发布",
                type: "checkbox",
                action: "check",
                disabled: false,
                href: null,
                placeholder: null,
                value_preview: null,
                checked: false,
                selected: null,
                expanded: null,
                visibility: "visible",
                locator_hint: "input[type=\"checkbox\"]",
                has_image: false,
                in_main_content: true,
                media_url: null,
                poster_url: null,
                source_urls: []
              },
              {
                id: 2,
                kind: "checkbox",
                label: "复选框: 仅看已发布",
                why_selected: ["表单控件", "主内容"],
                role: "checkbox",
                name: "仅看已发布",
                tag: "input",
                text: "仅看已发布",
                type: "checkbox",
                action: "check",
                disabled: false,
                href: null,
                placeholder: null,
                value_preview: null,
                checked: false,
                selected: null,
                expanded: null,
                visibility: "visible",
                locator_hint: "input[type=\"checkbox\"]",
                has_image: false,
                in_main_content: true,
                media_url: null,
                poster_url: null,
                source_urls: []
              }
            ],
            truncated: false
          }
        };
      },
      async interact() {
        backendCalled = true;
        throw new Error("should not be called");
      },
      async captureScreenshot() {
        return Buffer.from("fake");
      },
      async persistState() {
        return {
          storageState: null,
          sessionStorageByOrigin: {}
        };
      },
      async close() {}
    };

    const page = await service.openPage({ url: "https://example.com/filters", ownerSessionId: "private:10001" });
    const result = await service.interactWithPage({
      resourceId: page.resource_id,
      action: "check",
      target: { role: "checkbox", name: "仅看已发布" }
    });

    assert.equal(result.ok, false);
    assert.equal(result.disambiguation_required, true);
    assert.equal(result.candidate_count, 2);
    assert.equal(result.candidates.length, 2);
    assert.equal(backendCalled, false);
  });

  await runCase("browser service downloads direct urls and page target media sources into workspace assets", async () => {
    const service = createBrowserService();
    const downloads: Array<{
      source: string;
      origin: string;
      filename?: string;
      kind?: string;
      proxyConsumer?: string;
    }> = [];
    (service as any).mediaWorkspace = {
      async importRemoteSource(input: {
        source: string;
        origin: string;
        filename?: string;
        kind?: string;
        proxyConsumer?: string;
      }) {
        downloads.push(input);
        return {
          assetId: "asset_downloaded_1",
          kind: (input.kind as "image" | "animated_image" | "video" | "audio" | "file" | undefined) ?? "file",
          filename: input.filename ?? "downloaded.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 777
        };
      }
    };
    (service as any).playwrightBackend = {
      name: "playwright",
      async open(input: { url: string; requestedUrl: string; profileId: string | null }) {
        return {
          state: { requestedUrl: input.requestedUrl, resolvedUrl: input.url },
          snapshot: {
            profileId: input.profileId,
            requestedUrl: input.requestedUrl,
            resolvedUrl: input.url,
            title: "Download test",
            contentType: "text/html",
            lines: ["L1 download test"],
            links: [{ id: 1, text: "Image", url: "https://example.com/image.jpg", host: "example.com" }],
            elements: [
              {
                id: 1,
                kind: "image_link",
                label: "图片入口: Image",
                why_selected: ["主内容", "含图片"],
                role: "link",
                name: "Image",
                tag: "a",
                text: "Image",
                type: null,
                action: "click",
                disabled: false,
                href: "https://example.com/image.jpg",
                placeholder: null,
                value_preview: null,
                checked: null,
                selected: null,
                expanded: null,
                visibility: "visible",
                locator_hint: "a[href*=\"image.jpg\"]",
                has_image: true,
                in_main_content: true,
                media_url: null,
                poster_url: null,
                source_urls: []
              },
              {
                id: 2,
                kind: "video",
                label: "视频: Trailer",
                why_selected: ["主内容", "可下载媒体"],
                role: null,
                name: "Trailer",
                tag: "video",
                text: "",
                type: null,
                action: "click",
                disabled: false,
                href: null,
                placeholder: null,
                value_preview: null,
                checked: null,
                selected: null,
                expanded: null,
                visibility: "visible",
                locator_hint: "video[src*=\"trailer.mp4\"]",
                has_image: false,
                in_main_content: true,
                media_url: "https://example.com/trailer.mp4",
                poster_url: "https://example.com/trailer.jpg",
                source_urls: ["https://example.com/trailer-alt.webm"]
              }
            ],
            truncated: false
          }
        };
      },
      async interact() {
        throw new Error("should not interact in download test");
      },
      async captureScreenshot() {
        return Buffer.from("fake");
      },
      async persistState() {
        return {
          storageState: null,
          sessionStorageByOrigin: {}
        };
      },
      async close() {}
    };

    const page = await service.openPage({ url: "https://example.com/gallery", ownerSessionId: "private:10001" });
    const byUrl = await service.downloadAsset({ url: "https://example.com/video.mp4", filename: "video.mp4", kind: "video" });
    const byTarget = await service.downloadAsset({ resourceId: page.resource_id, targetId: 1 });
    const byMediaTarget = await service.downloadAsset({ resourceId: page.resource_id, targetId: 2, kind: "video" });

    assert.equal(byUrl.asset_id, "asset_downloaded_1");
    assert.equal(byUrl.source_url, "https://example.com/video.mp4");
    assert.equal(byTarget.source_url, "https://example.com/image.jpg");
    assert.equal(byMediaTarget.source_url, "https://example.com/trailer.mp4");
    assert.deepEqual(
      downloads.map((item) => ({
        source: item.source,
        origin: item.origin,
        filename: item.filename ?? null,
        kind: item.kind ?? null,
        proxyConsumer: item.proxyConsumer ?? null
      })),
      [
        { source: "https://example.com/video.mp4", origin: "browser_download", filename: "video.mp4", kind: "video", proxyConsumer: "browser" },
        { source: "https://example.com/image.jpg", origin: "browser_download", filename: null, kind: null, proxyConsumer: "browser" },
        { source: "https://example.com/trailer.mp4", origin: "browser_download", filename: null, kind: "video", proxyConsumer: "browser" }
      ]
    );
  });

  await runCase("browser candidate ranking prioritizes main-content image links over navigation noise", async () => {
    const ranked = prioritizeBrowserCandidates([
      {
        candidateKey: "nav_1",
        role: null,
        ariaLabel: null,
        title: null,
        tag: "a",
        text: "Posts",
        type: null,
        disabled: false,
        href: "/post",
        placeholder: null,
        value: null,
        checked: null,
        selected: null,
        expanded: null,
        visibility: "visible",
        imageAlt: null,
        imageCount: 0,
        mediaUrl: null,
        posterUrl: null,
        sourceUrls: [],
        area: 1_200,
        top: 20,
        inMainContent: false,
        inNavLike: true,
        className: "menu-link"
      },
      {
        candidateKey: "thumb_1",
        role: null,
        ariaLabel: null,
        title: null,
        tag: "a",
        text: "",
        type: null,
        disabled: false,
        href: "/post/show/1257657",
        placeholder: null,
        value: null,
        checked: null,
        selected: null,
        expanded: null,
        visibility: "visible",
        imageAlt: "sample image",
        imageCount: 1,
        mediaUrl: null,
        posterUrl: null,
        sourceUrls: [],
        area: 18_000,
        top: 420,
        inMainContent: true,
        inNavLike: false,
        className: "thumb"
      }
    ], "https://yande.re/post");

    assert.equal(ranked[0]?.href, "https://yande.re/post/show/1257657");
    assert.equal(ranked[0]?.kind, "image_link");
    assert.equal(ranked[0]?.hasImage, true);
    assert.equal(ranked[0]?.inMainContent, true);
    assert.equal(ranked[0]?.role, "link");
    assert.match(String(ranked[0]?.name ?? ""), /sample image|1257657/i);
    assert.equal(ranked[1]?.kind, "link");
    assert.equal(ranked[1]?.inMainContent, false);
    assert.equal(ranked[1]?.href, "https://yande.re/post");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
