import type { GenerationRuntimeBatchMessage } from "./generationExecutor.ts";
import type { GenerationPromptToolEvent } from "./generationPromptBuilder.ts";
import type { ToolsetView } from "#llm/tools/toolsets.ts";

export interface ToolsetSupplementInput {
  selectedToolsetIds: string[];
  availableToolsets: ToolsetView[];
  batchMessages: GenerationRuntimeBatchMessage[];
  recentToolEvents: GenerationPromptToolEvent[];
}

export interface ToolsetSupplementResult {
  toolsetIds: string[];
  addedToolsetIds: string[];
  reasons: string[];
}

const TOOLSET_PATTERN_RULES: Array<{ toolsetId: string; reason: string; patterns: readonly RegExp[] }> = [
  {
    toolsetId: "web_research",
    reason: "current_web_intent",
    patterns: [
  /最新|最近|新闻|搜一下|搜索|查一下|查一查|帮我查|检索|网页|网站|官网|链接|来源|出处|核实|验证|事实/u,
  /\bhttps?:\/\//u
    ]
  },
  {
    toolsetId: "shell_runtime",
    reason: "current_shell_intent",
    patterns: [
  /shell|终端|命令行|命令|脚本|日志|进程|服务|端口|环境变量|报错|排查|调试|运行一下|执行一下|启动一下|重启/u
    ]
  },
  {
    toolsetId: "local_file_io",
    reason: "current_local_file_intent",
    patterns: [
  /文件|文档|pdf|markdown|md\b|txt\b|csv\b|json\b|yaml\b|yml\b|保存|落盘|下载|上传|导出|导入|本地文件|附件/u
    ]
  },
  {
    toolsetId: "memory_profile",
    reason: "current_memory_intent",
    patterns: [
      /记住|记下来|以后按这个来|长期|偏好|资料|档案|人设|persona|设定|角色设定|口吻|说话方式|身份|喜欢|讨厌/u
    ]
  },
  {
    toolsetId: "scheduler_admin",
    reason: "current_scheduler_intent",
    patterns: [
      /提醒|定时|稍后|晚点|明天|后天|下周|每天|每周|每月|cron|周期|到点/u
    ]
  },
  {
    toolsetId: "time_utils",
    reason: "current_time_intent",
    patterns: [
      /几点|时间|当前时间|现在几点|现在几号|今天几号/u
    ]
  },
  {
    toolsetId: "social_admin",
    reason: "current_social_intent",
    patterns: [
      /好友申请|加群|入群|审批|通过申请|拒绝申请|白名单|放行|拉黑|好友列表|群列表/u
    ]
  },
  {
    toolsetId: "conversation_navigation",
    reason: "current_navigation_intent",
    patterns: [
      /上一段对话|另一个会话|其他会话|别的聊天|跨会话|历史会话|之前那个群|之前那个私聊/u
    ]
  },
  {
    toolsetId: "chat_delegation",
    reason: "current_delegation_intent",
    patterns: [
      /转告|转发给|通知到|发到另一个群|发给另一个人|委派到|发去那个会话/u
    ]
  },
  {
    toolsetId: "comfy_image",
    reason: "current_comfy_intent",
    patterns: [
      /生成图片|画一张|出图|文生图|重绘|comfyui/u
    ]
  }
] as const;
const WEB_INTENT_PATTERNS = TOOLSET_PATTERN_RULES.find((item) => item.toolsetId === "web_research")?.patterns ?? [];

const WEB_CONTEXT_PATTERNS = [
  /页面|网页|网站|官网|浏览器|链接/u
] as const;
const DOWNLOAD_INTENT_PATTERNS = [
  /下载|下下来|保存下来|存一下|落盘|导出|保存到本地|传给我/u
] as const;
const FOLLOWUP_SHORT_PATTERNS = [
  /^继续/,
  /^接着/,
  /^然后/,
  /^再/,
  /^还是/,
  /^就这个/,
  /^这个/,
  /^那个/,
  /^它/,
  /^点进去/,
  /^下下来/,
  /再看看/,
  /点进去看看/
] as const;
const FOLLOWUP_REFERENCE_PATTERNS = [
  /这个|那个|它|这里|上面|刚才|刚刚|上条|上一条|前面/u
] as const;

