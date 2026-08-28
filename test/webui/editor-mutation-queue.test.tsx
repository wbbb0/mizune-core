import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeProviderMutation,
  reconcileProviderMutations,
  resolveProviderMutationSource,
  type LlmCatalogProviderMutation
} from "../../webui/src/api/editorMutationQueue.ts";

test("provider mutation queue merges consecutive renames against the persisted source", () => {
  let mutations: LlmCatalogProviderMutation[] = [];
  mutations = mergeProviderMutation(mutations, {
    kind: "rename_provider",
    provider: "alpha",
    nextProvider: "beta"
  });

  assert.equal(resolveProviderMutationSource(mutations, "beta"), "alpha");
  mutations = mergeProviderMutation(mutations, {
    kind: "rename_provider",
    provider: "beta",
    nextProvider: "gamma"
  });

  assert.deepEqual(mutations, [{
    kind: "rename_provider",
    provider: "alpha",
    nextProvider: "gamma"
  }]);
});

test("provider mutation queue cancels a rename returned to its persisted key", () => {
  const renamed = mergeProviderMutation([], {
    kind: "rename_provider",
    provider: "alpha",
    nextProvider: "beta"
  });
  const restored = mergeProviderMutation(renamed, {
    kind: "rename_provider",
    provider: "beta",
    nextProvider: "alpha"
  });

  assert.deepEqual(restored, []);
});

test("provider mutation queue collapses rename then delete into source deletion", () => {
  const renamed = mergeProviderMutation([], {
    kind: "rename_provider",
    provider: "alpha",
    nextProvider: "beta"
  });
  const deleted = mergeProviderMutation(renamed, {
    kind: "delete_provider",
    provider: "beta"
  });

  assert.deepEqual(deleted, [{ kind: "delete_provider", provider: "alpha" }]);
});

test("provider mutation queue drops operations undone by restoring the draft", () => {
  assert.deepEqual(reconcileProviderMutations([
    { kind: "rename_provider", provider: "alpha", nextProvider: "beta" },
    { kind: "delete_provider", provider: "gamma" }
  ], {
    alpha: { models: {} },
    gamma: { models: {} }
  }, {
    alpha: { models: {} },
    gamma: { models: {} }
  }), []);
});

test("provider mutation queue does not mistake a same-alias replacement for undo", () => {
  assert.deepEqual(reconcileProviderMutations([
    { kind: "delete_provider", provider: "alpha" }
  ], {
    alpha: { type: "deepseek", models: {} }
  }, {
    alpha: { type: "openai", models: {} }
  }), [{ kind: "delete_provider", provider: "alpha" }]);
});
