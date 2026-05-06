/** Resource list 中的一条资源摘要。 */
export interface EditorResourceSummary {
  /** 资源稳定 key，用于 load/validate/save。 */
  key: string;
  title: string;
  /** 资源域。业务项目可用 domain 过滤不同资源列表。 */
  domain: "config" | "data";
  /** single 表示单文件资源，layered 表示多层覆盖资源。 */
  kind: "single" | "layered";
  /** false 时 UI 应禁止保存。 */
  editable: boolean;
}

/** 后端 schema 转换后的元数据。SchemaNode 依赖它渲染字段和默认值提示。 */
export interface ObjectFieldMeta {
  title?: string;
  description?: string;
  schema: SchemaMeta;
}

export interface SchemaMeta {
  kind: string;
  title?: string;
  description?: string;
  optional: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  fields?: Record<string, ObjectFieldMeta>;
  unknownKeys?: string;
  item?: SchemaMeta;
  key?: SchemaMeta;
  recordValue?: SchemaMeta;
  options?: SchemaMeta[];
  values?: unknown[];
  integer?: boolean;
  min?: number;
  max?: number;
  value?: unknown;
  dynamicRef?: string;
}

/** SchemaNode 使用的递归 UI 树。 */
export type UiNode =
  | { kind: "field"; schema: SchemaMeta }
  | { kind: "group"; schema: SchemaMeta; children: Record<string, { field: ObjectFieldMeta; node: UiNode }> }
  | { kind: "array"; schema: SchemaMeta; item: UiNode }
  | { kind: "record"; schema: SchemaMeta; key: UiNode; value: UiNode }
  | { kind: "union"; schema: SchemaMeta; options: UiNode[] };

/** layered 资源中的一层。 */
export interface LayerInfo {
  key: string;
  path: string;
  value: unknown;
}

/** 草稿最终值计算模式。 */
export type EditorDraftEffectiveMode =
  | "draft_only"
  | "merge_reference"
  | "routing_preset_catalog";

/** unset 操作展示和行为模式。 */
export type EditorUnsetMode =
  | "disabled"
  | "optional"
  | "reference";

/** 编辑器功能开关。业务后端按资源类型返回，前端只按契约渲染。 */
export interface EditorFeatures {
  showReferenceBackdrop: boolean;
  unsetMode: EditorUnsetMode;
  unsetActionLabel: string | null;
  draftEffectiveMode: EditorDraftEffectiveMode;
}

interface BaseEditorModel {
  /** 与 EditorResourceSummary.key 对齐。 */
  key: string;
  title: string;
  editable: boolean;
  schemaMeta: SchemaMeta;
  uiTree: UiNode;
  template: unknown;
  schemaDefaultValue: unknown;
  currentValue: unknown;
  referenceValue: unknown;
  effectiveValue: unknown;
  editorFeatures: EditorFeatures;
}

/** 单文件资源模型。 */
export interface SingleEditorModel extends BaseEditorModel {
  kind: "single";
  file: { path: string };
}

/** 多层覆盖资源模型。 */
export interface LayeredEditorModel extends BaseEditorModel {
  kind: "layered";
  writableLayerKey: string;
  layers: LayerInfo[];
}

export type EditorModel = SingleEditorModel | LayeredEditorModel;

/** validate 成功结果。失败应由 client 抛出 Error。 */
export type ResourceEditorValidateResult = {
  ok: true;
  parsed: unknown;
  currentValue: unknown;
  referenceValue: unknown;
  effective: unknown;
};

/** save 成功结果。失败应由 client 抛出 Error。 */
export type ResourceEditorSaveResult = {
  ok: true;
  path: string;
  parsed: unknown;
};

/** 业务项目需要实现的资源编辑 API adapter。 */
export interface ResourceEditorClient {
  /** 列出可编辑或可查看资源。 */
  list(): Promise<{ resources: EditorResourceSummary[] }>;
  /** 加载单个资源的完整 editor model。 */
  load(key: string): Promise<{ editor: EditorModel }>;
  /** 校验草稿值。失败时抛出带用户可读 message 的 Error。 */
  validate(key: string, value: unknown): Promise<ResourceEditorValidateResult>;
  /** 保存草稿值。失败时抛出带用户可读 message 的 Error。 */
  save(key: string, value: unknown): Promise<ResourceEditorSaveResult>;
  /** 可选动态选项接口，供业务项目扩展字段选择器。 */
  options?(key: string): Promise<{ options: string[] }>;
}
