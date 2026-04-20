import assert from "node:assert/strict";
import { createSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { SessionInternalTriggerQueue } from "../../src/conversation/session/sessionInternalTriggerQueue.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`- ${name} ... ok`);
  } catch (error) {
    console.error(`- ${name} ... failed`);
    throw error;
  }
}

async function main() {
  await runCase("internal trigger queue keeps fifo order and accurate size", async () => {
    const queue = new SessionInternalTriggerQueue();
    const session = createSessionState({ id: "qqbot:p:test", type: "private" });

    assert.equal(queue.hasPending(session), false);
    assert.equal(queue.getSize(session), 0);

    const sizeAfterFirst = queue.enqueue(session, {
      kind: "scheduled_instruction",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "job-a",
      instruction: "first",
      enqueuedAt: 1
    });
    const sizeAfterSecond = queue.enqueue(session, {
      kind: "scheduled_instruction",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "job-b",
      instruction: "second",
      enqueuedAt: 2
    });

    assert.equal(sizeAfterFirst, 1);
    assert.equal(sizeAfterSecond, 2);
    assert.equal(queue.hasPending(session), true);
    assert.equal(queue.getSize(session), 2);
    assert.equal(queue.shift(session)?.jobName, "job-a");
    assert.equal(queue.getSize(session), 1);
    assert.equal(queue.shift(session)?.jobName, "job-b");
    assert.equal(queue.shift(session), null);
    assert.equal(queue.hasPending(session), false);
    assert.equal(queue.getSize(session), 0);
  });
}

void main();
