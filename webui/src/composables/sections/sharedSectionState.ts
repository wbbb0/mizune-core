import { effectScope, watch, type EffectScope } from "vue";
import { onBeforeRouteLeave, useRoute } from "vue-router";

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
    const route = useRoute();
    watch(
      () => route.name ?? route.fullPath,
      (nextRouteKey, previousRouteKey) => {
        if (nextRouteKey !== previousRouteKey) {
          currentState.resetState();
        }
      }
    );
    onBeforeRouteLeave(() => {
      currentState.resetState();
    });
    return currentState;
  };
}
