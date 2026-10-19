import { computed, nextTick, ref, watch, type Ref, type WritableComputedRef } from "vue";
import { api } from "../../api/client.ts";
import { applyCommandCompletion, resolveCommandCompletion, type CommandCompletionDefinition } from "./commandCompletion.ts";

export function useCommandCompletion(text: WritableComputedRef<string>, textarea: Ref<HTMLTextAreaElement | null>) {
  const commands = ref<CommandCompletionDefinition[]>([]);
  const stickerIds = ref<string[]>([]);
  const focused = ref(false);
  const dismissed = ref(false);
  const caret = ref(0);
  const selected = ref(0);
  const hasSelection = ref(false);
  const loadError = ref(false);
  let catalogLoading = false;
  let generation = 0;
  const completion = computed(() => focused.value && !dismissed.value && !hasSelection.value
    ? resolveCommandCompletion(text.value, caret.value, commands.value, stickerIds.value) : null);
  const values = computed(() => completion.value?.values ?? []);
  const hint = computed(() => completion.value?.hint);

  function syncCaret() {
    const el = textarea.value;
    if (!el) return;
    caret.value = el.selectionStart;
    hasSelection.value = el.selectionStart !== el.selectionEnd;
  }
  watch(text, () => { dismissed.value = false; void nextTick(syncCaret); });
  watch(values, () => { selected.value = 0; });
  watch(() => completion.value?.source, async (source) => {
    const current = ++generation;
    stickerIds.value = [];
    loadError.value = false;
    if (source !== "stickerIds") return;
    try {
      const result = await api.get<{ values: string[] }>("/api/command-completions/sticker-ids");
      if (current === generation) stickerIds.value = result.values;
    } catch {
      if (current === generation) loadError.value = true;
    }
  });
  async function focus() {
    focused.value = true;
    dismissed.value = false;
    syncCaret();
    if (commands.value.length || catalogLoading) return;
    catalogLoading = true;
    try {
      commands.value = (await api.get<{ commands: CommandCompletionDefinition[] }>("/api/command-completions")).commands;
    } catch { /* 输入和发送不依赖补全服务；下次聚焦时重试。 */ }
    finally { catalogLoading = false; }
  }
  function blur() { focused.value = false; }
  function accept(index: number) {
    const item = completion.value;
    const value = values.value[index];
    if (!item || !value) return;
    const result = applyCommandCompletion(text.value, item, value, commands.value);
    text.value = result.text;
    void nextTick(() => {
      textarea.value?.focus();
      textarea.value?.setSelectionRange(result.caret, result.caret);
      syncCaret();
    });
  }
  function keydown(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229) return true;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    if (event.key === "Escape" && completion.value) {
      dismissed.value = true;
      event.preventDefault();
      return true;
    }
    if (!values.value.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      selected.value = (selected.value + (event.key === "ArrowDown" ? 1 : -1) + values.value.length) % values.value.length;
      event.preventDefault();
      return true;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      accept(selected.value);
      return true;
    }
    return false;
  }
  return { values, hint, selected, loadError, focus, blur, syncCaret, accept, keydown };
}
