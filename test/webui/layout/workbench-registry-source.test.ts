import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

async function loadTranspiledModule(source: string, options: {
  prepend?: string;
  replacements?: Array<[RegExp, string]>;
}) {
  const { outputText } = transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2022
    }
  });
  let transformedSource = outputText;
  if (options.replacements) {
    transformedSource = options.replacements.reduce((current, [pattern, replacement]) => {
      if (!pattern.test(current)) {
        throw new Error(`Missing expected source pattern: ${pattern}`);
      }
      return current.replace(pattern, replacement);
    }, transformedSource);
  }
  if (options.prepend) {
    transformedSource = `${options.prepend}${transformedSource}`;
  }
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transformedSource)}`);
}

test("workbench section contract reserves future regions while phase 1 uses minimal panes", async () => {
  const source = await readFile(new URL("../../../webui/src/components/workbench/types.ts", import.meta.url), "utf8");

  assert.match(source, /id: string;/);
  assert.match(source, /title: string;/);
  assert.match(source, /regions: \{/);
  assert.match(source, /listPane\?: Component/);
  assert.match(source, /mainPane: Component/);
  assert.match(source, /auxPane\?: Component/);
  assert.match(source, /topbar\?: Component/);
  assert.match(source, /statusbar\?: Component/);
  assert.match(source, /mobileHeader\?: Component/);
  assert.match(source, /mobileTopMenu\?: Component/);
  assert.match(source, /mobileBottomMenu\?: Component/);
  assert.match(source, /mobileMainFlow: "list-main" \| "main-only"/);
});

test("workbench registry only depends on the shared workbench types and registry source", async () => {
  const source = await readFile(
    new URL("../../../webui/src/composables/workbench/useWorkbenchRegistry.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /from "@\/components\/workbench\/types"/);
  assert.match(source, /from "@\/sections\/registry"/);
  assert.match(source, /const sectionsById: ReadonlyMap<string, WorkbenchSection> = new Map\(/);
  assert.doesNotMatch(source, /routeName/);
  assert.doesNotMatch(source, /icon\?: Component/);
  assert.doesNotMatch(source, /auxMode/);
  assert.doesNotMatch(source, /defaults/);
});

test("workbench registry exposes minimal placeholder sections for the current nav ids", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/registry.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /from "@\/components\/workbench\/navigation"/);
  assert.match(source, /from "@\/components\/workbench\/types"/);
  assert.match(source, /from "@\/sections\/sessions"/);
  assert.match(source, /from "@\/sections\/config"/);
  assert.match(source, /from "@\/sections\/data"/);
  assert.match(source, /from "@\/sections\/settings"/);
  assert.match(source, /from "@\/sections\/workspace"/);
  assert.match(source, /defineComponent/);
  assert.match(source, /createPlaceholderSection/);
  assert.match(source, /workbenchNavItems\.map/);
  assert.match(source, /if \(id === "sessions"\) return sessionsSection;/);
  assert.match(source, /if \(id === "config"\) return configSection;/);
  assert.match(source, /if \(id === "data"\) return dataSection;/);
  assert.match(source, /if \(id === "files"\) return workspaceSection;/);
  assert.match(source, /if \(id === "settings"\) return settingsSection;/);
  assert.match(source, /Object\.freeze\(/);
  assert.match(source, /readonly WorkbenchSection\[]/);
  assert.match(source, /mobileMainFlow: "list-main"/);
});

test("workbench runtime exposes shell-controlled mobile navigation primitives", async () => {
  const source = await readFile(
    new URL("../../../webui/src/composables/workbench/useWorkbenchRuntime.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /mobileScreen = ref<"list" \| "main">/);
  assert.match(source, /function showList\(\)/);
  assert.match(source, /function showMain\(\)/);
  assert.match(source, /function openAux\(\)/);
  assert.match(source, /function closeAux\(\)/);
  assert.match(source, /function toggleTopMenu\(\)/);
  assert.match(source, /function toggleBottomMenu\(\)/);
  assert.doesNotMatch(source, /function openTopMenu\(\)/);
  assert.doesNotMatch(source, /function closeTopMenu\(\)/);
  assert.doesNotMatch(source, /function toggleAux\(\)/);
});

test("workbench runtime returns a shared singleton and the registry throws for missing sections", async () => {
  const runtimeSource = await readFile(
    new URL("../../../webui/src/composables/workbench/useWorkbenchRuntime.ts", import.meta.url),
    "utf8"
  );
  const navigationSource = await readFile(
    new URL("../../../webui/src/components/workbench/navigation.ts", import.meta.url),
    "utf8"
  );
  const registrySource = await readFile(
    new URL("../../../webui/src/composables/workbench/useWorkbenchRegistry.ts", import.meta.url),
    "utf8"
  );

  const runtimeModule = await loadTranspiledModule(runtimeSource, {
    replacements: [[/import\s+\{[^}]*\bref\b[^}]*\}\s+from\s+"vue";/, 'const ref = (value) => ({ value });']]
  });
  const navigationModule = await loadTranspiledModule(navigationSource, {
    replacements: [[/import\s+\{[^}]*\b(Database|Folder|MessageSquare|Settings|SlidersHorizontal)\b[^}]*\}\s+from\s+"lucide-vue-next";/, 'const Database = {}; const Folder = {}; const MessageSquare = {}; const Settings = {}; const SlidersHorizontal = {};']]
  }) as {
    workbenchNavItems: Array<{ id: string; title: string }>;
  };
  assert.ok(Array.isArray(navigationModule.workbenchNavItems));
  assert.ok(navigationModule.workbenchNavItems.length > 0);
  const registryModule = await loadTranspiledModule(registrySource, {
    replacements: [[/import\s+\{\s*workbenchSections\s*\}\s+from\s+"@\/sections\/registry";/, "const workbenchSections = registrySections;"]],
    prepend: `const registrySections = ${JSON.stringify(navigationModule.workbenchNavItems.map((item: { id: string; title: string }) => (
      item.id === "sessions"
        ? { id: "sessions", title: "会话" }
        : item.id === "config"
        ? { id: "config", title: "配置" }
        : item.id === "data"
          ? { id: "data", title: "数据" }
          : item.id === "files"
            ? { id: "files", title: "文件" }
          : { id: item.id, title: item.title }
    )))};\n`
  });

  const { useWorkbenchRuntime } = runtimeModule as {
    useWorkbenchRuntime: () => {
      mobileScreen: { value: "list" | "main" };
      showMain: () => void;
      showList: () => void;
    };
  };
  const { useWorkbenchRegistry } = registryModule as {
    useWorkbenchRegistry: () => {
      sectionsById: ReadonlyMap<string, unknown>;
      getSectionById: (id: string) => unknown;
    };
  };

  const firstRuntime = useWorkbenchRuntime();
  const secondRuntime = useWorkbenchRuntime();

  assert.strictEqual(firstRuntime, secondRuntime);
  firstRuntime.showMain();
  assert.strictEqual(secondRuntime.mobileScreen.value, "main");
  firstRuntime.showList();
  assert.strictEqual(secondRuntime.mobileScreen.value, "list");

  const registry = useWorkbenchRegistry();
  const sessionsSection = registry.getSectionById("sessions") as { title: string };
  assert.strictEqual(sessionsSection.title, "会话");
  assert.throws(() => registry.getSectionById("missing"), /Unknown workbench section: missing/);
});
