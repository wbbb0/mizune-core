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
