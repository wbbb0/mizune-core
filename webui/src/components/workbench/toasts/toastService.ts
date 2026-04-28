import { ref, type Ref } from "vue";

export interface ToastItem {
  id: number;
  type: "success" | "error" | "info";
  message: string;
}

export type WorkbenchToastService = {
  items: Ref<ToastItem[]>;
  push: (input: {
    type: ToastItem["type"];
    message: string;
    durationMs?: number;
  }) => number;
  dismiss: (id: number) => void;
};

const DEFAULT_TOAST_DURATION_MS = 4000;

export function createWorkbenchToastService(): WorkbenchToastService {
  const items = ref<ToastItem[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;

  function dismiss(id: number) {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
    items.value = items.value.filter((item) => item.id !== id);
  }

  function scheduleDismiss(id: number, durationMs: number) {
    const existing = timers.get(id);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(id, setTimeout(() => {
      dismiss(id);
    }, durationMs));
  }

  function push(input: {
    type: ToastItem["type"];
    message: string;
    durationMs?: number;
  }) {
    const durationMs = input.durationMs ?? DEFAULT_TOAST_DURATION_MS;
    const existing = items.value.find((item) => item.type === input.type && item.message === input.message);
    if (existing) {
      scheduleDismiss(existing.id, durationMs);
      return existing.id;
    }

    const id = nextId++;
    items.value = [{
      id,
      type: input.type,
      message: input.message
    }, ...items.value].slice(0, 5);
    scheduleDismiss(id, durationMs);
    return id;
  }

  return {
    items,
    push,
    dismiss
  };
}
