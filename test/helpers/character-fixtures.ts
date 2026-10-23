import { createTestAppConfig } from "./config-fixtures.tsx";
import { characterRepository } from "../../src/character/repository.ts";

/** 普通生成测试明确准备已确认档案，不依赖旧全局 readiness 标志。 */
export function createConfiguredTestAppConfig(...args: Parameters<typeof createTestAppConfig>) {
  const config = createTestAppConfig(...args); const store = characterRepository(config.dataDir);
  for (const stage of ["persona", "social", "embodiment"] as const) {
    const draft = store.begin("fixture", stage, "setup", "stateful_rp");
    if (stage === "persona") {
      for (const [id, value] of Object.entries({ name: "小满", personality: "冷静细致", voiceTone: "短句克制" })) store.edit("fixture", "stateful_rp", `persona.${id}`, "set", value, undefined, draft.id);
    }
    if (stage === "social") {
      const identity = store.section("fixture", "stateful_rp", "social.identity").value;
      store.edit("fixture", "stateful_rp", "social.identity", "set", { ...identity, occupation: "图书管理员" }, undefined, draft.id);
    }
    store.confirm("fixture", "stateful_rp");
  }
  return config;
}
