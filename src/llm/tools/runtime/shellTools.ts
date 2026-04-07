import type { ShellRunParams } from "#services/shell/types.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";
import { getBooleanArg, getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";

const isShellToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.shell.enabled && config.shell.mode === "full";

export const shellToolDescriptors: ToolDescriptor[] = [
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "shell_run",
        description: "运行 shell 命令。background=false（默认）时：等待命令完成并返回输出；若超过 timeout_ms 仍未结束，命令转入后台继续运行，返回 resource_id 供后续交互。background=true 时：命令直接挂后台，立即返回 resource_id，不等待任何输出。开启新 shell 资源时应尽量提供 description，说明这个会话是做什么的。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            description: { type: "string", description: "给这个 shell 资源的用途说明，便于后续复用时识别。" },
            cwd: { type: "string" },
            timeout_ms: { type: "number", description: "background=false 时等待完成的超时时长，默认 5000ms；超时后命令转入后台。background=true 时此参数无效。" },
            tty: { type: "boolean", description: "是否使用 PTY，默认 true" },
            background: { type: "boolean", description: "是否直接挂后台运行，默认 false。true 时跳过等待，立即返回 resource_id。" }
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
        name: "shell_interact",
        description: "向运行中的 shell resource 发送输入。",
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
        name: "shell_read",
        description: "读取运行中的 shell resource 新输出。",
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
        name: "shell_signal",
        description: "向 shell resource 发送信号。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" },
            signal: { type: "string", description: "如 SIGINT、SIGTERM、SIGKILL" }
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
        name: "list_shell_sessions",
        description: "列出已知 shell resources，包含 resource_id、状态、命令和 cwd。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    isEnabled: isShellToolEnabled
  }
];

export const shellToolHandlers: Record<string, ToolHandler> = {
  async shell_run(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can run shell commands");
    if (denied) return denied;

    const command = getStringArg(args, "command")!;
    const description = getStringArg(args, "description");
    const cwd = getStringArg(args, "cwd");
    const timeoutMs = getNumberArg(args, "timeout_ms");
    const tty = getBooleanArg(args, "tty");
    const background = getBooleanArg(args, "background");

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
    if (typeof background === "boolean") {
      runParams.background = background;
    }

    const result = await context.shellRuntime.run(runParams);
    return JSON.stringify(result);
  },

  async shell_interact(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can interact with shell");
    if (denied) return denied;

    const resourceId = getStringArg(args, "resource_id")!;
    const input = getStringArg(args, "input")!;

    const result = await context.shellRuntime.interact(resourceId, input);
    return JSON.stringify(result);
  },

  async shell_read(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can read from shell");
    if (denied) return denied;

    const resourceId = getStringArg(args, "resource_id")!;
    const result = await context.shellRuntime.read(resourceId);
    return JSON.stringify(result);
  },

  async shell_signal(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can send signals to shell");
    if (denied) return denied;

    const resourceId = getStringArg(args, "resource_id")!;
    const signal = getStringArg(args, "signal")!;

    const result = await context.shellRuntime.signal(resourceId, signal);
    return JSON.stringify(result);
  },

  async list_shell_sessions(_toolCall, _args, context) {
    const denied = requireOwner(context.relationship, "Only owner can list shell sessions");
    if (denied) return denied;

    return JSON.stringify(await context.shellRuntime.listSessionResources());
  }
};