export function supplementPlannedToolsets(input: ToolsetSupplementInput): ToolsetSupplementResult {
  const availableToolsets = new Set(input.availableToolsets.map((item) => item.id));
  const selected = new Set(input.selectedToolsetIds.filter((item) => availableToolsets.has(item)));
  const reasons: string[] = [];
  const currentText = normalizeText(input.batchMessages.map((item) => item.text).join("\n"));
  const followup = isEllipticalFollowup(currentText);
  const recentDomains = summarizeRecentDomains(input.availableToolsets, input.recentToolEvents);

  const add = (toolsetId: string, reason: string) => {
    if (!availableToolsets.has(toolsetId) || selected.has(toolsetId)) {
      return;
    }
    selected.add(toolsetId);
    reasons.push(`${toolsetId}:${reason}`);
  };

  if (hasStructuredResolvableContent(input.batchMessages)) {
    add("chat_context", "structured_content");
  }
  for (const rule of TOOLSET_PATTERN_RULES) {
    if (matchesAny(currentText, rule.patterns)) {
      add(rule.toolsetId, rule.reason);
    }
  }

  if (selected.has("web_research") && matchesAny(currentText, DOWNLOAD_INTENT_PATTERNS)) {
    add("local_file_io", "web_download_linkage");
  }
  if (selected.has("local_file_io") && matchesAny(currentText, WEB_CONTEXT_PATTERNS)) {
    add("web_research", "workspace_web_linkage");
  }
  if (selected.has("chat_context") && matchesAny(currentText, WEB_INTENT_PATTERNS)) {
    add("web_research", "chat_context_web_linkage");
  }

  if (followup) {
    if (recentDomains.hasWeb) {
      add("web_research", "followup_recent_web");
    }
    if (recentDomains.hasShell) {
      add("shell_runtime", "followup_recent_shell");
    }
    if (recentDomains.hasLocalFiles) {
      add("local_file_io", "followup_recent_workspace");
    }
    if (recentDomains.hasChatContext || matchesAny(currentText, FOLLOWUP_REFERENCE_PATTERNS)) {
      add("chat_context", "followup_recent_context");
    }
    if (matchesAny(currentText, DOWNLOAD_INTENT_PATTERNS) && (recentDomains.hasWeb || selected.has("web_research"))) {
      add("local_file_io", "followup_recent_web_download");
    }
  }

  const ordered = input.availableToolsets
    .map((item) => item.id)
    .filter((item) => selected.has(item));
  const addedToolsetIds = ordered.filter((item) => !input.selectedToolsetIds.includes(item));
  return {
    toolsetIds: ordered,
    addedToolsetIds,
    reasons
  };
}

function summarizeRecentDomains(
  availableToolsets: ToolsetView[],
  recentToolEvents: GenerationPromptToolEvent[]
): {
  hasWeb: boolean;
  hasShell: boolean;
  hasLocalFiles: boolean;
  hasChatContext: boolean;
} {
  const toolToToolsets = new Map<string, Set<string>>();
  for (const toolset of availableToolsets) {
    for (const toolName of toolset.toolNames) {
      const existing = toolToToolsets.get(toolName) ?? new Set<string>();
      existing.add(toolset.id);
      toolToToolsets.set(toolName, existing);
    }
  }

  let hasWeb = false;
  let hasShell = false;
  let hasLocalFiles = false;
  let hasChatContext = false;
  for (const event of recentToolEvents.slice(-6)) {
    const mapped = toolToToolsets.get(event.toolName);
    if (mapped?.has("web_research")) {
      hasWeb = true;
    }
    if (mapped?.has("shell_runtime")) {
      hasShell = true;
    }
    if (mapped?.has("local_file_io")) {
      hasLocalFiles = true;
    }
    if (mapped?.has("chat_context")) {
      hasChatContext = true;
    }
  }

  return { hasWeb, hasShell, hasLocalFiles, hasChatContext };
}

function hasStructuredResolvableContent(messages: GenerationRuntimeBatchMessage[]): boolean {
  return messages.some((message) => (
    Boolean(message.replyMessageId)
    || (message.forwardIds?.length ?? 0) > 0
    || (message.imageIds?.length ?? 0) > 0
    || (message.emojiIds?.length ?? 0) > 0
    || (message.attachments?.length ?? 0) > 0
  ));
}

function isEllipticalFollowup(text: string): boolean {
  if (!text) {
    return false;
  }
  const compact = text.replace(/[，。！？、,.!?\s]/g, "");
  if (compact.length <= 12 && FOLLOWUP_SHORT_PATTERNS.some((pattern) => pattern.test(compact))) {
    return true;
  }
  return compact.length <= 12 && matchesAny(compact, FOLLOWUP_REFERENCE_PATTERNS);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  if (!text) {
    return false;
  }
  return patterns.some((pattern) => pattern.test(text));
}
