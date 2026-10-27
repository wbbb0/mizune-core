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
import { computed, onBeforeUnmount, reactive, ref, watch } from ${JSON.stringify(vueUrl)};
export function setup(input, api) {
 const defineProps = () => input;
 const sessionsApi = api;
 const useElementWidth = () => ({ value: 800 });
 const useWorkbenchWindows = () => ({});
 class ApiError extends Error {}
 ${body}
 return { state, loading, error, refresh };
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


test("切换会话后忽略旧响应，失败保留已加载状态且可重试", async () => {
  const props = reactive({ session: { id: "first", modeId: "stateful_rp", transcriptCount: 0, mutationEpoch: 0, phase: { kind: "idle" } } });
  const pending: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];
  const scope = effectScope();
  const panel = scope.run(() => module.setup(props, { fetchDetail: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }));
  try {
    assert.equal(panel.loading.value, true);
    assert.equal(panel.state.value, null);
    props.session.id = "second";
    await nextTick();
    pending[1]!.resolve({ modeState: { kind: "stateful_rp", state: { revision: "current", initialized: true } } });
    await nextTick(); await nextTick();
    pending[0]!.resolve({ modeState: { kind: "stateful_rp", state: { revision: "stale" } } });
    await nextTick(); await nextTick();
    assert.equal(panel.state.value.revision, "current");
    const failed = panel.refresh();
    pending[2]!.reject(new Error("加载失败"));
    await failed;
    assert.equal(panel.error.value, "加载失败");
    assert.equal(panel.state.value.revision, "current");
    assert.equal(panel.loading.value, false);
    const retry = panel.refresh();
    assert.equal(panel.error.value, "");
    pending[3]!.resolve({ modeState: null });
    await retry;
    assert.equal(panel.state.value, null);
  } finally { scope.stop(); }
});
