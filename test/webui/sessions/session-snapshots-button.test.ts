import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const base = new URL("../../../webui/src/components/sessions/", import.meta.url);
test("两种状态面板共用存档入口，读档刷新只针对原会话", async () => {
  for (const file of ["ScenarioHostPanel.vue", "StatefulRpPanel.vue"]) {
    const source = readFileSync(new URL(file, base), "utf8");
    assert.match(source, /<SessionSnapshotsButton[^>]*:session-id="session.id"[^>]*@restored=/);
  }
  const source = readFileSync(new URL("SessionSnapshotsButton.vue", base), "utf8").match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!;
  const body = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText.replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, "");
  const module = await import(`data:text/javascript,${encodeURIComponent(`
    export function setup(props, windowService, emit) {
      const defineProps = () => props, defineEmits = () => emit;
      const computed = fn => ({ get value() { return fn(); } });
      const useWorkbenchWindows = () => windowService;
      const ScenarioHostSnapshotDialogContent = {};
      const createSessionWindowContext = id => ({ id });
      ${body.replace("const props = defineProps();", "").replace("const emit = defineEmits();", "")}
      return openSnapshotsDialog;
    }
  `)}`);
  const props = { sessionId: "one", sessionGenerating: false };
  let dialog: any;
  let restored = 0;
  module.setup(props, { openDialog: (value: unknown) => { dialog = value; } }, () => { restored++; })();
  assert.equal(dialog.blocks[0].props.sessionId, "one");
  props.sessionGenerating = true;
  assert.equal(dialog.blocks[0].props.sessionGenerating.value, true);
  dialog.blocks[0].props.onRestored();
  assert.equal(restored, 1);
  props.sessionId = "two";
  dialog.blocks[0].props.onRestored();
  assert.equal(restored, 1);
});
