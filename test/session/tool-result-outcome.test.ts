import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyToolResultOutcome,
  parseToolResultObject
} from "../../src/conversation/taskTracker/toolResultOutcome.ts";

test("tool result outcome shares failure and running semantics across tracker and checkpoint", () => {
  assert.equal(classifyToolResultOutcome(parseToolResultObject('{"ok":false}')), "failed");
  assert.equal(classifyToolResultOutcome(parseToolResultObject('{"exitCode":2}')), "failed");
  assert.equal(classifyToolResultOutcome(parseToolResultObject('{"session":{"status":"failed"}}')), "failed");
  assert.equal(classifyToolResultOutcome(parseToolResultObject('{"session":{"status":"running"}}')), "in_progress");
  assert.equal(classifyToolResultOutcome(parseToolResultObject('{"status":"queued"}')), "in_progress");
  assert.equal(classifyToolResultOutcome(parseToolResultObject('{"ok":true,"exitCode":0}')), "succeeded");
});
