import type { SessionTaskTracker } from "#conversation/taskTracker/taskTrackerTypes.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";

interface ToolPlaybook {
  id: string;
  title: string;
  buildLines(input: ToolPlaybookBuildInput): string[];
}

interface ToolPlaybookBuildInput {
  activeToolsetIds: Set<string>;
  visibleToolNames: Set<string>;
  hasActiveTask: boolean;
}

function hasAnyTool(visibleToolNames: Set<string>, toolNames: string[]): boolean {
  return toolNames.some((name) => visibleToolNames.has(name));
}

const WEB_SEARCH_TOOL_NAMES = [
  "ground_with_google_search",
  "search_with_iqs_lite_advanced"
];

const WEB_BROWSER_TOOL_NAMES = [
  "open_page",
  "inspect_page",
  "interact_with_page",
  "capture_screenshot"
];

const SHELL_TOOL_NAMES = [
  "terminal_list",
  "terminal_run",
  "terminal_start",
  "terminal_read",
  "terminal_write",
  "terminal_send_lines",
  "terminal_key",
  "terminal_signal",
  "terminal_stop"
];

const WEB_RESEARCH_PLAYBOOK: ToolPlaybook = {
  id: "web_research",
  title: "网页检索与浏览流程",
  buildLines(input) {
    if (!input.activeToolsetIds.has("web_research")) {
      return [];
    }
    const lines: string[] = [];
    if (hasAnyTool(input.visibleToolNames, WEB_SEARCH_TOOL_NAMES)) {
      lines.push(
        "- 先判断是否真的需要外部信息：时效、版本、价格、政策、新闻、API 状态、网页当前状态必须查；常识或已有上下文足够时不要查。",
        "- 先把问题拆成 1-3 个可验证查询；优先搜索专有名词、版本号、错误码、官方名称。",
        "- 重要结论优先使用官方文档、一手公告、标准文档、代码仓库、论文或原始数据；新闻和博客只作补充。",
        "- 涉及时效性时必须核对发布日期和事件发生日期；不要把旧页面当最新状态。",
        "- 多来源不一致时说明差异，并优先采用权威度更高、时间更新、证据更直接的来源。",
        "- 最终回答要区分已由来源确认的事实和基于来源做出的推断；需要引用时给出来源名称、链接和日期。"
      );
    }
    if (hasAnyTool(input.visibleToolNames, WEB_BROWSER_TOOL_NAMES)) {
      if (input.visibleToolNames.has("open_page") && input.visibleToolNames.has("inspect_page")) {
        lines.push("- 搜索摘要不足以支撑结论时打开页面；open_page 后先 inspect_page 理解页面结构。");
      }
      if (input.visibleToolNames.has("inspect_page")) {
        lines.push("- 页面跳转、刷新、弹窗或表单变化后重新 inspect。");
      }
      if (input.visibleToolNames.has("interact_with_page")) {
        lines.push("- 网页交互有 target_id 时优先用 target_id；定位失败再用语义 target 或截图。");
        lines.push("- 登录、提交、删除、购买、发送消息、授权等有外部影响的动作，必须先获得用户明确确认。");
      }
      lines.push("- 遇到验证码、短信码、邮箱码或 TOTP 时向用户索取；验证码只用于当前步骤，不写入长期资料。");
    }
    return lines;
  }
};

const SHELL_RUNTIME_PLAYBOOK: ToolPlaybook = {
  id: "shell_runtime",
  title: "终端操作流程",
  buildLines(input) {
    if (!input.activeToolsetIds.has("shell_runtime") || !hasAnyTool(input.visibleToolNames, SHELL_TOOL_NAMES)) {
      return [];
    }
    const lines = [
      "- 开始前确认目标、cwd 和已有 live_resource；继续旧任务时优先复用已有 resource_id。",
      "- 查询代码优先用 rg 或 rg --files；避免 ls -R、find 全盘、cat 大文件、无过滤日志输出。",
      "- 每次命令只推进一个清晰步骤；失败后先读错误、确认路径、环境和配置，再调整命令。",
      "- 不要把命令成功等同于任务完成；根据输出、测试结果和用户目标判断是否已交付。",
      "- 停止进程、杀服务、删除文件、重写历史、安装依赖或访问外部网络时，先按项目策略确认权限和副作用。"
    ];
    if (input.visibleToolNames.has("terminal_list") || input.visibleToolNames.has("terminal_read")) {
      lines.push("- 继续旧任务时先 terminal_list/terminal_read 查看已有资源状态。");
    }
    if (input.visibleToolNames.has("terminal_run") && input.visibleToolNames.has("terminal_start")) {
      lines.push("- 短命令用 terminal_run；长任务、watch/dev server、交互程序或大输出命令用 terminal_start，并写 description。");
    } else if (input.visibleToolNames.has("terminal_run")) {
      lines.push("- terminal_run 适合短命令；若返回 resource_id，后续复用该资源继续处理。");
    } else if (input.visibleToolNames.has("terminal_start")) {
      lines.push("- terminal_start 适合长任务、watch/dev server、交互程序或大输出命令，并应写 description。");
    }
    if (hasAnyTool(input.visibleToolNames, ["terminal_read", "terminal_write", "terminal_key", "terminal_signal"])) {
      lines.push("- 后台 resource_id 返回后，不要重复启动同类任务；用可见的 terminal 读写/按键/信号工具继续交互。");
    }
    lines.push("- 等待输入触发只表示可能需要输入；不确定选择项、密码或验证码时先问用户。");
    return lines;
  }
};

const TASK_EXECUTION_PLAYBOOK: ToolPlaybook = {
  id: "complex_task_execution",
  title: "多步任务执行流程",
  buildLines(input) {
    if (!input.hasActiveTask || input.activeToolsetIds.size === 0) {
      return [];
    }
    return [
      "- 先确认目标、约束和当前状态，再决定下一步。",
      "- 每次工具调用只推进一个清晰的小步骤。",
      "- 优先复用已有 live_resource，不要重复打开相同页面或启动重复终端。",
      "- 工具失败时先根据错误调整参数、换路径或换工具；不要直接放弃。",
      "- 如果已有信息足够完成用户请求，停止工具调用并交付结果。",
      "- 如果达到工具轮次或上下文预算限制，基于现有结果总结已完成、未完成和下一步建议。"
    ];
  }
};

const TOOL_PLAYBOOKS = [
  WEB_RESEARCH_PLAYBOOK,
  SHELL_RUNTIME_PLAYBOOK,
  TASK_EXECUTION_PLAYBOOK
];

export function buildToolPlaybookLines(input: {
  activeToolsets?: ToolsetView[] | undefined;
  visibleToolNames?: string[] | undefined;
  taskTracker?: SessionTaskTracker | undefined;
}): string[] {
  const activeToolsetIds = new Set((input.activeToolsets ?? []).map((toolset) => toolset.id));
  const visibleToolNames = new Set([
    ...(input.visibleToolNames ?? []),
    ...(input.activeToolsets ?? []).flatMap((toolset) => toolset.toolNames)
  ]);
  const hasActiveTask = input.taskTracker?.primary
    ? ["active", "waiting_tool", "waiting_user"].includes(input.taskTracker.primary.status)
    : false;
  return TOOL_PLAYBOOKS.flatMap((playbook) => {
    const lines = playbook.buildLines({ activeToolsetIds, visibleToolNames, hasActiveTask });
    return lines.length > 0 ? [`${playbook.title}：`, ...lines] : [];
  });
}
