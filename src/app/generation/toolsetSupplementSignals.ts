import type { GenerationRuntimeBatchMessage } from "./generationExecutor.ts";
import type { GenerationPromptToolEvent } from "./generationPromptBuilder.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";

type RecentToolsetDomains = {
  hasWeb: boolean;
  hasShell: boolean;
  hasLocalFiles: boolean;
  hasChatContext: boolean;
};

export interface ToolsetSupplementSignals {
  hasStructuredResolvableContent: boolean;
  hasWebIntent: boolean;
  hasShellIntent: boolean;
  hasLocalFileIntent: boolean;
  hasMemoryIntent: boolean;
  hasSchedulerIntent: boolean;
  hasTimeIntent: boolean;
  hasSocialIntent: boolean;
  hasConversationNavigationIntent: boolean;
  hasDelegationIntent: boolean;
  hasComfyIntent: boolean;
  hasDownloadIntent: boolean;
  hasWebContextReference: boolean;
  hasFollowupReference: boolean;
  isEllipticalFollowup: boolean;
  recentDomains: RecentToolsetDomains;
}

const INTENT_PATTERNS = {
  web: [
    /最新|最近|新闻|搜一下|搜索|查一下|查一查|帮我查|检索|网页|网站|官网|链接|来源|出处|核实|验证|事实/u,
    /\bhttps?:\/\//u
  ],
  shell: [
    /shell|终端|命令行|命令|脚本|日志|进程|服务|端口|环境变量|报错|排查|调试|运行一下|执行一下|启动一下|重启/u
  ],
  localFile: [
    /文件|文档|pdf|markdown|md\b|txt\b|csv\b|json\b|yaml\b|yml\b|保存|落盘|下载|上传|导出|导入|本地文件|附件/u
  ],
  memory: [
    /记住|记下来|以后按这个来|长期|偏好|资料|档案|人设|persona|设定|角色设定|口吻|说话方式|身份|喜欢|讨厌|规则|全局规则|工具集规则/u
  ],
  scheduler: [
    /提醒|定时|稍后|晚点|明天|后天|下周|每天|每周|每月|cron|周期|到点/u
  ],
  time: [
    /几点|时间|当前时间|现在几点|现在几号|今天几号/u
  ],
  social: [
    /好友申请|加群|入群|审批|通过申请|拒绝申请|白名单|放行|拉黑|好友列表|群列表/u
  ],
  navigation: [
    /上一段对话|另一个会话|其他会话|别的聊天|跨会话|历史会话|之前那个群|之前那个私聊/u
  ],
  delegation: [
    /转告|转发给|通知到|发到另一个群|发给另一个人|委派到|发去那个会话/u
  ],
  comfy: [
    /生成图片|画一张|出图|文生图|重绘|comfyui/u
  ]
} as const;

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

// Converts raw message text and recent tool activity into reusable planning signals.
// The supplement policy consumes these booleans instead of inspecting regexes inline.
export function buildToolsetSupplementSignals(input: {
  availableToolsets: ToolsetView[];
  batchMessages: GenerationRuntimeBatchMessage[];
  recentToolEvents: GenerationPromptToolEvent[];
}): ToolsetSupplementSignals {
  const currentText = normalizeText(input.batchMessages.map((item) => item.text).join("\n"));
  return {
    hasStructuredResolvableContent: hasStructuredResolvableContent(input.batchMessages),
    hasWebIntent: matchesAny(currentText, INTENT_PATTERNS.web),
    hasShellIntent: matchesAny(currentText, INTENT_PATTERNS.shell),
    hasLocalFileIntent: matchesAny(currentText, INTENT_PATTERNS.localFile),
    hasMemoryIntent: matchesAny(currentText, INTENT_PATTERNS.memory),
    hasSchedulerIntent: matchesAny(currentText, INTENT_PATTERNS.scheduler),
    hasTimeIntent: matchesAny(currentText, INTENT_PATTERNS.time),
    hasSocialIntent: matchesAny(currentText, INTENT_PATTERNS.social),
    hasConversationNavigationIntent: matchesAny(currentText, INTENT_PATTERNS.navigation),
    hasDelegationIntent: matchesAny(currentText, INTENT_PATTERNS.delegation),
    hasComfyIntent: matchesAny(currentText, INTENT_PATTERNS.comfy),
    hasDownloadIntent: matchesAny(currentText, DOWNLOAD_INTENT_PATTERNS),
    hasWebContextReference: matchesAny(currentText, WEB_CONTEXT_PATTERNS),
    hasFollowupReference: matchesAny(currentText, FOLLOWUP_REFERENCE_PATTERNS),
    isEllipticalFollowup: isEllipticalFollowup(currentText),
    recentDomains: summarizeRecentDomains(input.availableToolsets, input.recentToolEvents)
  };
}

function summarizeRecentDomains(
  availableToolsets: ToolsetView[],
  recentToolEvents: GenerationPromptToolEvent[]
): RecentToolsetDomains {
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
