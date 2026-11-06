import type { UiNode } from "@workbench-kit/vue";

type ModelSchema = Extract<UiNode, { kind: "group" }>;

/** 使用目录编辑器的同一供应商分支，避免维护第二份模型字段清单。 */
export function resolveModelAddSchema(catalog: UiNode | undefined, providerType: unknown): ModelSchema | undefined {
  if (catalog?.kind !== "record" || catalog.value.kind !== "union") return;
  const provider = catalog.value.options.find(option => option.kind === "group" && option.children.type?.node.schema.value === providerType);
  if (provider?.kind !== "group") return;
  const models = provider.children.models?.node;
  return models?.kind === "record" && models.value.kind === "group" ? models.value : undefined;
}

export function modelOperationOptions(schema: ModelSchema | undefined): Array<{ value: string; label: string }> {
  if (!schema) return [];
  return Object.entries(schema.children).filter(([, child]) => child.node.kind === "group")
    .map(([key, child]) => ({ value: key, label: child.field.title ?? key }));
}

export function modelProfileFormSchema(schema: ModelSchema | undefined, selectedOperations: string[]): ModelSchema | undefined {
  if (!schema) return;
  const operations = new Set(modelOperationOptions(schema).map(option => option.value));
  const children = Object.fromEntries(Object.entries(schema.children).filter(([key]) => key !== "upstreamModel" && (!operations.has(key) || selectedOperations.includes(key))));
  return { ...schema, children, schema: { ...schema.schema, fields: Object.fromEntries(Object.entries(children).map(([key, child]) => [key, child.field])) } };
}
