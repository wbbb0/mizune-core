import type { WorkbenchDialogDefinition, WorkbenchWindowResult } from "@/components/workbench/windows/types";
import { buildCreateSessionPayload, type CreateSessionPayload } from "./createSessionPayload";
import CreateSessionModeBlock from "./CreateSessionModeBlock.vue";
import CreateSessionTitleField from "./CreateSessionTitleField.vue";
import {
  DEFAULT_CREATE_SESSION_MODE_ID,
  readStoredCreateSessionModeId,
  resolveCreateSessionModeId,
  writeStoredCreateSessionModeId
} from "./createSessionDefaults";

type WindowOpener = {
  openDialog<TValues extends Record<string, unknown>, TResult>(
    definition: WorkbenchDialogDefinition<TValues, TResult>
  ): Promise<WorkbenchWindowResult<TResult, TValues>>;
};

type CreateSessionWindowValues = {
  title: string;
  modeId: string;
};

export type SessionModeSummary = {
  id: string;
  title: string;
  description: string;
};

function resolveModeId(modes: SessionModeSummary[], storage: Pick<Storage, "getItem"> | null | undefined) {
  return resolveCreateSessionModeId({
    storedModeId: readStoredCreateSessionModeId(storage),
    availableModeIds: modes.map((item) => item.id),
    fallbackModeId: DEFAULT_CREATE_SESSION_MODE_ID
  });
}

export async function openCreateSessionWindow(input: {
  windows: WindowOpener;
  modes: SessionModeSummary[];
  submit: (payload: CreateSessionPayload) => Promise<void>;
  reportError?: (error: unknown) => void;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}) {
  const storage = input.storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  const defaultModeId = resolveModeId(input.modes, storage);

  const result = await input.windows.openDialog<CreateSessionWindowValues, CreateSessionPayload>({
    title: "新建会话",
    description: "创建一个 owner Web 会话。这个表单只保留展示与模式字段。",
    size: "lg",
    modal: true,
    schema: {
      fields: [
        {
          kind: "custom",
          key: "title",
          component: CreateSessionTitleField
        },
        {
          kind: "enum",
          key: "modeId",
          label: "会话模式",
          defaultValue: defaultModeId,
          options: input.modes.map((mode) => ({
            label: mode.title,
            value: mode.id
          }))
        }
      ]
    },
    blocks: [
      {
        kind: "component",
        component: CreateSessionModeBlock,
        props: {
          modes: input.modes
        }
      }
    ],
    actions: [
      {
        id: "submit",
        label: "创建会话",
        variant: "primary",
        run: async ({ values }) => {
          const payload = buildCreateSessionPayload({
            title: String(values.title ?? ""),
            modeId: String(values.modeId ?? "")
          });
          try {
            await input.submit(payload);
          } catch (error: unknown) {
            input.reportError?.(error);
            throw error;
          }
          return payload;
        }
      }
    ]
  });

  writeStoredCreateSessionModeId(storage, String(result.values.modeId ?? defaultModeId));
  return result;
}
