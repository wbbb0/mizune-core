import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";

import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";

test("test fixtures allocate isolated temp-backed runtime paths per call", () => {
  const first = createTestAppConfig();
  const second = createTestAppConfig();

  assert.notEqual(first.configRuntime.configDir, second.configRuntime.configDir);
  assert.match(first.configRuntime.configDir, new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(second.configRuntime.configDir, new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const firstDeps = createInternalApiDeps();
  const secondDeps = createInternalApiDeps();

  assert.notEqual(firstDeps.__state.workspaceRoot, secondDeps.__state.workspaceRoot);
  assert.match(firstDeps.__state.workspaceRoot, new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(secondDeps.__state.workspaceRoot, new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});
