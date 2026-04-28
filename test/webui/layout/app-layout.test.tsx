import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("desktop layout keeps safe-area padding on the workbench shell, not the activity bar", async () => {
  const workbenchShellSource = await readFile(
    new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url),
    "utf8"
  );
  const topBarSource = await readFile(
    new URL("../../../webui/src/components/workbench/TopBar.vue", import.meta.url),
    "utf8"
  );
  const activityBarSource = await readFile(
    new URL("../../../webui/src/components/workbench/WorkbenchActivityBar.vue", import.meta.url),
    "utf8"
  );
  const composerSource = await readFile(
    new URL("../../../webui/src/components/sessions/Composer.vue", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(workbenchShellSource, /pt-safe/);
  assert.match(topBarSource, /pt-safe/);
  assert.match(activityBarSource, /navItems/);
  assert.match(activityBarSource, /emit\('navigate'/);
  assert.doesNotMatch(activityBarSource, /useRouter/);
  assert.doesNotMatch(activityBarSource, /useRoute/);
  assert.doesNotMatch(activityBarSource, /export const primaryNavItems/);
  assert.doesNotMatch(activityBarSource, /export const bottomNavItems/);
  assert.doesNotMatch(activityBarSource, /class="[^"]*\bpt-safe\b/);
  assert.doesNotMatch(activityBarSource, /class="[^"]*\bpb-safe\b/);
  assert.match(composerSource, /marginBottom:\s*keyboardInsetPx\.value > 0/);
  assert.match(composerSource, /paddingBottom:\s*ui\.isMobile && keyboardInsetPx\.value === 0/);
  assert.match(composerSource, /const composerRootRef\s*=\s*ref<HTMLElement \| null>\(null\)/);
  assert.match(composerSource, /useWorkbenchRuntimeContext/);
  assert.match(composerSource, /keyboardAvoidanceBoundary/);
  assert.doesNotMatch(composerSource, /const keyboardAvoidanceTarget\s*=\s*computed\(\(\) => composerRootRef\.value\?\.parentElement \?\? null\)/);
  assert.match(composerSource, /useVisualViewportInset\(\{\s*target:\s*keyboardAvoidanceTarget\s*\}\)/);
  assert.doesNotMatch(composerSource, /ui\.isDesktop \|\| keyboardInsetPx\.value > 0/);
  assert.match(composerSource, /draftText\?: string/);
  assert.match(composerSource, /draftTextChange: \[text: string\]/);
  assert.match(composerSource, /get:\s*\(\) => props\.draftText \?\? ""/);
  assert.match(composerSource, /:accept="COMPOSER_IMAGE_ACCEPT"/);
  assert.doesNotMatch(composerSource, /audio\/\*|video\/\*|\\.pdf|\\.txt|\\.json|\\.yaml|\\.yml|\\.md/);
  assert.match(composerSource, /function uploadImageFiles\(files: File\[\]\)/);
  assert.match(composerSource, /@dragenter="onDragEnter"/);
  assert.match(composerSource, /@dragover="onDragOver"/);
  assert.match(composerSource, /@drop="onDrop"/);
});
