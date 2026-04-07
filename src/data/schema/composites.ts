import { BaseSchema } from "./base.ts";
import { cloneDefault, compactObject, isPlainObject, makeIssue } from "./helpers.ts";
import { BooleanSchema, EnumSchema, LiteralSchema, NumberSchema, StringSchema } from "./primitives.ts";
import { ConfigParseError, type Infer, type InferShape, type ParseContext, type SchemaMeta, type SchemaTemplate, type Shape, type UnknownKeysPolicy } from "./types.ts";

export class ArraySchema<TItem> extends BaseSchema<TItem[]> {
  private _minItems: number | undefined;

  public constructor(private readonly itemSchema: BaseSchema<TItem>) {
    super();
  }

  public min(length: number): this {
    this._minItems = length;
    return this.refine((value) => value.length >= length, `length must be >= ${length}`);
  }

  protected parseValue(input: unknown, ctx: ParseContext): TItem[] {
    if (!Array.isArray(input)) {
      throw makeIssue(ctx, "expected array");
    }

    return input.map((item, index) =>
      this.itemSchema.parse(item, {
        path: [...ctx.path, String(index)],
      }),
    );
  }

  public toMeta(): SchemaMeta {
    return compactObject({
      kind: "array",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
      item: this.itemSchema.toMeta(),
    }) as SchemaMeta;
  }
}

export class OneOrManySchema<TItem> extends BaseSchema<TItem[]> {
  private _minItems: number | undefined;

  public constructor(private readonly itemSchema: BaseSchema<TItem>) {
    super();
  }

  public min(length: number): this {
    this._minItems = length;
    return this.refine((value) => value.length >= length, `length must be >= ${length}`);
  }

  protected parseValue(input: unknown, ctx: ParseContext): TItem[] {
    const rawItems = Array.isArray(input) ? input : [input];
    return rawItems.map((item, index) =>
      this.itemSchema.parse(item, {
        path: [...ctx.path, String(index)],
      }),
    );
  }

  public toMeta(): SchemaMeta {
    return compactObject({
      kind: "array",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
      item: this.itemSchema.toMeta(),
    }) as SchemaMeta;
  }
}

export class RecordSchema<TKey extends string, TValue> extends BaseSchema<Record<TKey, TValue>> {
  public constructor(
    private readonly keySchema: BaseSchema<TKey>,
    private readonly valueSchema: BaseSchema<TValue>,
  ) {
    super();
  }

  protected parseValue(input: unknown, ctx: ParseContext): Record<TKey, TValue> {
    if (!isPlainObject(input)) {
      throw makeIssue(ctx, "expected record object");
    }

    const result: Record<string, TValue> = {};

    for (const [rawKey, rawValue] of Object.entries(input)) {
      const parsedKey = this.keySchema.parse(rawKey, {
        path: [...ctx.path, `${rawKey}::<key>`],
      });
      const parsedValue = this.valueSchema.parse(rawValue, {
        path: [...ctx.path, rawKey],
      });
      result[parsedKey] = parsedValue;
    }

    return result as Record<TKey, TValue>;
  }

  public toMeta(): SchemaMeta {
    return compactObject({
      kind: "record",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
      key: this.keySchema.toMeta(),
      value: this.valueSchema.toMeta(),
    }) as SchemaMeta;
  }
}

export class ObjectSchema<TShape extends Shape> extends BaseSchema<InferShape<TShape>> {
  private _unknownKeys: UnknownKeysPolicy = "strip";

  public constructor(private readonly shape: TShape) {
    super();
  }

  public strict(): this {
    this._unknownKeys = "strict";
    return this;
  }

  public strip(): this {
    this._unknownKeys = "strip";
    return this;
  }

  public passthrough(): this {
    this._unknownKeys = "passthrough";
    return this;
  }

  public getShape(): TShape {
    return this.shape;
  }

  protected parseValue(input: unknown, ctx: ParseContext): InferShape<TShape> {
    if (!isPlainObject(input)) {
      throw makeIssue(ctx, "expected object");
    }

    const source = input as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const [key, schema] of Object.entries(this.shape)) {
      const parsed = schema.parse(source[key], {
        path: [...ctx.path, key],
      });
      if (parsed !== undefined) {
        result[key] = parsed;
      }
    }

    if (this._unknownKeys === "strict") {
      for (const key of Object.keys(source)) {
        if (!(key in this.shape)) {
          throw makeIssue(
            { path: [...ctx.path, key] },
            "unknown key",
          );
        }
      }
    } else if (this._unknownKeys === "passthrough") {
      for (const [key, value] of Object.entries(source)) {
        if (!(key in this.shape)) {
          result[key] = value;
        }
      }
    }

    return result as InferShape<TShape>;
  }

  public toMeta(): SchemaMeta {
    const fields: Record<string, SchemaMeta> = {};
    for (const [key, schema] of Object.entries(this.shape)) {
      fields[key] = schema.toMeta();
    }

    return compactObject({
      kind: "object",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
      fields,
      unknownKeys: this._unknownKeys,
    }) as SchemaMeta;
  }
}

export class UnionSchema<TOptions extends readonly BaseSchema<any>[]> extends BaseSchema<Infer<TOptions[number]>> {
  public constructor(private readonly options: TOptions) {
    super();
  }

  protected parseValue(input: unknown, ctx: ParseContext): Infer<TOptions[number]> {
    const errors: string[] = [];

    for (const option of this.options) {
      try {
        return option.parse(input, ctx);
      } catch (error) {
        if (error instanceof ConfigParseError) {
          errors.push(error.message);
        } else {
          errors.push(String(error));
        }
      }
    }

    throw makeIssue(
      ctx,
      `no union option matched: ${errors.join(" | ")}`,
    );
  }

