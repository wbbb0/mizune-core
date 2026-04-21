import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("config page is a thin section host entrypoint", async () => {
  const source = await readFile(
    new URL("../../../webui/src/pages/ConfigPage.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /<SectionHost section-id="config"\s*\/>/);
  assert.doesNotMatch(source, /AppLayout/);
  assert.doesNotMatch(source, /useConfigSection/);
});

test("settings page is a thin section host entrypoint", async () => {
  const source = await readFile(
    new URL("../../../webui/src/pages/SettingsPage.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /<SectionHost section-id="settings"\s*\/>/);
  assert.doesNotMatch(source, /AppLayout/);
  assert.doesNotMatch(source, /useSettingsSection/);
});

test("workspace page is a thin section host entrypoint", async () => {
  const source = await readFile(
    new URL("../../../webui/src/pages/WorkspacePage.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /<SectionHost section-id="files"\s*\/>/);
  assert.doesNotMatch(source, /AppLayout/);
  assert.doesNotMatch(source, /useWorkspaceSection/);
});

test("sessions page is a thin section host entrypoint", async () => {
  const source = await readFile(
    new URL("../../../webui/src/pages/SessionsPage.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /<SectionHost section-id="sessions"\s*\/>/);
  assert.doesNotMatch(source, /AppLayout/);
  assert.doesNotMatch(source, /useSessionsSection/);
});

test("config section registers list main and mobile header panes", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/config/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /export const configSection/);
  assert.match(source, /id: "config"/);
  assert.match(source, /title: "配置"/);
  assert.match(source, /listPane: ConfigListPane/);
  assert.match(source, /mainPane: ConfigMainPane/);
  assert.match(source, /mobileHeader: ConfigMobileHeader/);
  assert.match(source, /mobileMainFlow: "list-main"/);
  assert.doesNotMatch(source, /routeName/);
  assert.doesNotMatch(source, /auxMode/);
  assert.doesNotMatch(source, /defaults/);
});

test("data page is a thin section host entrypoint", async () => {
  const source = await readFile(
    new URL("../../../webui/src/pages/DataPage.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /<SectionHost section-id="data"\s*\/>/);
  assert.doesNotMatch(source, /AppLayout/);
  assert.doesNotMatch(source, /useDataSection/);
});

test("data section registers list main and mobile header panes", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/data/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /export const dataSection/);
  assert.match(source, /id: "data"/);
  assert.match(source, /title: "数据"/);
  assert.match(source, /listPane: DataListPane/);
  assert.match(source, /mainPane: DataMainPane/);
  assert.match(source, /mobileHeader: DataMobileHeader/);
  assert.match(source, /mobileMainFlow: "list-main"/);
  assert.doesNotMatch(source, /routeName/);
  assert.doesNotMatch(source, /auxMode/);
  assert.doesNotMatch(source, /defaults/);
});

test("settings section registers list main and mobile header panes", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/settings/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /export const settingsSection/);
  assert.match(source, /id: "settings"/);
  assert.match(source, /title: "设置"/);
  assert.match(source, /listPane: SettingsListPane/);
  assert.match(source, /mainPane: SettingsMainPane/);
  assert.match(source, /mobileHeader: SettingsMobileHeader/);
  assert.match(source, /mobileMainFlow: "list-main"/);
  assert.doesNotMatch(source, /routeName/);
  assert.doesNotMatch(source, /auxMode/);
  assert.doesNotMatch(source, /defaults/);
});

test("workspace section registers list main and mobile header panes", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/workspace/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /export const workspaceSection/);
  assert.match(source, /id: "files"/);
  assert.match(source, /title: "文件"/);
  assert.match(source, /listPane: WorkspaceListPane/);
  assert.match(source, /mainPane: WorkspaceMainPane/);
  assert.match(source, /mobileHeader: WorkspaceMobileHeader/);
  assert.match(source, /mobileMainFlow: "list-main"/);
  assert.doesNotMatch(source, /routeName/);
  assert.doesNotMatch(source, /auxMode/);
  assert.doesNotMatch(source, /defaults/);
});

test("sessions section registers list main and mobile header panes", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/sessions/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /export const sessionsSection/);
  assert.match(source, /id: "sessions"/);
  assert.match(source, /title: "会话"/);
  assert.match(source, /listPane: SessionsListPane/);
  assert.match(source, /mainPane: SessionsMainPane/);
  assert.match(source, /mobileHeader: SessionsMobileHeader/);
  assert.match(source, /mobileMainFlow: "list-main"/);
  assert.doesNotMatch(source, /routeName/);
  assert.doesNotMatch(source, /auxMode/);
  assert.doesNotMatch(source, /defaults/);
});

