import test from "node:test";
import assert from "node:assert/strict";
import { projectQqMessageDiagnostic } from "../../../src/services/qqOfficial/messageDiagnostics.ts";

test("official diagnostics retain quote structure but exclude credentials and media capability URLs", () => {
  const diagnostic = projectQqMessageDiagnostic("GROUP_MESSAGE_CREATE", {
    id: "source-message", group_openid: "target-group", content: "请求", message_type: 103,
    message_scene: { ext: ["ref_msg_idx=reference", "auth_token=DO-NOT-LOG"] },
    msg_elements: [{ message_type: 102, author: { username: "记录作者" }, content: "转发文字",
      attachments: [{ filename: "说明.pdf", content_type: "application/pdf", url: "https://example.invalid/?rkey=PRIVATE" }],
      ark_data: { arbitrary_secret: "SECRET-CARD" } }]
  });
  const encoded = JSON.stringify(diagnostic);
  for (const secret of ["DO-NOT-LOG", "https://", "PRIVATE", "SECRET-CARD"]) assert.ok(!encoded.includes(secret));
  assert.ok(encoded.includes("转发文字"));
  assert.ok(encoded.includes("auth_token"));
  assert.ok(encoded.includes("target-group"));
  assert.ok(encoded.includes('"hasUrl":true'));
});

test("diagnostic forest shares a global budget even for wide recursive payloads", () => {
  const cyclic: Record<string, unknown> = { content: "字".repeat(40_000) };
  cyclic.msg_elements = [cyclic];
  const result = projectQqMessageDiagnostic("GROUP_MESSAGE_CREATE", {
    msg_elements: Array.from({ length: 200 }, () => ({ msg_elements: Array.from({ length: 200 }, () => cyclic) }))
  });
  let count = 0;
  const visit = (node: Record<string, unknown>) => {
    count += 1;
    for (const child of (node.msg_elements ?? []) as Record<string, unknown>[]) visit(child);
  };
  visit(result.message as Record<string, unknown>);
  assert.ok(count <= 200);
  assert.ok(JSON.stringify(result).length < 250_000);
});

test("diagnostic field and extension names consume the shared character budget", () => {
  const fields = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`字段${i}${"键".repeat(160)}`, true]));
  const elements = Array.from({ length: 200 }, () => ({ ...fields,
    message_scene: { ext: Array.from({ length: 50 }, (_, i) => `扩展${i}${"键".repeat(160)}=VALUE`) } }));
  const encoded = JSON.stringify(projectQqMessageDiagnostic("GROUP_MESSAGE_CREATE", { msg_elements: elements }));
  assert.ok(Buffer.byteLength(encoded) < 250_000);
  assert.ok(!encoded.includes("VALUE"));
});
