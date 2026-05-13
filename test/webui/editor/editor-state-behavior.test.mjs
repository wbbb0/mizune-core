import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDraftEffectiveValue,
  computeDraftReferenceValue
} from "../../../packages/vue-resource-editor/src/editorState.ts";

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

function createRoutingPresetModel() {
  return createLayeredModel({
    key: "llm_routing_preset_catalog",
    kind: "single",
    file: { path: "config/llm.routing-presets.yml" },
    editorFeatures: {
      showReferenceBackdrop: false,
      unsetMode: "reference",
      unsetActionLabel: "回退到 default",
      draftEffectiveMode: "routing_preset_catalog"
    }
  });
}

test("routing preset editor effective values update all preset fields without reload", () => {
  const model = createRoutingPresetModel();
  const draft = {
    default: {
      mainSmall: ["base-main"],
      textInspector: ["base-text"],
      embedding: ["base-embedding"],
      historyWindow: {
        maxRecentMessages: 80,
        maxImageReferences: 5
      },
      tokenLimits: {
        triggerTokens: 150000,
        retainTokens: 7000
      }
    },
    balanced: {
      mainSmall: ["balanced-main"],
      historyWindow: {
        maxRecentMessages: 32
      },
      tokenLimits: {
        retainTokens: 3000
      }
    }
  };

  assert.deepEqual(computeDraftReferenceValue(model, draft).balanced.historyWindow, {
    maxRecentMessages: 80,
    maxImageReferences: 5
  });
  assert.deepEqual(computeDraftEffectiveValue(model, draft).balanced, {
    mainSmall: ["balanced-main"],
    mainLarge: [],
    summarizer: [],
    textInspector: ["base-text"],
    sessionCaptioner: [],
    imageCaptioner: [],
    imageInspector: [],
    audioTranscription: [],
    turnPlanner: [],
    embedding: ["base-embedding"],
    historyWindow: {
      maxRecentMessages: 32,
      maxImageReferences: 5
    },
    tokenLimits: {
      triggerTokens: 150000,
      retainTokens: 3000
    }
  });
});
