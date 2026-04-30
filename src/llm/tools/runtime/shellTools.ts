import type { ShellRunParams } from "#services/shell/types.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";
import { getBooleanArg, getNumberArg, getStringArg, getStringArrayArg } from "../core/toolArgHelpers.ts";

const isShellToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.shell.enabled;
const TERMINAL_KEY_NAMES = [
  "enter",
  "tab",
  "escape",
  "backspace",
  "ctrl_c",
  "ctrl_d",
  "arrow_up",
  "arrow_down",
  "arrow_left",
  "arrow_right",
  "tmux_prefix",
  "tmux_split_right",
  "tmux_split_down",
  "tmux_new_window",
  "tmux_next_window",
  "tmux_previous_window",
  "tmux_detach",
  "tmux_command_prompt",
  "tmux_copy_mode",
  "tmux_paste_buffer",
  "tmux_zoom_pane"
] as const;

export const shellToolDescriptors: ToolDescriptor[] = [
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "terminal_list",
        description: "列出当前可复用的 terminal resource。需要继续终端任务时先复用已有 resource_id。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    isEnabled: isShellToolEnabled
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "terminal_run",
        description: "运行终端命令并等待结果。若超过 timeout_ms 仍未结束，命令会自动转入后台继续运行，返回 resource_id 供后续 terminal_read/terminal_write/terminal_key/terminal_signal 使用。开启新 terminal 资源时应尽量提供 description，说明这个会话是做什么的。\n\n【重要】禁止使用可能产生海量输出的命令（如 ls -R、find 不加 -maxdepth、cat 大文件等），这类命令会导致输出被截断且浪费上下文。如需列目录请用 ls -la 或 find . -maxdepth 2；如需查看文件请用 head/tail；如需搜索请用 grep -r --include 加限定条件。预计输出超大时请改用 terminal_start 后分批 terminal_read。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            description: { type: "string", description: "给这个 shell 资源的用途说明，便于后续复用时识别。" },
            cwd: { type: "string" },
            timeout_ms: { type: "number", description: "等待完成的超时时长，默认 15000ms；超时后命令转入后台。" },
            tty: { type: "boolean", description: "是否使用 PTY，默认 true" },
            notify_policy: {
              type: "string",
              enum: ["none", "notify_on_close", "notify_on_input_and_close"],
              description: "后台运行后何时自动回到本会话；默认在完成或等待输入时触发。"
            }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isShellToolEnabled
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "terminal_start",
        description: "启动终端命令并直接放入后台，立即返回 resource_id；用于长任务、交互程序、watch/dev server 或预计输出较大的命令。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            description: { type: "string", description: "给这个 terminal 资源的用途说明，便于后续复用时识别。" },
            cwd: { type: "string" },
            tty: { type: "boolean", description: "是否使用 PTY，默认 true" },
            notify_policy: {
              type: "string",
              enum: ["none", "notify_on_close", "notify_on_input_and_close"],
              description: "后台运行后何时自动回到本会话；默认在完成或等待输入时触发。"
            }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isShellToolEnabled
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "terminal_read",
        description: "读取后台 terminal resource 自上次读取以来的新增输出。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" }
          },
          required: ["resource_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isShellToolEnabled
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "terminal_write",
        description: "向运行中的 terminal resource 发送原始文本输入。命令行输入通常需要自己在 input 末尾包含换行。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" },
            input: { type: "string", description: "要发送的文本，如命令后接 \\n" }
          },
          required: ["resource_id", "input"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isShellToolEnabled
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "terminal_key",
        description: "向运行中的 terminal resource 发送常见按键、控制组合或 tmux 语义快捷键。key 发送单个按键；keys 按数组顺序发送多个枚举按键。普通文本必须使用 terminal_write，不要放进 keys。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" },
            key: {
              type: "string",
              enum: TERMINAL_KEY_NAMES
            },
            keys: {
              type: "array",
              items: {
                type: "string",
                enum: TERMINAL_KEY_NAMES
              },
              minItems: 1,
              maxItems: 16,
              description: "按顺序发送的按键队列。只允许 enum 值；普通文本用 terminal_write。"
            }
          },
          required: ["resource_id"],
          anyOf: [
            { required: ["resource_id", "key"] },
            { required: ["resource_id", "keys"] }
          ],
          additionalProperties: false
        }
      }
    },
    isEnabled: isShellToolEnabled
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "terminal_signal",
        description: "向 terminal resource 发送信号。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" },
            signal: { type: "string", enum: ["SIGINT", "SIGTERM", "SIGKILL"] }
          },
          required: ["resource_id", "signal"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isShellToolEnabled
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "terminal_stop",
        description: "停止 terminal resource，默认发送 SIGTERM；需要强制结束时改用 terminal_signal(signal=SIGKILL)。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" }
          },
          required: ["resource_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isShellToolEnabled
  }
];

