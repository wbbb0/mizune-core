import type { Component } from "vue";

/** 预设窗口宽度。full 在移动端/桌面端会按容器上限处理。 */
export type WorkbenchWindowSize = "auto" | "sm" | "md" | "lg" | "xl" | "full";

/** 当前窗口系统支持的窗口类型。 */
export type WorkbenchWindowKind = "dialog" | "child-dialog";

/** Dialog footer 展示策略。auto 会在存在表单或动作时展示 footer。 */
export type WorkbenchDialogFooterMode = "auto" | "close" | "hidden";

/** 业务上下文标识，用于批量关闭同类窗口或避免重复打开。 */
export type WorkbenchWindowContext = {
  kind: string;
  id: string;
};

export type WorkbenchWindowPosition = {
  x: number;
  y: number;
};

export type WorkbenchWindowSizePx = {
  width: number;
  height: number;
};

export type WorkbenchWindowBounds = {
  position: WorkbenchWindowPosition;
  sizePx?: WorkbenchWindowSizePx;
};

export type WorkbenchWindowSizedBounds = {
  position: WorkbenchWindowPosition;
  sizePx: WorkbenchWindowSizePx;
};

export type WorkbenchWindowMaximizePayload =
  | {
      maximized: true;
      bounds: WorkbenchWindowSizedBounds;
      restoreBounds: WorkbenchWindowSizedBounds;
    }
  | {
      maximized: false;
      bounds: WorkbenchWindowSizedBounds;
    };

type WorkbenchDialogGroupValues<TValue> = unknown extends TValue
  ? Record<string, unknown>
  : NonNullable<TValue> extends Record<string, unknown>
  ? NonNullable<TValue>
  : never;

export type WorkbenchDialogSchema<
  TValues extends Record<string, unknown> = Record<string, unknown>
> = {
  /** 表单字段列表，字段 key 会写入 action 收到的 values。 */
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
  /** 稳定动作 ID，会出现在窗口关闭结果中。 */
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  /** 点击动作时执行。返回值会作为 action result 回传给 open/openDialog。 */
  run?: (context: { values: TValues; windowId: string }) => Promise<TResult> | TResult;
};

/** 运行时窗口定义。业务项目通常通过 useWorkbenchWindows().openDialog 传入。 */
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
  resizable?: boolean;
  showCloseButton?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  footer?: WorkbenchDialogFooterMode;
  context?: WorkbenchWindowContext;
};

/** 对话框便捷定义。kind 可省略，默认会按 dialog 处理。 */
export type WorkbenchDialogDefinition<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
> = Omit<WorkbenchWindowDefinition<TValues, TResult>, "kind"> & {
  kind?: Extract<WorkbenchWindowKind, "dialog" | "child-dialog">;
};

export type WorkbenchWindowDialogController<
  TValues extends Record<string, unknown> = Record<string, unknown>
> = {
  /** 读取当前表单值，用于关闭窗口前生成 result。 */
  snapshotValues: () => TValues;
};

/** 窗口关闭结果。action 表示按钮动作，close 表示主动关闭，dismiss 表示背景/Escape 等取消。 */
export type WorkbenchWindowResult<TResult = unknown, TValues extends Record<string, unknown> = Record<string, unknown>> =
  | { reason: "action"; actionId: string; values: TValues; result?: TResult }
  | { reason: "close"; values: TValues }
  | { reason: "dismiss"; values: TValues };
