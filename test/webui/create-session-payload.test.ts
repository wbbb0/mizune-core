import test from "node:test";
import assert from "node:assert/strict";
import { buildCreateSessionPayload } from "../../webui/src/components/sessions/createSessionPayload.ts";

  test("create session payload preserves manual title and mode", () => {
    assert.deepEqual(buildCreateSessionPayload({
      title: "  Warehouse infiltration  ",
      modeId: "scenario_host"
    }), {
      title: "Warehouse infiltration",
      modeId: "scenario_host"
    });
  });

  test("create session payload omits blank title", () => {
    assert.deepEqual(buildCreateSessionPayload({
      title: "   ",
      modeId: "rp_assistant"
    }), {
      modeId: "rp_assistant"
    });
  });
