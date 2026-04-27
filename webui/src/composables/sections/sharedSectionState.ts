import { effectScope, type EffectScope } from "vue";
import { onBeforeRouteLeave } from "vue-router";

type ResettableSectionState = {
  resetState: () => void;
};

export function createSharedSectionState<TState extends ResettableSectionState>(
  createState: () => TState
): () => TState {
  let state: TState | null = null;
  let scope: EffectScope | null = null;

  function getState() {
    if (!state) {
      scope = effectScope(true);
      state = scope.run(createState) ?? null;
    }
    if (!state) {
      throw new Error("初始化共享页面状态失败");
    }
    return state;
  }

  return function useSharedSectionState() {
    const currentState = getState();
    onBeforeRouteLeave(() => {
      currentState.resetState();
    });
    return currentState;
  };
}
