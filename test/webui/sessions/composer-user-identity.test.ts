import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveComposerUserIdentity
} from "../../../webui/src/components/sessions/composerUserIdentity.ts";

  test("web private sessions lock the participant user id", () => {
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

  test("onebot private sessions lock the participant user id", () => {
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

  test("group sessions keep editable user id with owner default", () => {
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
