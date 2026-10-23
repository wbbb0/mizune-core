import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createAppSetupSupport } from "../../src/app/bootstrap/appSetupSupport.ts";
import { SetupStateStore } from "../../src/identity/setupStateStore.ts";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { characterRepository } from "../../src/character/repository.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("OneBot 初始化通知以新档案确认状态为准，留空确认后不重复催填", async t => {
  const dir = mkdtempSync(join(tmpdir(), "character-bootstrap-"));
  const logger = pino({ level: "silent" });
  const database = new StateDatabase(dir, logger);
  const characters = characterRepository(dir);
  t.after(() => { database.close(); characters.close(); rmSync(dir, { recursive: true, force: true }); });
  const setupStore = new SetupStateStore(dir, createTestAppConfig(), { hasOwnerIdentity: async () => true }, logger, database);
  await setupStore.init({ name: "旧名", temperament: "旧性格", voiceStyle: "旧语气" });
  const sent: string[] = [];
  const support = createAppSetupSupport({
    setupStore, logger,
    oneBotClient: { async sendText(input: { text: string }) { sent.push(input.text); } },
    userIdentityStore: { async findIdentityByInternalUserId() { return { externalId: "100" }; } }
  } as never);
  await support.notifyOwnerSetupIfNeeded();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /persona/);
  assert.match(sent[0]!, /留空/);
  assert.match(sent[0]!, /\.confirm/);
  characters.begin("s", "persona", "setup", "assistant");
  characters.confirm("s", "assistant");
  await support.notifyOwnerSetupIfNeeded({ force: true });
  assert.equal(sent.length, 1);
  assert.match(await support.buildSetupInstructionText(), /基础人格已确认/);
  assert.equal((await setupStore.get()).state, "ready");
});
