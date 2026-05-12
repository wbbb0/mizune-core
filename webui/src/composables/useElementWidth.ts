import { onMounted, onUnmounted, ref, type Ref } from "vue";

export function useElementWidth(target: Ref<HTMLElement | null>) {
  const width = ref(0);
  let observer: ResizeObserver | null = null;

  function update() {
    width.value = Math.round(target.value?.getBoundingClientRect().width ?? 0);
  }

  onMounted(() => {
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return;
    }
    observer = new ResizeObserver((entries) => {
      width.value = Math.round(entries[0]?.contentRect.width ?? 0);
    });
    if (target.value) {
      observer.observe(target.value);
    }
  });

  onUnmounted(() => {
    observer?.disconnect();
    observer = null;
    window.removeEventListener("resize", update);
  });

  return width;
}
