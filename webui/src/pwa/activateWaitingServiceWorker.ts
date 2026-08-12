export const PWA_ACTIVATION_TIMEOUT_MS = 10_000;

export async function activateWaitingServiceWorker(
  registration: ServiceWorkerRegistration,
  serviceWorkerContainer: ServiceWorkerContainer,
  timeoutMs = PWA_ACTIVATION_TIMEOUT_MS
): Promise<void> {
  const previousController = serviceWorkerContainer.controller;
  const activeWorker = registration.active;
  const activatingWorker = activeWorker
    && activeWorker !== previousController
    && (activeWorker.state === "activating" || activeWorker.state === "activated")
    ? activeWorker
    : null;
  const pendingWorker = registration.waiting ?? registration.installing ?? activatingWorker;

  await new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let observedWorker: ServiceWorker | null = pendingWorker;

    const cleanup = () => {
      serviceWorkerContainer.removeEventListener("controllerchange", handleControllerChange);
      observedWorker?.removeEventListener("statechange", handleStateChange);
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };

    const settle = (callback: () => void) => {
      cleanup();
      callback();
    };

    const handleControllerChange = () => {
      if (serviceWorkerContainer.controller !== previousController) {
        settle(resolve);
      }
    };

    const handleStateChange = () => {
      if (observedWorker?.state === "redundant") {
        settle(() => reject(new Error("WebUI Service Worker 在激活前已失效，请重试")));
        return;
      }
      if (observedWorker?.state === "installed" && registration.waiting === observedWorker) {
        try {
          observedWorker.postMessage({ type: "SKIP_WAITING" });
        } catch (error) {
          settle(() => reject(error));
        }
      }
    };

    serviceWorkerContainer.addEventListener("controllerchange", handleControllerChange);
    observedWorker?.addEventListener("statechange", handleStateChange);
    timeoutId = setTimeout(() => {
      settle(() => reject(new Error("等待 WebUI Service Worker 激活超时，请重试")));
    }, timeoutMs);

    if (serviceWorkerContainer.controller !== previousController) {
      settle(resolve);
      return;
    }

    const waitingWorker = registration.waiting;
    if (waitingWorker) {
      if (observedWorker !== waitingWorker) {
        observedWorker?.removeEventListener("statechange", handleStateChange);
        observedWorker = waitingWorker;
        observedWorker.addEventListener("statechange", handleStateChange);
      }
      try {
        waitingWorker.postMessage({ type: "SKIP_WAITING" });
      } catch (error) {
        settle(() => reject(error));
      }
      return;
    }

    if (!observedWorker) {
      settle(() => reject(new Error("待激活的 WebUI Service Worker 已不存在，请重新检查更新")));
    }
  });
}
