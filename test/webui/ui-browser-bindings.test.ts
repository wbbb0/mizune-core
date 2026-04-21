import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("ui browser bindings stay outside the store and are installed from the webui entrypoint", async () => {
  const [uiStoreSource, browserBindingsSource, mainSource] = await Promise.all([
    readFile(new URL("../../webui/src/stores/ui.ts", import.meta.url), "utf8"),
    readFile(new URL("../../webui/src/composables/useUiBrowserBindings.ts", import.meta.url), "utf8"),
    readFile(new URL("../../webui/src/main.ts", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(uiStoreSource, /\bwindow\./);
  assert.doesNotMatch(uiStoreSource, /\bdocument\./);
  assert.doesNotMatch(uiStoreSource, /addEventListener\(/);
  assert.match(uiStoreSource, /function setSystemDark\(/);
  assert.match(uiStoreSource, /function setWindowWidth\(/);

  assert.match(browserBindingsSource, /export function useUiBrowserBindings\(/);
  assert.match(browserBindingsSource, /watch\(\s*\(\) => ui\.dark/);
  assert.match(browserBindingsSource, /window\.matchMedia\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(browserBindingsSource, /window\.addEventListener\("resize"/);
  assert.match(browserBindingsSource, /window\.visualViewport\?\.addEventListener\("resize"/);
  assert.match(browserBindingsSource, /document\.documentElement\.dataset\.theme/);
  assert.match(browserBindingsSource, /return \(\) => \{/);

  assert.match(mainSource, /useUiBrowserBindings/);
  assert.match(mainSource, /useUiStore\(pinia\)/);
  assert.match(mainSource, /cleanupUiBrowserBindings/);
});
