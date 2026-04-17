import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("desktop layout keeps top safe-area padding on root container", async () => {
    const appLayoutSource = await readFile(
      new URL("../../../webui/src/components/layout/AppLayout.vue", import.meta.url),
      "utf8"
    );
    const activityBarSource = await readFile(
      new URL("../../../webui/src/components/layout/ActivityBar.vue", import.meta.url),
      "utf8"
    );

    assert.match(
      appLayoutSource,
      /:class="ui\.isMobile \? 'fixed inset-0' : 'relative pt-safe'"/
    );
    assert.doesNotMatch(activityBarSource, /class="[^"]*\bpt-safe\b/);
  });
}

void main();