export const shellToolHandlers: Record<string, ToolHandler> = {
  async terminal_list(_toolCall, _args, context) {
    const denied = requireOwner(context.relationship, "Only owner can list terminal resources");
    if (denied) return denied;

    const resources = await context.shellRuntime.listSessionResources();
    return JSON.stringify({ ok: true, terminals: resources });
  },

  async terminal_run(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can run shell commands");
    if (denied) return denied;

    const runParams = buildShellRunParams(args);
    bindShellRunOwner(runParams, args, context);
    const result = await context.shellRuntime.run(runParams);
    return JSON.stringify(result);
  },

  async terminal_start(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can start terminal commands");
    if (denied) return denied;

    const runParams = buildShellRunParams(args);
    bindShellRunOwner(runParams, args, context);
    runParams.background = true;
    const result = await context.shellRuntime.run(runParams);
    return JSON.stringify(result);
  },

  async terminal_write(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can interact with shell");
    if (denied) return denied;

    const resourceId = getStringArg(args, "resource_id")!;
    const input = getStringArg(args, "input")!;

    const result = await context.shellRuntime.interact(resourceId, input);
    const { outputTail: _tail, ...session } = result.session;
    return JSON.stringify({ output: result.output, session });
  },

  async terminal_read(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can read from shell");
    if (denied) return denied;

    const resourceId = getStringArg(args, "resource_id")!;
    const result = await context.shellRuntime.read(resourceId);
    const { outputTail: _tail, ...session } = result.session;
    return JSON.stringify({ output: result.output, session });
  },

  async terminal_key(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can send terminal keys");
    if (denied) return denied;

    const resourceId = getStringArg(args, "resource_id")!;
    const keys = terminalKeysArg(args);
    const inputParts: string[] = [];
    for (const key of keys) {
      const input = terminalKeyInput(key);
      if (!input) {
        return JSON.stringify({ error: `unsupported key: ${key}` });
      }
      inputParts.push(input);
    }
    const input = inputParts.join("");
    if (!input) {
      return JSON.stringify({ error: "key or keys is required" });
    }
    const result = await context.shellRuntime.interact(resourceId, input);
    const { outputTail: _tail, ...session } = result.session;
    return JSON.stringify({ output: result.output, session });
  },

  async terminal_signal(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can send signals to shell");
    if (denied) return denied;

    const resourceId = getStringArg(args, "resource_id")!;
    const signal = getStringArg(args, "signal")!;

    const result = await context.shellRuntime.signal(resourceId, signal);
    return JSON.stringify(result);
  },

  async terminal_stop(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can stop terminal resources");
    if (denied) return denied;

    const resourceId = getStringArg(args, "resource_id")!;
    const result = await context.shellRuntime.signal(resourceId, "SIGTERM");
    return JSON.stringify(result);
  },
};

function buildShellRunParams(args: unknown): ShellRunParams {
  const command = getStringArg(args, "command")!;
  const description = getStringArg(args, "description");
  const cwd = getStringArg(args, "cwd");
  const timeoutMs = getNumberArg(args, "timeout_ms");
  const tty = getBooleanArg(args, "tty");

  const runParams: ShellRunParams = { command };
  if (description) {
    runParams.description = description;
  }
  if (cwd) {
    runParams.cwd = cwd;
  }
  if (timeoutMs) {
    runParams.timeoutMs = timeoutMs;
  }
  if (typeof tty === "boolean") {
    runParams.tty = tty;
  }
  return runParams;
}

function bindShellRunOwner(runParams: ShellRunParams, args: unknown, context: Parameters<ToolHandler>[2]): void {
  if (!context.lastMessage) {
    return;
  }
  runParams.owner = {
    sessionId: context.lastMessage.sessionId,
    userId: context.lastMessage.userId,
    senderName: context.lastMessage.senderName
  };
  const notifyPolicy = getStringArg(args, "notify_policy");
  if (notifyPolicy === "none" || notifyPolicy === "notify_on_close" || notifyPolicy === "notify_on_input_and_close") {
    runParams.notifyPolicy = notifyPolicy;
  } else {
    runParams.notifyPolicy = "notify_on_input_and_close";
  }
}

function terminalKeysArg(args: unknown): string[] {
  const keys = getStringArrayArg(args, "keys");
  if (keys && keys.length > 0) {
    return keys;
  }
  const key = getStringArg(args, "key");
  return key ? [key] : [];
}

function terminalKeyInput(key: string): string | null {
  switch (key) {
    case "enter":
      return "\n";
    case "tab":
      return "\t";
    case "escape":
      return "\u001b";
    case "backspace":
      return "\u007f";
    case "ctrl_c":
      return "\u0003";
    case "ctrl_d":
      return "\u0004";
    case "arrow_up":
      return "\u001b[A";
    case "arrow_down":
      return "\u001b[B";
    case "arrow_right":
      return "\u001b[C";
    case "arrow_left":
      return "\u001b[D";
    case "tmux_prefix":
      return "\u0002";
    case "tmux_split_right":
      return "\u0002%";
    case "tmux_split_down":
      return "\u0002\"";
    case "tmux_new_window":
      return "\u0002c";
    case "tmux_next_window":
      return "\u0002n";
    case "tmux_previous_window":
      return "\u0002p";
    case "tmux_detach":
      return "\u0002d";
    case "tmux_command_prompt":
      return "\u0002:";
    case "tmux_copy_mode":
      return "\u0002[";
    case "tmux_paste_buffer":
      return "\u0002]";
    case "tmux_zoom_pane":
      return "\u0002z";
    default:
      return null;
  }
}
