import assert from "node:assert/strict";
import test from "node:test";
import { parseProductionDeploymentConfig } from "../../scripts/production/deploymentConfig.ts";

test("production deployment config accepts explicit formal instances", () => {
  const config = parseProductionDeploymentConfig({
    instances: [{ name: "acc1", healthUrl: "http://127.0.0.1:3231/healthz" }]
  });
  assert.deepEqual(config.instances, [{
    name: "acc1",
    healthUrl: "http://127.0.0.1:3231/healthz"
  }]);
  assert.equal(config.retainReleases, 3);
});

test("production deployment config rejects development and remote health targets", () => {
  assert.throws(() => parseProductionDeploymentConfig({
    instances: [{ name: "dev", healthUrl: "http://127.0.0.1:3131/healthz" }]
  }), /开发实例/);
  assert.throws(() => parseProductionDeploymentConfig({
    instances: [{ name: "acc1", healthUrl: "https://example.com/healthz" }]
  }), /本机 HTTP/);
});
