import type { BaseSchema } from "./base.ts";

export type ConfigFormat = "json" | "yaml";

export type ParseIssue = {
  path: string;
  message: string;
};

export class ConfigParseError extends Error {
  public readonly issues: ParseIssue[];

  public constructor(issues: ParseIssue[]) {
    super(
      issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("\n"),
    );
    this.name = "ConfigParseError";
    this.issues = issues;
  }
}

export type ParseContext = {
  path: string[];
};

export type Primitive = string | number | boolean | null;

export type DefaultValue<T> = T | (() => T);

export type ObjectFieldMeta = {
  title?: string;
  description?: string;
  schema: SchemaMeta;
};

export type SchemaMeta =
  | {
    kind: "string";
    title?: string;
    description?: string;
    optional: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
    dynamicRef?: string;
  }
  | {
    kind: "number";
    title?: string;
    description?: string;
    optional: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
    integer?: boolean;
    min?: number;
    max?: number;
  }
  | {
    kind: "boolean";
    title?: string;
    description?: string;
    optional: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
  }
  | {
    kind: "literal";
    title?: string;
    description?: string;
    optional: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
    value: Primitive;
  }
  | {
    kind: "enum";
    title?: string;
    description?: string;
    optional: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
    values: readonly Primitive[];
  }
  | {
    kind: "array";
    title?: string;
    description?: string;
    optional: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
    item: SchemaMeta;
  }
  | {
    kind: "record";
    title?: string;
    description?: string;
    optional: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
    key: SchemaMeta;
    value: SchemaMeta;
  }
  | {
    kind: "object";
    title?: string;
    description?: string;
    optional: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
    fields: Record<string, ObjectFieldMeta>;
    unknownKeys: "strip" | "strict" | "passthrough";
  }
  | {
    kind: "union";
    title?: string;
    description?: string;
    optional: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
    options: SchemaMeta[];
  };

export type Infer<TSchema> = TSchema extends BaseSchema<infer T> ? T : never;

export type TemplateValue<T> =
  T extends readonly (infer U)[]
    ? TemplateValue<U>[]
    : T extends object
      ? { [K in keyof T]?: TemplateValue<T[K]> }
      : T;

export type SchemaTemplate<TSchema> = TSchema extends BaseSchema<infer T> ? TemplateValue<T> : never;

export type FieldOptions = {
  title?: string;
  description?: string;
};

export type FieldSpec<TSchema extends BaseSchema<any>> = FieldOptions & {
  readonly __schemaField: true;
  readonly schema: TSchema;
};

export type ShapeEntry = BaseSchema<any> | FieldSpec<BaseSchema<any>>;

export type Shape = Record<string, ShapeEntry>;

type InferShapeEntry<TEntry> =
  TEntry extends FieldSpec<infer TSchema>
    ? Infer<TSchema>
    : TEntry extends BaseSchema<infer T>
      ? T
      : never;

type OptionalShapeKeys<TShape extends Shape> = {
  [K in keyof TShape]: undefined extends InferShapeEntry<TShape[K]> ? K : never;
}[keyof TShape];

type RequiredShapeKeys<TShape extends Shape> = Exclude<keyof TShape, OptionalShapeKeys<TShape>>;

export type InferShape<TShape extends Shape> = {
  [K in RequiredShapeKeys<TShape>]: Exclude<InferShapeEntry<TShape[K]>, undefined>;
} & {
  [K in OptionalShapeKeys<TShape>]?: Exclude<InferShapeEntry<TShape[K]>, undefined>;
};

export type UnknownKeysPolicy = "strip" | "strict" | "passthrough";

export type UiNode =
  | {
    kind: "field";
    schema: SchemaMeta;
  }
  | {
    kind: "group";
    schema: Extract<SchemaMeta, { kind: "object" }>;
    children: Record<string, { field: ObjectFieldMeta; node: UiNode }>;
  }
  | {
    kind: "array";
    schema: Extract<SchemaMeta, { kind: "array" }>;
    item: UiNode;
  }
  | {
    kind: "record";
    schema: Extract<SchemaMeta, { kind: "record" }>;
    key: UiNode;
    value: UiNode;
  }
  | {
    kind: "union";
    schema: Extract<SchemaMeta, { kind: "union" }>;
    options: UiNode[];
  };
