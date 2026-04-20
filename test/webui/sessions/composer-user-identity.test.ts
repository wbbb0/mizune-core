import assert from "node:assert/strict";
import {
  resolveComposerUserIdentity
} from "../../../webui/src/components/sessions/composerUserIdentity.ts";

async function runCase(name: string, fn: () => Promise<void> | void) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("web private sessions lock the participant user id", () => {
    assert.deepEqual(resolveComposerUserIdentity({
      session: {
        type: "private",
        source: "web",
        participantRef: { kind: "user", id: "owner" }
      },
      ownerId: "owner"
    }), {
      lockedUserId: "owner",
      defaultUserId: undefined
    });
  });

  await runCase("onebot private sessions lock the participant user id", () => {
    assert.deepEqual(resolveComposerUserIdentity({
      session: {
        type: "private",
        source: "onebot",
        participantRef: { kind: "user", id: "owner" }
      },
      ownerId: "owner"
    }), {
      lockedUserId: "owner",
      defaultUserId: undefined
    });
  });

  await runCase("group sessions keep editable user id with owner default", () => {
    assert.deepEqual(resolveComposerUserIdentity({
      session: {
        type: "group",
        source: "onebot",
        participantRef: { kind: "group", id: "room:20001" }
      },
      ownerId: "owner"
    }), {
      lockedUserId: undefined,
      defaultUserId: "owner"
    });
  });
}

void main();
