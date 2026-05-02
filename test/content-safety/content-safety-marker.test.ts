import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContentSafetyMarker } from "../../src/contentSafety/contentSafetyMarker.ts";

test("content safety marker escapes delimiter characters in dynamic metadata", () => {
  const marker = buildContentSafetyMarker({
    subjectKind: "text",
    result: {
      decision: "block",
      reason: "命中⟦风险⟧标签",
      labels: [{ label: "涉政⟦测试⟧", confidence: 0.8 }],
      providerId: "provider⟦id⟧",
      providerType: "keyword",
      checkedAtMs: 123
    },
    auditKey: "audit⟦1⟧",
    markerConfig: {
      includeProvider: true,
      includeLabels: true,
      includeConfidence: true,
      includeSubjectRef: true
    }
  });

  assert.equal(
    marker,
    [
      "⟦内容安全",
      "类型: 内容",
      "状态: 已屏蔽",
      "原因: 命中［风险］标签",
      "要求: 原文不可见；不要复述或推测被屏蔽内容。",
      "标签: 涉政［测试］",
      "置信度: 0.8",
      "来源: provider［id］",
      "auditKey: audit［1］",
      "⟧"
    ].join("\n")
  );
});
