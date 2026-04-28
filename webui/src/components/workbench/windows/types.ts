import type { Component } from "vue";

export type WorkbenchWindowSize = "auto" | "sm" | "md" | "lg" | "xl" | "full";

export type WorkbenchWindowKind = "dialog" | "panel" | "child-dialog";

export type WorkbenchWindowContext = {
  kind: string;
  id: string;
};

type WorkbenchDialogGroupValues<TValue> = unknown extends TValue
  ? Record<string, unknown>
  : NonNullable<TValue> extends Record<string, unknown>
  ? NonNullable<TValue>
  : never;

export type WorkbenchDialogSchema<
  TValues extends Record<string, unknown> = Record<string, unknown>
> = {
  fields: WorkbenchDialogField<TValues>[];
};

type WorkbenchDialogLeafField<TValues extends Record<string, unknown>> =
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

type WorkbenchDialogGroupField<TValues extends Record<string, unknown>> = {
  [TGroupKey in keyof TValues & string]: NonNullable<TValues[TGroupKey]> extends Record<string, unknown>
    ? {
        kind: "group";
        key: TGroupKey;
        label: string;
        fields: WorkbenchDialogLeafField<WorkbenchDialogGroupValues<TValues[TGroupKey]>>[];
      }
    : unknown extends TValues[TGroupKey]
      ? {
          kind: "group";
          key: TGroupKey;
          label: string;
          fields: WorkbenchDialogLeafField<WorkbenchDialogGroupValues<TValues[TGroupKey]>>[];
        }
    : never;
}[keyof TValues & string];

export type WorkbenchDialogField<TValues extends Record<string, unknown> = Record<string, unknown>> =
  | WorkbenchDialogLeafField<TValues>
  | WorkbenchDialogGroupField<TValues>;

export type WorkbenchDialogBlock<TValues extends Record<string, unknown> = Record<string, unknown>> =
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

export type WorkbenchDialogAction<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
> = {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  run?: (context: { values: TValues; windowId: string }) => Promise<TResult> | TResult;
};

export type WorkbenchWindowDefinition<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
> = {
  id?: string;
  kind: WorkbenchWindowKind;
  title: string;
  description?: string;
  size: WorkbenchWindowSize;
  schema?: WorkbenchDialogSchema<TValues>;
  blocks?: WorkbenchDialogBlock<TValues>[];
  actions?: WorkbenchDialogAction<TValues, TResult>[];
  parentId?: string;
  modal?: boolean;
  movable?: boolean;
  showCloseButton?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  context?: WorkbenchWindowContext;
};

export type WorkbenchDialogDefinition<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
> = Omit<WorkbenchWindowDefinition<TValues, TResult>, "kind"> & {
  kind?: Extract<WorkbenchWindowKind, "dialog" | "child-dialog">;
};

export type WorkbenchWindowDialogController<
  TValues extends Record<string, unknown> = Record<string, unknown>
> = {
  snapshotValues: () => TValues;
};

export type WorkbenchWindowResult<TResult = unknown, TValues extends Record<string, unknown> = Record<string, unknown>> =
  | { reason: "action"; actionId: string; values: TValues; result?: TResult }
  | { reason: "close"; values: TValues }
  | { reason: "dismiss"; values: TValues };
