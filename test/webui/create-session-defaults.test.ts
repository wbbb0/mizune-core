import assert from "node:assert/strict";
import {
  CREATE_SESSION_MODE_STORAGE_KEY,
  readStoredCreateSessionModeId,
  resolveCreateSessionModeId,
  resolveCreateSessionTitlePlaceholder,
  writeStoredCreateSessionModeId
} from "../../webui/src/components/sessions/createSessionDefaults.ts";

async function runCase(name: string, fn: () => void | Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("create session defaults prefer stored valid mode", () => {
    assert.equal(resolveCreateSessionModeId({
      storedModeId: "scenario_host",
      availableModeIds: ["rp_assistant", "scenario_host"]
    }), "scenario_host");
  });

  await runCase("create session defaults fall back to the first available mode", () => {
    assert.equal(resolveCreateSessionModeId({
      storedModeId: "missing",
      availableModeIds: ["assistant", "scenario_host"],
      fallbackModeId: "rp_assistant"
    }), "assistant");
  });

  await runCase("create session defaults expose mode-specific placeholders", () => {
    assert.equal(resolveCreateSessionTitlePlaceholder("scenario_host"), "New Scenario");
    assert.equal(resolveCreateSessionTitlePlaceholder("rp_assistant"), "New Chat");
  });

  await runCase("create session defaults read and write localStorage mode memory", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      }
    };

    writeStoredCreateSessionModeId(storage, "scenario_host");
    assert.equal(values.get(CREATE_SESSION_MODE_STORAGE_KEY), "scenario_host");
    assert.equal(readStoredCreateSessionModeId(storage), "scenario_host");
  });
}

void main();
