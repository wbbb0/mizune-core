import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_BOT_PROFILE_MAX_TOTAL_LENGTH,
  clearSessionBotProfileFields,
  cloneSessionBotProfile,
  normalizeSessionBotProfile,
  patchSessionBotProfile,
  sessionBotProfileSchema
} from "../../src/conversation/session/sessionBotProfile.ts";

test("session bot profile normalizes empty values and supports partial updates", () => {
  const initial = normalizeSessionBotProfile({
    name: "  小岚  ",
    identity: "摄影师",
    background: "",
    voiceStyle: "随意"
  });
  assert.deepEqual(initial, {
    name: "小岚",
    identity: "摄影师",
    voiceStyle: "随意"
  });
  const patched = patchSessionBotProfile(initial, { background: "住在杭州" });
  assert.deepEqual(patched, {
    name: "小岚",
    identity: "摄影师",
    background: "住在杭州",
    voiceStyle: "随意"
  });
  assert.deepEqual(clearSessionBotProfileFields(patched, ["identity", "background"]), {
    name: "小岚",
    voiceStyle: "随意"
  });
  assert.equal(clearSessionBotProfileFields(patched), null);
  assert.equal(normalizeSessionBotProfile({ name: "  " }), null);
});

test("session bot profile clone is independent and schema bounds user-provided system data", () => {
  const source = { name: "小岚", identity: "摄影师" };
  const cloned = cloneSessionBotProfile(source);
  assert.deepEqual(cloned, source);
  assert.notEqual(cloned, source);
  assert.throws(() => sessionBotProfileSchema.parse({ unknown: "value" }));
  assert.throws(() => sessionBotProfileSchema.parse({ identity: "x".repeat(1_001) }));
  assert.throws(() => sessionBotProfileSchema.parse({
    identity: "x".repeat(1_000),
    background: "x".repeat(1_000),
    temperament: "x".repeat(1_000),
    voiceStyle: "x"
  }), new RegExp(String(SESSION_BOT_PROFILE_MAX_TOTAL_LENGTH)));
});