test("config section state resets on route leave and refreshes resources through the list pane", async () => {
  const sectionSource = await readFile(
    new URL("../../../webui/src/composables/sections/useConfigSection.ts", import.meta.url),
    "utf8"
  );
  const listPaneSource = await readFile(
    new URL("../../../webui/src/sections/config/ConfigListPane.vue", import.meta.url),
    "utf8"
  );

  assert.match(sectionSource, /onBeforeRouteLeave/);
  assert.match(sectionSource, /function resetState\(\)/);
  assert.match(sectionSource, /refreshResources/);
  assert.match(sectionSource, /let stateVersion = 0;/);
  assert.match(sectionSource, /function isStale\(requestVersion: number\)/);
  assert.match(sectionSource, /onBeforeRouteLeave\(\(\) => \{\s*sharedState\?\.resetState\(\);/);
  assert.match(listPaneSource, /onMounted/);
  assert.match(listPaneSource, /refreshResources/);
});

test("settings section state resets on route leave and uses mobile main switching on selection", async () => {
  const sectionSource = await readFile(
    new URL("../../../webui/src/composables/sections/useSettingsSection.ts", import.meta.url),
    "utf8"
  );
  const listPaneSource = await readFile(
    new URL("../../../webui/src/sections/settings/SettingsListPane.vue", import.meta.url),
    "utf8"
  );
  const mainPaneSource = await readFile(
    new URL("../../../webui/src/sections/settings/SettingsMainPane.vue", import.meta.url),
    "utf8"
  );

  assert.match(sectionSource, /onBeforeRouteLeave/);
  assert.match(sectionSource, /function resetState\(\)/);
  assert.match(sectionSource, /function initializeSection\(\)/);
  assert.match(sectionSource, /activeItem: Ref<"auth" \| "logout" \| null>/);
  assert.match(sectionSource, /const activeItem = ref<"auth" \| "logout" \| null>\(null\)/);
  assert.match(sectionSource, /function selectItem\(/);
  assert.match(sectionSource, /function refreshSettings\(/);
  assert.match(sectionSource, /function submitPasswordChange\(/);
  assert.match(sectionSource, /function registerPasskey\(/);
  assert.match(sectionSource, /function removePasskey\(/);
  assert.match(sectionSource, /function logout\(/);
  assert.match(sectionSource, /let stateVersion = 0;/);
  assert.match(sectionSource, /function isStale\(requestVersion: number\)/);
  assert.doesNotMatch(sectionSource, /activeItem\.value = "auth"/);
  assert.match(sectionSource, /onBeforeRouteLeave\(\(\) => \{\s*sharedState\?\.resetState\(\);/);
  assert.match(listPaneSource, /onMounted/);
  assert.match(listPaneSource, /initializeSection/);
  assert.match(mainPaneSource, /v-if="!activeItem"/);
  assert.match(mainPaneSource, /选择一个设置项/);
  assert.match(mainPaneSource, /submitPasswordChange/);
  assert.match(mainPaneSource, /registerPasskey/);
  assert.match(mainPaneSource, /removePasskey/);
  assert.match(mainPaneSource, /logout/);
});

test("data section state resets on route leave and uses mobile main switching on selection", async () => {
  const sectionSource = await readFile(
    new URL("../../../webui/src/composables/sections/useDataSection.ts", import.meta.url),
    "utf8"
  );
  const listPaneSource = await readFile(
    new URL("../../../webui/src/sections/data/DataListPane.vue", import.meta.url),
    "utf8"
  );
  const mainPaneSource = await readFile(
    new URL("../../../webui/src/sections/data/DataMainPane.vue", import.meta.url),
    "utf8"
  );

  assert.match(sectionSource, /onBeforeRouteLeave/);
  assert.match(sectionSource, /function resetState\(\)/);
  assert.match(sectionSource, /refreshResources/);
  assert.match(sectionSource, /let stateVersion = 0;/);
  assert.match(sectionSource, /function isStale\(requestVersion: number\)/);
  assert.match(sectionSource, /workbenchRuntime\.showMain\(\)/);
  assert.match(sectionSource, /onBeforeRouteLeave\(\(\) => \{\s*sharedState\?\.resetState\(\);/);
  assert.match(listPaneSource, /onMounted/);
  assert.match(listPaneSource, /refreshResources/);
  assert.match(mainPaneSource, /selectDirectoryItem/);
  assert.match(mainPaneSource, /refreshSelected/);
});

test("workspace section state resets on route leave and uses mobile main switching on selection", async () => {
  const sectionSource = await readFile(
    new URL("../../../webui/src/composables/sections/useWorkspaceSection.ts", import.meta.url),
    "utf8"
  );
  const listPaneSource = await readFile(
    new URL("../../../webui/src/sections/workspace/WorkspaceListPane.vue", import.meta.url),
    "utf8"
  );
  const mainPaneSource = await readFile(
    new URL("../../../webui/src/sections/workspace/WorkspaceMainPane.vue", import.meta.url),
    "utf8"
  );

  assert.match(sectionSource, /onBeforeRouteLeave/);
  assert.match(sectionSource, /function resetState\(\)/);
  assert.match(sectionSource, /function initializeSection\(\)/);
  assert.match(sectionSource, /let stateVersion = 0;/);
  assert.match(sectionSource, /function isStale\(requestVersion: number\)/);
  assert.match(sectionSource, /workbenchRuntime\.showMain\(\)/);
  assert.match(sectionSource, /function selectItem\(/);
  assert.match(sectionSource, /function selectStoredFile\(/);
  assert.match(sectionSource, /function toggleDirectory\(/);
  assert.match(sectionSource, /function refreshCurrentMode\(/);
  assert.match(sectionSource, /onBeforeRouteLeave\(\(\) => \{\s*sharedState\?\.resetState\(\);/);
  assert.match(listPaneSource, /onMounted/);
  assert.match(listPaneSource, /initializeSection/);
  assert.match(mainPaneSource, /ImagePreviewDialog/);
});

test("sessions section state resets on route leave and uses mobile main switching on selection", async () => {
  const sectionSource = await readFile(
    new URL("../../../webui/src/composables/sections/useSessionsSection.ts", import.meta.url),
    "utf8"
  );
  const listPaneSource = await readFile(
    new URL("../../../webui/src/sections/sessions/SessionsListPane.vue", import.meta.url),
    "utf8"
  );
  const mainPaneSource = await readFile(
    new URL("../../../webui/src/sections/sessions/SessionsMainPane.vue", import.meta.url),
    "utf8"
  );
  const mobileHeaderSource = await readFile(
    new URL("../../../webui/src/sections/sessions/SessionsMobileHeader.vue", import.meta.url),
    "utf8"
  );

  assert.match(sectionSource, /onBeforeRouteLeave/);
  assert.match(sectionSource, /function resetState\(\)/);
  assert.match(sectionSource, /function initializeSection\(\)/);
  assert.match(sectionSource, /const requestVersion = stateVersion;\s*await refreshSessions\(\);\s*if \(!isStale\(requestVersion\)\)/);
  assert.match(sectionSource, /function selectSession\(/);
  assert.match(sectionSource, /function refreshSessions\(/);
  assert.match(sectionSource, /function openCreateDialog\(/);
  assert.match(sectionSource, /function submitCreateSession\(/);
  assert.match(sectionSource, /function openSessionActions\(/);
  assert.match(sectionSource, /function saveSessionTitle\(/);
  assert.match(sectionSource, /function regenerateSessionTitle\(/);
  assert.match(sectionSource, /function switchSessionMode\(/);
  assert.match(sectionSource, /function deleteSession\(/);
  assert.match(sectionSource, /async function switchSessionMode[\s\S]*catch \(error: unknown\)[\s\S]*actionsDialogError\.value = error instanceof ApiError \|\| error instanceof Error/);
  assert.match(sectionSource, /async function deleteSession[\s\S]*catch \(error: unknown\)[\s\S]*actionsDialogError\.value = error instanceof ApiError \|\| error instanceof Error/);
  assert.match(sectionSource, /let stateVersion = 0;/);
  assert.match(sectionSource, /function isStale\(requestVersion: number\)/);
  assert.match(sectionSource, /workbenchRuntime\.showMain\(\)/);
  assert.match(sectionSource, /setInterval\(/);
  assert.match(sectionSource, /clearInterval\(/);
  assert.match(sectionSource, /onBeforeRouteLeave\(\(\) => \{\s*sharedState\?\.resetState\(\);/);
  assert.match(listPaneSource, /onMounted/);
  assert.match(listPaneSource, /initializeSection/);
  assert.match(listPaneSource, /openSessionActions/);
  assert.match(listPaneSource, /CreateSessionDialog/);
  assert.match(listPaneSource, /WorkbenchDialog/);
  assert.doesNotMatch(listPaneSource, /const section = useSessionsSection\(\)/);
  assert.doesNotMatch(listPaneSource, /section\.createDialogOpen/);
  assert.doesNotMatch(listPaneSource, /section\.actionsDialogSessionId/);
  assert.match(mainPaneSource, /ChatPanel/);
  assert.doesNotMatch(mobileHeaderSource, /const section = useSessionsSection\(\)/);
  assert.doesNotMatch(mobileHeaderSource, /section\.mobileHeaderTitle/);
});

test("registry imports config section instead of wiring AppLayout per page", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/registry.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /from "@\/sections\/sessions"/);
  assert.match(source, /from "@\/sections\/config"/);
  assert.match(source, /from "@\/sections\/data"/);
  assert.match(source, /from "@\/sections\/settings"/);
  assert.match(source, /from "@\/sections\/workspace"/);
  assert.match(source, /sessionsSection/);
  assert.match(source, /configSection/);
  assert.match(source, /dataSection/);
  assert.match(source, /settingsSection/);
  assert.match(source, /workspaceSection/);
  assert.match(source, /workbenchNavItems\.map/);
  assert.match(source, /if \(id === "sessions"\) return sessionsSection;/);
  assert.match(source, /if \(id === "files"\) return workspaceSection;/);
  assert.match(source, /if \(id === "settings"\) return settingsSection;/);
  assert.match(source, /Object\.freeze\(/);
});
