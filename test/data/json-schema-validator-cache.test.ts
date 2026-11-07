import assert from "node:assert/strict";
import test from "node:test";
import { Ajv, type AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { JsonSchemaValidatorCache } from "../../src/utils/jsonSchemaValidatorCache.ts";

test("equivalent projected schemas reuse one compiled validator", () => {
  let compilers = 0;
  const cache = new JsonSchemaValidatorCache(() => {
    compilers++;
    return new Ajv();
  });
  const schema = { type: "object", required: ["value"], properties: { value: { type: "string" } } };
  const validator = cache.get(schema);
  for (let i = 0; i < 500; i++) {
    assert.equal(cache.get(structuredClone(schema)), validator);
  }
  assert.equal(compilers, 1);
  assert.equal(validator({ value: "ok" }), true);
  assert.equal(validator({ value: 1 }), false);
});

test("LRU eviction recompiles evicted entries and preserves validators still in use", () => {
  let compilers = 0;
  const cache = new JsonSchemaValidatorCache(() => {
    compilers++;
    return new Ajv();
  }, { maxEntries: 2 });
  const first = cache.get({ const: 1 });
  const second = cache.get({ const: 2 });
  assert.equal(cache.get({ const: 1 }), first);
  cache.get({ const: 3 });
  assert.notEqual(cache.get({ const: 2 }), second);
  assert.equal(compilers, 4);
  assert.equal(first(1), true);
  assert.equal(first(2), false);
});

test("oversized schemas validate without being retained in the cache", () => {
  let compilers = 0;
  const cache = new JsonSchemaValidatorCache(() => {
    compilers++;
    return new Ajv();
  }, { maxSchemaBytes: 32 });
  const schema = { const: "a".repeat(64) };
  assert.equal(cache.get(schema)(schema.const), true);
  assert.equal(cache.get(schema)(schema.const), true);
  assert.equal(compilers, 2);
});

test("schemas with the same id remain isolated across revisions and eviction", () => {
  const cache = new JsonSchemaValidatorCache(() => new Ajv2020(), { maxEntries: 1 });
  const makeSchema = (type: "string" | "number") => ({
    $id: "https://mizune.test/schema",
    type: "object",
    $defs: { value: { $id: "value", type } },
    properties: { value: { $ref: "value" } },
    required: ["value"]
  });
  const original = cache.get(makeSchema("string"));
  const revised = cache.get(makeSchema("number"));
  assert.equal(original({ value: "ok" }), true);
  assert.equal(original({ value: 2 }), false);
  assert.equal(revised({ value: 2 }), true);
  assert.equal(revised({ value: "ok" }), false);
  assert.equal(cache.get(makeSchema("string"))({ value: "again" }), true);
});

test("mutating a caller-owned schema does not alter a cached validator", () => {
  const cache = new JsonSchemaValidatorCache(() => new Ajv());
  const schema = { enum: ["first"] };
  const first = cache.get(schema);
  schema.enum.push("second");
  assert.equal(first("second"), false);
  assert.equal(cache.get(schema)("second"), true);
});

test("failed compilation does not poison later schemas with the same id", () => {
  const cache = new JsonSchemaValidatorCache(() => new Ajv());
  const invalid = { $id: "https://mizune.test/retry", type: "invalid" } as unknown as AnySchema;
  assert.throws(() => cache.get(invalid));
  assert.equal(cache.get({ $id: "https://mizune.test/retry", type: "string" })("ok"), true);
});
