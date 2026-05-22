import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("webui service worker lets nginx auth redirects win before cached navigation fallback", async () => {
  const source = await readFile(new URL("../../../webui/src/sw.ts", import.meta.url), "utf8");

  assert.match(source, /self\.skipWaiting\(\)/);
  assert.match(source, /clientsClaim\(\)/);
  assert.match(source, /const response = await fetch\(request\)/);
  assert.match(source, /if \(response\.status < 500\) \{\s+return response;\s+\}/s);
  assert.match(source, /matchPrecache\(webuiIndexUrl\)/);
  assert.match(source, /new NavigationRoute\(\(\{ request \}\) => handleNavigation\(request\)/);
  assert.match(source, /denylist:\s*\[\/\^\\\/api\\\//);
  assert.match(source, /new NetworkOnly\(\)/);
});
