import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("auth store loads simplewebauthn lazily for passkey operations", async () => {
  const source = await readFile(new URL("../../webui/src/stores/auth.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /^import\s+\{[^}]*startAuthentication[^}]*\}\s+from\s+"@simplewebauthn\/browser";$/m);
  assert.doesNotMatch(source, /^import\s+\{[^}]*startRegistration[^}]*\}\s+from\s+"@simplewebauthn\/browser";$/m);
  assert.match(source, /const\s+\{\s*startAuthentication\s*\}\s*=\s*await\s+import\("@simplewebauthn\/browser"\)/);
  assert.match(source, /const\s+\{\s*startRegistration\s*\}\s*=\s*await\s+import\("@simplewebauthn\/browser"\)/);
});

test("auth status probe failures do not become internal login failures", async () => {
  const [storeSource, routerSource, clientSource] = await Promise.all([
    readFile(new URL("../../webui/src/stores/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../../webui/src/router.ts", import.meta.url), "utf8"),
    readFile(new URL("../../webui/src/api/client.ts", import.meta.url), "utf8")
  ]);

  assert.match(storeSource, /async function check\(\): Promise<boolean>/);
  assert.match(storeSource, /checked\.value = false;\s+return false;/s);
  assert.doesNotMatch(storeSource, /catch \{\s+enabled\.value = true;\s+authenticated\.value = false;/s);
  assert.match(routerSource, /if \(!await ensureAuthChecked\(\)\) \{\s+return true;\s+\}/s);
  assert.match(clientSource, /if \(error\.isJson\) \{\s+window\.dispatchEvent\(new CustomEvent\("api:unauthorized"\)\);/s);
});
