import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { ContextEmbeddingService } from "../../src/context/contextEmbeddingService.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("ContextEmbeddingService reports routing and provider availability without probing the network", () => {
  const logger = pino({ level: "silent" });

  const disabled = new ContextEmbeddingService(
    createTestAppConfig({ llm: { enabled: false } }),
    { isEmbeddingConfigured: () => true } as any,
    logger
  );
  assert.deepEqual(disabled.getAvailability(), {
    available: false,
    modelRefs: ["test/embedding"],
    reason: "llm_disabled"
  });

  const notConfigured = new ContextEmbeddingService(
    createTestAppConfig({ llm: { enabled: true }, context: { embedding: { model: null } } }),
    { isEmbeddingConfigured: () => true } as any,
    logger
  );
  assert.deepEqual(notConfigured.getAvailability(), {
    available: false,
    modelRefs: [],
    reason: "model_not_configured"
  });

  const invalidModel = new ContextEmbeddingService(
    createTestAppConfig({ llm: { enabled: true }, context: { embedding: { model: { provider: "test", model: "missing" } } } }),
    { isEmbeddingConfigured: () => true } as any,
    logger
  );
  assert.deepEqual(invalidModel.getAvailability(), {
    available: false,
    modelRefs: ["test/missing"],
    reason: "model_configuration_invalid"
  });

  const unavailable = new ContextEmbeddingService(
    createTestAppConfig({ llm: { enabled: true } }),
    { isEmbeddingConfigured: () => false } as any,
    logger
  );
  assert.deepEqual(unavailable.getAvailability(), {
    available: false,
    modelRefs: ["test/embedding"],
    reason: "model_unavailable"
  });

  const available = new ContextEmbeddingService(
    createTestAppConfig({ llm: { enabled: true } }),
    { isEmbeddingConfigured: () => true } as any,
    logger
  );
  assert.deepEqual(available.getAvailability(), {
    available: true,
    modelRefs: ["test/embedding"]
  });
});

test("ContextEmbeddingService rejects embedding calls while unavailable", async () => {
  const service = new ContextEmbeddingService(
    createTestAppConfig({ llm: { enabled: true }, context: { embedding: { model: null } } }),
    {
      isEmbeddingConfigured: () => false,
      async embedTexts() {
        assert.fail("unavailable embedding must not reach LlmClient");
      }
    } as any,
    pino({ level: "silent" })
  );

  await assert.rejects(
    service.embedTexts(["test"]),
    /Embedding 功能不可用: model_not_configured/
  );
});
