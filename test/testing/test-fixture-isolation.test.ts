import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";

import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";

test("createTestAppConfig allocates an isolated config runtime directory per call", () => {
  const first = createTestAppConfig();
  const second = createTestAppConfig();

  assert.notEqual(first.configRuntime.configDir, second.configRuntime.configDir);
  assert.match(first.configRuntime.configDir, new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(second.configRuntime.configDir, new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("createInternalApiDeps allocates an isolated workspace root per call", () => {
  const first = createInternalApiDeps();
  const second = createInternalApiDeps();

  assert.notEqual(first.__state.workspaceRoot, second.__state.workspaceRoot);
  assert.match(first.__state.workspaceRoot, new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(second.__state.workspaceRoot, new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});
