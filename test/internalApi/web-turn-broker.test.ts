import test from "node:test";
import assert from "node:assert/strict";
import { createWebTurnBroker } from "../../src/internalApi/application/webTurnBroker.ts";

test("web turn broker preserves overlay event ordering", () => {
  const broker = createWebTurnBroker();
  const turn = broker.create("s1");
  const seen: string[] = [];

  broker.publish(turn, {
    type: "ready",
    turnId: turn.turnId,
    sessionId: "s1",
    timestampMs: 1
  });
  broker.publish(turn, {
    type: "draft_delta",
    turnId: turn.turnId,
    sessionId: "s1",
    delta: "你",
    timestampMs: 2
  });
  broker.publish(turn, {
    type: "segment_committed",
    turnId: turn.turnId,
    sessionId: "s1",
    timestampMs: 3
  });
  broker.publish(turn, {
    type: "complete",
    turnId: turn.turnId,
    sessionId: "s1",
    timestampMs: 4
  });

  const stream = broker.getStream("s1", turn.turnId);
  for (const event of stream.initialEvents) {
    seen.push(event.type);
  }

  assert.deepEqual(seen, ["ready", "draft_delta", "segment_committed", "complete"]);
});
