import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createAppSetupSupport } from "../../src/app/bootstrap/appSetupSupport.ts";

test("synchronous session mutations persist one latest snapshot", async () => {
  const saved: number[] = [];
  let revision = 1;
  const { persistSession } = createAppSetupSupport({
    logger: pino({ level: "silent" }),
    sessionManager: { getPersistedSession: () => ({ revision }) },
    sessionPersistence: { async save(snapshot: { revision: number }) { saved.push(snapshot.revision); } }
  } as any);
  persistSession("s", "first");
  revision = 2;
  persistSession("s", "second");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(saved, [2]);
});

test("deleting a session before the queued snapshot prevents a stale save", async () => {
  let exists = true;
  let saves = 0;
  const { persistSession } = createAppSetupSupport({
    logger: pino({ level: "silent" }),
    sessionManager: { getPersistedSession() { if (!exists) throw new Error("Session not found"); return {}; } },
    sessionPersistence: { async save() { saves++; } }
  } as any);
  persistSession("s", "changed");
  exists = false;
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(saves, 0);
});
