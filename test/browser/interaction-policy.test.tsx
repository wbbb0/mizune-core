import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInteractionSuccessMessage,
  extractDownloadSourceUrl,
  resolveInteractionTarget,
  validateInteractionInput
} from "../../src/services/web/browser/browserInteractionPolicy.ts";
import type { BrowserSnapshot } from "../../src/services/web/browser/types.ts";

const elements: BrowserSnapshot["elements"] = [
  {
    id: 1,
    kind: "button",
    label: "提交",
    why_selected: ["主操作"],
    role: "button",
    name: "提交",
    tag: "button",
    text: "提交",
    type: "submit",
    action: "click",
    disabled: false,
    href: null,
    placeholder: null,
    value_preview: null,
    checked: null,
    selected: null,
    expanded: null,
    visibility: "visible",
    locator_hint: "#submit",
    has_image: false,
    in_main_content: true,
    media_url: null,
    poster_url: null,
    source_urls: []
  },
  {
    id: 2,
    kind: "link",
    label: "下载视频",
    why_selected: ["媒体"],
    role: "link",
    name: "下载视频",
    tag: "a",
    text: "下载视频",
    type: null,
    action: "click",
    disabled: false,
    href: "https://example.com/video.mp4",
    placeholder: null,
    value_preview: null,
    checked: null,
    selected: null,
    expanded: null,
    visibility: "visible",
    locator_hint: "a[href$='.mp4']",
    has_image: false,
    in_main_content: true,
    media_url: null,
    poster_url: null,
    source_urls: []
  }
];

  test("interaction policy rejects impossible target combinations", async () => {
    assert.equal(
      validateInteractionInput({
        resourceId: "r1",
        action: "wait",
        targetId: 1
      }),
      "action wait does not accept target_id, target or coordinate"
    );
  });

  test("semantic targets require disambiguation when multiple matches remain", async () => {
    const duplicateButton: BrowserSnapshot["elements"][number] = {
      ...elements[0]!,
      id: 3,
      locator_hint: "#submit-2"
    };
    const result = resolveInteractionTarget(
      [
        ...elements,
        duplicateButton
      ],
      {
        resourceId: "r1",
        action: "click",
        target: { role: "button", text: "提交" }
      }
    );

    assert.equal(result.ok, false);
    if (result.ok) {
      throw new Error("expected disambiguation result");
    }
    assert.equal(result.disambiguationRequired, true);
  });

  test("download source extraction and success messages stay explicit", async () => {
    assert.equal(extractDownloadSourceUrl(elements[1]!), "https://example.com/video.mp4");
    assert.equal(buildInteractionSuccessMessage("click", elements[0] ?? null), "已对元素 提交 执行 click。");
  });
