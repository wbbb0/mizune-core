import type { Component } from "vue";

export type WindowSize = "auto" | "sm" | "md" | "lg" | "xl" | "full";

export type WindowKind = "dialog" | "panel" | "child-dialog";

type DialogGroupValues<TValue> = unknown extends TValue
  ? Record<string, unknown>
  : NonNullable<TValue> extends Record<string, unknown>
  ? NonNullable<TValue>
  : never;

export type DialogSchema<
  TValues extends Record<string, unknown> = Record<string, unknown>
> = {
  fields: DialogField<TValues>[];
};

type DialogLeafField<TValues extends Record<string, unknown>> =
  | {
      kind: "string";
      key: keyof TValues & string;
      label: string;
      defaultValue?: string;
      placeholder?: string;
      required?: boolean;
    }
  | {
      kind: "textarea";
      key: keyof TValues & string;
      label: string;
      defaultValue?: string;
      placeholder?: string;
    }
  | {
      kind: "number";
      key: keyof TValues & string;
      label: string;
      defaultValue?: number;
      min?: number;
      max?: number;
    }
  | {
      kind: "boolean";
      key: keyof TValues & string;
      label: string;
      defaultValue?: boolean;
    }
  | {
      kind: "enum";
      key: keyof TValues & string;
      label: string;
      defaultValue?: string;
      options: Array<{ label: string; value: string }>;
    }
  | {
      kind: "custom";
      key: keyof TValues & string;
      label?: string;
      component: Component;
      props?: Record<string, unknown>;
    };

type DialogGroupField<TValues extends Record<string, unknown>> = {
  [TGroupKey in keyof TValues & string]: NonNullable<TValues[TGroupKey]> extends Record<string, unknown>
    ? {
        kind: "group";
        key: TGroupKey;
        label: string;
        fields: DialogLeafField<DialogGroupValues<TValues[TGroupKey]>>[];
      }
    : unknown extends TValues[TGroupKey]
      ? {
          kind: "group";
          key: TGroupKey;
          label: string;
          fields: DialogLeafField<DialogGroupValues<TValues[TGroupKey]>>[];
        }
    : never;
}[keyof TValues & string];

export type DialogField<TValues extends Record<string, unknown> = Record<string, unknown>> =
  | DialogLeafField<TValues>
  | DialogGroupField<TValues>;

export type DialogBlock<TValues extends Record<string, unknown> = Record<string, unknown>> =
  | {
      kind: "text";
      content: string;
    }
  | {
      kind: "separator";
    }
  | {
      kind: "component";
      component: Component;
      props?: Record<string, unknown>;
    };

export type DialogAction<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
> = {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  run?: (context: { values: TValues; windowId: string }) => Promise<TResult> | TResult;
};

export type WindowDefinition<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
> = {
  id?: string;
  kind: WindowKind;
  title: string;
  description?: string;
  size: WindowSize;
  schema?: DialogSchema<TValues>;
  blocks?: DialogBlock<TValues>[];
  actions?: DialogAction<TValues, TResult>[];
  parentId?: string;
  modal?: boolean;
  movable?: boolean;
  showCloseButton?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
};

export type WindowDialogController<
  TValues extends Record<string, unknown> = Record<string, unknown>
> = {
  snapshotValues: () => TValues;
};

export type WindowResult<TResult = unknown, TValues extends Record<string, unknown> = Record<string, unknown>> =
  | { reason: "action"; actionId: string; values: TValues; result?: TResult }
  | { reason: "close"; values: TValues }
  | { reason: "dismiss"; values: TValues };
