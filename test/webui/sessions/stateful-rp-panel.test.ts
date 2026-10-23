import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { effectScope, nextTick, reactive } from "vue";

// 执行面板的真实响应式逻辑，仅替换接口和窗口服务。
const source = readFileSync(new URL("../../../webui/src/components/sessions/StatefulRpPanel.vue", import.meta.url), "utf8").match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!;
const body = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  .replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, "");
const vueUrl = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const module = await import(`data:text/javascript,${encodeURIComponent(`
import { computed, ref, watch } from ${JSON.stringify(vueUrl)};
export function setup(input, api) {
 const defineProps = () => input;
 const sessionsApi = api;
 const useWorkbenchWindows = () => ({});
 class ApiError extends Error {}
 ${body}
 return { state };
}`)}`);

test("后台结算结束与读档无需新增消息即可刷新", async () => {
  const props = reactive({ session: { id: "s", modeId: "stateful_rp", transcriptCount: 1, mutationEpoch: 0, phase: { kind: "delivering" } } });
  let revision = "before";
  let calls = 0;
  const scope = effectScope();
  const panel = scope.run(() => module.setup(props, { fetchDetail: async () => {
    calls++;
    return { session: { isGenerating: false }, modeState: { kind: "stateful_rp", state: { revision } } };
  } }));
  try {
    await nextTick();
    assert.equal(calls, 1);
    revision = "after";
    props.session.phase.kind = "idle";
    await nextTick(); await nextTick();
    assert.equal(panel.state.value.revision, "after");
    assert.equal(props.session.transcriptCount, 1);
    revision = "restored";
    props.session.mutationEpoch++;
    await nextTick(); await nextTick();
    assert.equal(panel.state.value.revision, "restored");
  } finally { scope.stop(); }
});
