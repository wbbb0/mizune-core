import test from "node:test";
import assert from "node:assert/strict";
import { computeDraftEffectiveValue } from "../../../packages/vue-resource-editor/src/editorState.ts";

function createLayeredModel(overrides = {}) {
  return {
    key: "config",
    title: "运行时配置",
    editable: true,
    kind: "layered",
    writableLayerKey: "instance",
    layers: [],
    schemaMeta: {
      kind: "object",
      optional: false,
      hasDefault: false
    },
    uiTree: {
      kind: "group",
      schema: {
        kind: "object",
        optional: false,
        hasDefault: false
      },
      children: {}
    },
    template: {},
    schemaDefaultValue: {},
    currentValue: {},
    referenceValue: {},
    effectiveValue: {},
    editorFeatures: {
      showReferenceBackdrop: true,
      unsetMode: "reference",
      unsetActionLabel: "恢复继承",
      draftEffectiveMode: "merge_reference"
    },
    ...overrides
  };
}

test("merge_reference effective values layer schema defaults below reference and draft", () => {
  const model = createLayeredModel({
    schemaDefaultValue: {
      scheduler: {
        enabled: true,
        defaultTimezone: "Asia/Shanghai"
      },
      internalApi: {
        enabled: false,
        port: 3030
      }
    },
    referenceValue: {
      scheduler: {
        enabled: false
      }
    }
  });

  assert.deepEqual(
    computeDraftEffectiveValue(model, {
      internalApi: {
        port: 4040
      }
    }),
    {
      scheduler: {
        enabled: false,
        defaultTimezone: "Asia/Shanghai"
      },
      internalApi: {
        enabled: false,
        port: 4040
      }
    }
  );
});

test("merge_reference effective values preserve explicit null overrides", () => {
  const model = createLayeredModel({
    schemaDefaultValue: {
      shell: {
        sessionTtlMs: null
      }
    },
    referenceValue: {
      shell: {
        sessionTtlMs: 60000
      }
    }
  });

  assert.deepEqual(
    computeDraftEffectiveValue(model, {
      shell: {
        sessionTtlMs: null
      }
    }),
    {
      shell: {
        sessionTtlMs: null
      }
    }
  );
});

test("merge_reference effective values allow null to replace an object", () => {
  const model = createLayeredModel({
    schemaDefaultValue: {
      shell: {
        terminalEvents: {
          enabled: true
        }
      }
    },
    referenceValue: {
      shell: {
        terminalEvents: {
          inputDetectionDebounceMs: 800
        }
      }
    }
  });

  assert.deepEqual(
    computeDraftEffectiveValue(model, {
      shell: {
        terminalEvents: null
      }
    }),
    {
      shell: {
        terminalEvents: null
      }
    }
  );
});
