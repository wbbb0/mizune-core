import { markRaw } from "vue";
import type { EditorModel, SchemaMeta, UiNode } from "@workbench-kit/vue";
import { buildUiTreeFromMeta } from "../../../src/data/schema/ui.ts";
import type { SchemaMeta as TransportSchemaMeta } from "../../../src/data/schema/types.ts";

type SchemaFields = Pick<EditorModel, "schemaMeta" | "uiTree" | "template" | "schemaDefaultValue">;
type EditorValues<T = EditorModel> = T extends EditorModel ? Omit<T, keyof SchemaFields> : never;

export interface EditorModelResponse {
  schemaVersion: string;
  schema?: { meta: TransportSchemaMeta; template: unknown; defaultValue: unknown };
  editor: EditorValues & { revision?: string };
}

/** 传输层仅接收一份元数据；组件使用的 UI 树在本地构建并按内容版本复用。 */
export function createEditorModelLoader(get: (path: string) => Promise<EditorModelResponse>) {
  const schemas = new Map<string, { version: string; fields: SchemaFields }>();
  return async (key: string): Promise<{ editor: EditorModel & { revision?: string } }> => {
    // 保存本次请求声明的版本，避免并发请求返回次序改变它使用的 Schema。
    const known = schemas.get(key);
    const query = known ? `?schemaVersion=${encodeURIComponent(known.version)}` : "";
    const response = await get(`/api/editors/${encodeURIComponent(key)}${query}`);
    let cached = known;
    if (response.schema) {
      const { meta, template, defaultValue } = response.schema;
      cached = {
        version: response.schemaVersion,
        fields: {
          // 后端判别联合比组件库的宽泛 SchemaMeta 更严格；只在传输边界转换。
          schemaMeta: markRaw(meta) as unknown as SchemaMeta,
          uiTree: markRaw(buildUiTreeFromMeta(meta)) as unknown as UiNode,
          template,
          schemaDefaultValue: defaultValue
        }
      };
      schemas.set(key, cached);
    }
    if (!cached || cached.version !== response.schemaVersion) {
      throw new Error("编辑器 Schema 版本不一致，请重新加载配置页面");
    }
    return { editor: { ...response.editor, ...cached.fields } as EditorModel & { revision?: string } };
  };
}
