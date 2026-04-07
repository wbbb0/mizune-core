import { cloneDefault, makeIssue } from "./helpers.ts";
import type { DefaultValue, ParseContext, SchemaMeta } from "./types.ts";

export abstract class BaseSchema<TOutput> {
  protected _optional = false;
  protected _defaultValue: DefaultValue<TOutput> | undefined;
  protected _title: string | undefined;
  protected _description: string | undefined;
  protected _validators: Array<(value: TOutput, ctx: ParseContext) => void> = [];

  public optional(): BaseSchema<TOutput | undefined> {
    this._optional = true;
    return this as unknown as BaseSchema<TOutput | undefined>;
  }

  public default(value: DefaultValue<TOutput>): this {
    this._defaultValue = value;
    return this;
  }

  public title(title: string): this {
    this._title = title;
    return this;
  }

  public describe(description: string): this {
    this._description = description;
    return this;
  }

  public refine(
    fn: (value: TOutput) => boolean,
    message: string,
  ): this {
    this._validators.push((value, ctx) => {
      if (!fn(value)) {
        throw makeIssue(ctx, message);
      }
    });
    return this;
  }

  protected resolveDefault(): TOutput {
    const defaultValue = this._defaultValue;
    if (typeof defaultValue === "function") {
      return (defaultValue as () => TOutput)();
    }
    return cloneDefault(defaultValue as TOutput);
  }

  protected runValidators(value: TOutput, ctx: ParseContext): void {
    for (const validator of this._validators) {
      validator(value, ctx);
    }
  }

  public parse(input: unknown, ctx: ParseContext = { path: [] }): TOutput {
    let value: TOutput | undefined;

    if (input === undefined) {
      if (this._defaultValue !== undefined) {
        value = this.parseValue(this.resolveDefault(), ctx);
      } else if (this._optional) {
        value = undefined;
      } else {
        throw makeIssue(ctx, "is required");
      }
    } else {
      value = this.parseValue(input, ctx);
    }

    if (value === undefined) {
      return value as TOutput;
    }

    this.runValidators(value, ctx);
    return value;
  }

  public parseFromObject(input: unknown): TOutput {
    return this.parse(input, { path: [] });
  }

  public hasDefaultValue(): boolean {
    return this._defaultValue !== undefined;
  }

  public getDefaultValue(): TOutput | undefined {
    if (this._defaultValue === undefined) {
      return undefined;
    }
    return this.resolveDefault();
  }

  public abstract toMeta(): SchemaMeta;

  protected abstract parseValue(input: unknown, ctx: ParseContext): TOutput;
}