  public toMeta(): SchemaMeta {
    return compactObject({
      kind: "union",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
      options: this.options.map((option) => option.toMeta()),
    }) as SchemaMeta;
  }
}

export class DiscriminatedUnionSchema<
  TKey extends string,
  TOptions extends readonly ObjectSchema<any>[]
> extends BaseSchema<Infer<TOptions[number]>> {
  public constructor(
    private readonly key: TKey,
    private readonly options: TOptions,
  ) {
    super();
  }

  protected parseValue(input: unknown, ctx: ParseContext): Infer<TOptions[number]> {
    if (!isPlainObject(input)) {
      throw makeIssue(ctx, "expected object");
    }

    const discriminant = input[this.key];
    const matched = this.options.find((option) => {
      const field = option.getShape()[this.key];
      if (!field) {
        return false;
      }
      try {
        field.parse(discriminant, {
          path: [...ctx.path, this.key],
        });
        return true;
      } catch {
        return false;
      }
    });

    if (!matched) {
      throw makeIssue(
        { path: [...ctx.path, this.key] },
        `no discriminated union option matched for ${this.key}`,
      );
    }

    return matched.parse(input, ctx) as Infer<TOptions[number]>;
  }

  public toMeta(): SchemaMeta {
    return compactObject({
      kind: "union",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
      options: this.options.map((option) => {
        const meta = option.toMeta();
        const discriminantMeta = option.getShape()[this.key]?.toMeta();
        const inferredTitle = getSchemaMetaDisplayLabel(discriminantMeta);
        if (!inferredTitle || meta.title) {
          return meta;
        }
        return {
          ...meta,
          title: inferredTitle,
        };
      }),
    }) as SchemaMeta;
  }
}

function getSchemaMetaDisplayLabel(meta: SchemaMeta | undefined): string | undefined {
  if (!meta) return undefined;
  if (meta.title?.trim()) return meta.title;
  if (meta.kind === "literal") return String(meta.value);
  if (meta.kind === "enum" && meta.values.length === 1) {
    return String(meta.values[0]);
  }
  return undefined;
}

export const s = {
  string(): StringSchema {
    return new StringSchema();
  },

  number(): NumberSchema {
    return new NumberSchema();
  },

  boolean(): BooleanSchema {
    return new BooleanSchema();
  },

  literal<T extends string | number | boolean | null>(value: T): LiteralSchema<T> {
    return new LiteralSchema(value);
  },

  enum<T extends string | number | boolean | null>(values: readonly T[]): EnumSchema<T> {
    return new EnumSchema(values);
  },

  array<TItem>(itemSchema: BaseSchema<TItem>): ArraySchema<TItem> {
    return new ArraySchema(itemSchema);
  },

  oneOrMany<TItem>(itemSchema: BaseSchema<TItem>): OneOrManySchema<TItem> {
    return new OneOrManySchema(itemSchema);
  },

  record<TKey extends string, TValue>(
    keySchema: BaseSchema<TKey>,
    valueSchema: BaseSchema<TValue>,
  ): RecordSchema<TKey, TValue> {
    return new RecordSchema(keySchema, valueSchema);
  },

  object<TShape extends Shape>(shape: TShape): ObjectSchema<TShape> {
    return new ObjectSchema(shape);
  },

  union<TOptions extends readonly BaseSchema<any>[]>(options: TOptions): UnionSchema<TOptions> {
    return new UnionSchema(options);
  },

  discriminatedUnion<TKey extends string, TOptions extends readonly ObjectSchema<any>[]>(
    key: TKey,
    options: TOptions,
  ): DiscriminatedUnionSchema<TKey, TOptions> {
    return new DiscriminatedUnionSchema(key, options);
  },
};

export function exportSchemaMeta(schema: BaseSchema<any>): SchemaMeta {
  return schema.toMeta();
}

export function createSchemaTemplate<TSchema extends BaseSchema<any>>(schema: TSchema): SchemaTemplate<TSchema> {
  return buildSchemaTemplate(schema) as SchemaTemplate<TSchema>;
}

function buildSchemaTemplate(schema: BaseSchema<any>): unknown {
  if (schema.hasDefaultValue()) {
    return schema.getDefaultValue();
  }

  if (schema instanceof ObjectSchema) {
    const result: Record<string, unknown> = {};
    for (const [key, childSchema] of Object.entries(schema.getShape()) as Array<[string, BaseSchema<any>]>) {
      const childValue = buildSchemaTemplate(childSchema);
      if (childValue !== undefined) {
        result[key] = childValue;
      }
    }
    return result;
  }

  if (schema instanceof ArraySchema || schema instanceof OneOrManySchema) {
    return [];
  }

  if (schema instanceof RecordSchema) {
    return {};
  }

  if (schema instanceof UnionSchema || schema instanceof DiscriminatedUnionSchema) {
    const meta = schema.toMeta();
    const firstOption = meta.kind === "union" ? meta.options[0] : undefined;
    if (firstOption?.kind === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, childMeta] of Object.entries(firstOption.fields)) {
        if (childMeta.hasDefault) {
          result[key] = cloneDefault(childMeta.defaultValue);
        } else if (childMeta.kind === "array") {
          result[key] = [];
        } else if (childMeta.kind === "record") {
          result[key] = {};
        }
      }
      return result;
    }
  }

  return undefined;
}
