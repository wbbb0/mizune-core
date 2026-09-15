import assert from "node:assert/strict";
import test from "node:test";
import { getHealthStatus } from "../../src/internalApi/application/basicAdminService.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("health status identifies the running instance and release", () => {
  const previousReleaseId = process.env.LLM_BOT_RELEASE_ID;
  process.env.LLM_BOT_RELEASE_ID = "release-test";
  try {
    const config = createTestAppConfig();
    config.configRuntime.instanceName = "acc1";
    const status = getHealthStatus(config);
    assert.equal(status.ok, true);
    assert.equal(status.instance, "acc1");
    assert.equal(status.releaseId, "release-test");
    assert.equal(status.pid, process.pid);
  } finally {
    if (previousReleaseId === undefined) {
      delete process.env.LLM_BOT_RELEASE_ID;
    } else {
      process.env.LLM_BOT_RELEASE_ID = previousReleaseId;
    }
  }
});
