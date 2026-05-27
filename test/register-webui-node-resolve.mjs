import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = process.cwd();
const aliases = new Map([
  ["vue", pathToFileURL(resolve(root, "webui/node_modules/vue/index.mjs")).href],
  ["lucide-vue-next", pathToFileURL(resolve(root, "webui/node_modules/lucide-vue-next/dist/esm/lucide-vue-next.js")).href],
  ["@workbench-kit/vue-workbench/runtime", pathToFileURL(resolve(root, "vendor/workbench-kit/packages/vue-workbench/src/runtime-api.ts")).href],
  ["@workbench-kit/vue-workbench", pathToFileURL(resolve(root, "vendor/workbench-kit/packages/vue-workbench/src/index.ts")).href],
  ["@workbench-kit/vue-resource-editor", pathToFileURL(resolve(root, "vendor/workbench-kit/packages/vue-resource-editor/src/index.ts")).href],
  ["@workbench-kit/vue-file-workspace", pathToFileURL(resolve(root, "vendor/workbench-kit/packages/vue-file-workspace/src/index.ts")).href]
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const alias = aliases.get(specifier);
    if (alias) {
      return {
        url: alias,
        shortCircuit: true
      };
    }
    return nextResolve(specifier, context);
  }
});
