import test from "node:test";
import assert from "node:assert/strict";
import { activateWaitingServiceWorker } from "../../../webui/src/pwa/activateWaitingServiceWorker.js";

class FakeWaitingWorker extends EventTarget {
  state: ServiceWorkerState = "installed";
  messages: unknown[] = [];

  postMessage(message: unknown) {
    this.messages.push(message);
  }
}

class FakeServiceWorkerContainer extends EventTarget {
  controller: ServiceWorker | null = null;

  switchController() {
    this.controller = {} as ServiceWorker;
    this.dispatchEvent(new Event("controllerchange"));
  }
}

test("activates the exact waiting worker and resolves after controllerchange", async () => {
  const worker = new FakeWaitingWorker();
  const container = new FakeServiceWorkerContainer();
  const registration = { waiting: worker } as unknown as ServiceWorkerRegistration;

  const activation = activateWaitingServiceWorker(
    registration,
    container as unknown as ServiceWorkerContainer,
    100
  );

  assert.deepEqual(worker.messages, [{ type: "SKIP_WAITING" }]);
  container.switchController();
  await activation;
});

test("waits for another tab to finish an active worker's activation", async () => {
  const worker = new FakeWaitingWorker();
  worker.state = "activating";
  const container = new FakeServiceWorkerContainer();
  const registration = {
    waiting: null,
    installing: null,
    active: worker
  } as unknown as ServiceWorkerRegistration;

  const activation = activateWaitingServiceWorker(
    registration,
    container as unknown as ServiceWorkerContainer,
    100
  );

  assert.deepEqual(worker.messages, []);
  container.switchController();
  await activation;
});

test("rejects instead of hanging when no waiting worker exists", async () => {
  const container = new FakeServiceWorkerContainer();
  const registration = { waiting: null } as ServiceWorkerRegistration;

  await assert.rejects(
    activateWaitingServiceWorker(registration, container as unknown as ServiceWorkerContainer, 100),
    /已不存在/
  );
});

test("rejects after activation timeout", async () => {
  const worker = new FakeWaitingWorker();
  const container = new FakeServiceWorkerContainer();
  const registration = { waiting: worker } as unknown as ServiceWorkerRegistration;

  await assert.rejects(
    activateWaitingServiceWorker(registration, container as unknown as ServiceWorkerContainer, 5),
    /激活超时/
  );
});

test("rejects when the pending worker becomes redundant", async () => {
  const worker = new FakeWaitingWorker();
  const container = new FakeServiceWorkerContainer();
  const registration = { waiting: worker } as unknown as ServiceWorkerRegistration;

  const activation = activateWaitingServiceWorker(
    registration,
    container as unknown as ServiceWorkerContainer,
    100
  );
  worker.state = "redundant";
  worker.dispatchEvent(new Event("statechange"));

  await assert.rejects(activation, /已失效/);
});
