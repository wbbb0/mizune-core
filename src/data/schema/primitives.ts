import { compactObject, makeIssue } from "./helpers.ts";
import { BaseSchema } from "./base.ts";
import type { ParseContext, Primitive, SchemaMeta } from "./types.ts";

export class StringSchema extends BaseSchema<string> {
  private _minLength: number | undefined;
  private _maxLength: number | undefined;
  private _trim = false;
  private _url = false;
  private _dynamicRef: string | undefined;

  public trim(): this {
    this._trim = true;
    return this;
  }

  public url(): this {
    this._url = true;
    return this.refine((value) => {
      try {
        // eslint-disable-next-line no-new
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, "expected valid URL");
  }

  public min(length: number): this {
    this._minLength = length;
    return this.refine(
      (value) => value.length >= length,
      `length must be >= ${length}`,
    );
  }

  public max(length: number): this {
    this._maxLength = length;
    return this.refine(
      (value) => value.length <= length,
      `length must be <= ${length}`,
    );
  }

  public nonempty(): this {
    return this.min(1);
  }

  public dynamicRef(key: string): this {
    this._dynamicRef = key;
    return this;
  }

  protected parseValue(input: unknown, ctx: ParseContext): string {
    if (typeof input !== "string") {
      throw makeIssue(ctx, "expected string");
    }
    return this._trim ? input.trim() : input;
  }

  public toMeta(): SchemaMeta {
    return compactObject({
      kind: "string",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
      dynamicRef: this._dynamicRef,
    }) as SchemaMeta;
  }
}

export class NumberSchema extends BaseSchema<number> {
  private _integer = false;
  private _min: number | undefined;
  private _max: number | undefined;

  public int(): this {
    this._integer = true;
    return this.refine(Number.isInteger, "expected integer");
  }

  public min(value: number): this {
    this._min = value;
    return this.refine((current) => current >= value, `must be >= ${value}`);
  }

  public max(value: number): this {
    this._max = value;
    return this.refine((current) => current <= value, `must be <= ${value}`);
  }

  public positive(): this {
    return this.refine((current) => current > 0, "must be > 0");
  }

  protected parseValue(input: unknown, ctx: ParseContext): number {
    if (typeof input !== "number" || Number.isNaN(input)) {
      throw makeIssue(ctx, "expected number");
    }
    return input;
  }

  public toMeta(): SchemaMeta {
    return compactObject({
      kind: "number",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
      integer: this._integer,
      min: this._min,
      max: this._max,
    }) as SchemaMeta;
  }
}

export class BooleanSchema extends BaseSchema<boolean> {
  protected parseValue(input: unknown, ctx: ParseContext): boolean {
    if (typeof input !== "boolean") {
      throw makeIssue(ctx, "expected boolean");
    }
    return input;
  }

  public toMeta(): SchemaMeta {
    return compactObject({
      kind: "boolean",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
    }) as SchemaMeta;
  }
}

export class LiteralSchema<T extends Primitive> extends BaseSchema<T> {
  public constructor(private readonly literalValue: T) {
    super();
  }

  protected parseValue(input: unknown, ctx: ParseContext): T {
    if (input !== this.literalValue) {
      throw makeIssue(ctx, `expected literal ${JSON.stringify(this.literalValue)}`);
    }
    return input as T;
  }

  public toMeta(): SchemaMeta {
    return compactObject({
      kind: "literal",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
      value: this.literalValue,
    }) as SchemaMeta;
  }
}

export class EnumSchema<T extends Primitive> extends BaseSchema<T> {
  private readonly valueSet: Set<T>;

  public constructor(private readonly values: readonly T[]) {
    super();
    this.valueSet = new Set(values);
  }

  protected parseValue(input: unknown, ctx: ParseContext): T {
    if (!this.valueSet.has(input as T)) {
      throw makeIssue(
        ctx,
        `expected one of ${this.values.map((value) => JSON.stringify(value)).join(", ")}`,
      );
    }
    return input as T;
  }

  public toMeta(): SchemaMeta {
    return compactObject({
      kind: "enum",
      title: this._title,
      description: this._description,
      optional: this._optional,
      hasDefault: this._defaultValue !== undefined,
      defaultValue: this._defaultValue !== undefined ? this.resolveDefault() : undefined,
      values: this.values,
    }) as SchemaMeta;
  }
}