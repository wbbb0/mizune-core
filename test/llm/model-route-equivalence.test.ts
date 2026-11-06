import test from "node:test";
import assert from "node:assert/strict";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { areMainModelRoutesEquivalent, getMainModelRouteWarnings, modelRefMatchesRoute } from "../../src/llm/shared/modelRouteEquivalence.ts";

test("完整profile等价忽略别名并提示单档路由，不误判同名不同策略", () => {
  const config = createTestAppConfig();
  config.llm.models.alias = structuredClone(config.llm.models.main!);
  config.llm.routingPresets.test!.mainLarge = ["alias"];
  assert.equal(areMainModelRoutesEquivalent(config), true);
  assert.equal(modelRefMatchesRoute(config, "main", ["alias"]), true);
  assert.match(getMainModelRouteWarnings(config)[0]!, /单档/);
  config.llm.models.alias!.chat!.preserveThinking = true;
  assert.equal(areMainModelRoutesEquivalent(config), false);
  assert.equal(modelRefMatchesRoute(config, "main", ["alias"]), false);
  assert.deepEqual(getMainModelRouteWarnings(config), []);
});

test("候选回退至同一实际配置时提示角色重叠但不改写候选链", () => {
  const config = createTestAppConfig();
  config.llm.models.large = structuredClone(config.llm.models.main!);
  config.llm.models.large.model = "configured-large";
  config.llm.routingPresets.test!.mainLarge = ["large", "main"];
  assert.equal(areMainModelRoutesEquivalent(config), false);
  assert.match(getMainModelRouteWarnings(config)[0]!, /候选链/);
  assert.deepEqual(config.llm.routingPresets.test!.mainLarge, ["large", "main"]);
});
