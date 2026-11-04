import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { captureSessionMutationGuard } from "../../src/llm/tools/core/sessionMutationGuard.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("external text write guard rejects clear and delete/recreate but permits ordinary outbound cancellation", () => {
  const manager = new SessionManager(createTestAppConfig());
  const id = "web:write-guard";
  manager.ensureSession({ id, type: "private", source: "web" });
  const beforeClear = captureSessionMutationGuard(manager, id);
  manager.interruptOutbound(id);
  assert.equal(beforeClear(), true);
  manager.clearSession(id);
  assert.equal(beforeClear(), false);
  const beforeDelete = captureSessionMutationGuard(manager, id);
  manager.deleteSession(id);
  assert.equal(beforeDelete(), false);
  manager.ensureSession({ id, type: "private", source: "web" });
  assert.equal(beforeDelete(), false);
  assert.equal(captureSessionMutationGuard(manager, id)(), true);
});
