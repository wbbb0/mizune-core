import { buildTag as buildTagHint } from "#utils/structuredEnvelope.ts";
import { buildScenarioHostToolHintLines } from "#modes/scenarioHost/toolHints.ts";

function hasAnyTool(visibleToolNames: Set<string>, toolNames: string[]): boolean {
  return toolNames.some((name) => visibleToolNames.has(name));
}

export function buildToolHintLines(visibleToolNamesInput: string[] | undefined): string[] {
  const visibleToolNames = new Set((visibleToolNamesInput ?? []).filter(Boolean));
  if (visibleToolNames.size === 0) {
    return [];
  }

  const lines: string[] = [];

  if (hasAnyTool(visibleToolNames, ["view_message", "download_message_file", "view_forward_record", "asset_media_view", "filesystem_media_view"])) {
    lines.push(`看到 ${buildTagHint("file", { file_id: "...", name: "..." })} 表示用户发来了文件；不要说没看到文件。需要展开消息、转发、图片或消息文件引用时再调用查看/下载工具；message_id、forward_id、image_id、file_id 必须逐字复制。消息文件只在确实需要读取、查看或发送内容时调用 download_message_file 下载。`);
  }

  if (hasAnyTool(visibleToolNames, ["view_current_group_info", "list_current_group_announcements", "view_current_group_announcement", "list_current_group_files", "download_current_group_file", "list_current_group_members"])) {
    lines.push("当前群工具只能读取本会话所在群；查询群公告、群文件或群成员时用 query 缩小范围，并设置合理 limit；公告全文用 view_current_group_announcement 按 startLine/lineCount 分段查看；群文件先 list_current_group_files 再 download_current_group_file。");
  }

  if (visibleToolNames.has("generate_image_with_comfyui")) {
    lines.push("generate_image_with_comfyui 是异步工具：调用后不会立刻拿到图片，系统会在完成后把对应的 asset_handle 再交还给你；旧的 file_id/file_ref 只作为兼容字段。");
    lines.push("收到 ComfyUI 完成通知后，你要自己判断下一步：先 asset_media_view 看图、直接 asset_send_to_chat 发图、继续改 prompt 再生成，或结束本轮。");
    lines.push("generate_image_with_comfyui 只接受 template、positive_prompt、aspect_ratio；不要自己编造宽高。");
  }

  if (hasAnyTool(visibleToolNames, [
    "ground_with_google_search",
    "search_with_iqs_lite_advanced",
    "open_page",
    "inspect_page",
    "interact_with_page",
    "close_page",
    "download_asset",
    "read_download_resource",
    "cancel_download_resource",
    "capture_screenshot",
    "list_browser_profiles",
    "inspect_browser_profile",
    "save_browser_profile",
    "clear_browser_profile"
  ])) {
    const searchHints = [
      visibleToolNames.has("ground_with_google_search") ? "Google grounding 用 ground_with_google_search" : "",
      visibleToolNames.has("search_with_iqs_lite_advanced") ? "可控检索用 search_with_iqs_lite_advanced" : "",
      visibleToolNames.has("open_page") ? "拿到 ref_id 后再 open_page" : ""
    ].filter(Boolean);
    if (searchHints.length > 0) {
      lines.push(searchHints.join("；") + "。");
    }
    if (hasAnyTool(visibleToolNames, ["inspect_page", "interact_with_page"])) {
      lines.push("页面结构和交互目标用 inspect_page 查看；页面交互用 interact_with_page，有 target_id 时优先传 target_id。");
    }
    if (visibleToolNames.has("capture_screenshot")) {
      lines.push("capture_screenshot 可传 target_id 截局部；未传 target_id 时截整页。");
    }
    if (hasAnyTool(visibleToolNames, ["download_asset", "capture_screenshot"])) {
      const fileTools = [
        visibleToolNames.has("download_asset") ? "download_asset" : "",
        visibleToolNames.has("capture_screenshot") ? "capture_screenshot" : ""
      ].filter(Boolean).join("/");
      lines.push(`${fileTools} 短下载会直接返回 asset_handle；长下载会返回 download resource_id，完成或失败后会自动触发，也可用 read_download_resource 主动查看状态。`);
    }
  }

  if (hasAnyTool(visibleToolNames, ["terminal_list", "terminal_run", "terminal_start", "terminal_read", "terminal_write", "terminal_send_lines", "terminal_key", "terminal_signal", "terminal_stop"])) {
    lines.push("terminal_list 可列出当前可复用的 terminal resource。");
    if (visibleToolNames.has("terminal_run")) {
      lines.push("terminal_run 运行命令并等待结果；若 timeout_ms 超时，命令会自动转入后台并返回 resource_id。");
    }
    if (visibleToolNames.has("terminal_start")) {
      lines.push("terminal_start 会直接启动后台 terminal；发送单段文本用 terminal_write，多条控制台命令用 terminal_send_lines，发送 Enter/Tab/Ctrl-C/Ctrl-D/方向键等用 terminal_key，需要 SIGINT/SIGTERM/SIGKILL 时用 terminal_signal。");
    }
    if (visibleToolNames.has("terminal_key")) {
      lines.push("tmux 快捷键用 terminal_key 的语义枚举，例如 tmux_split_right、tmux_split_down、tmux_new_window、tmux_detach；连续快捷键用 keys 数组。普通文本不要放进 keys，改用 terminal_write。");
    }
  }

  if (hasAnyTool(visibleToolNames, ["list_available_toolsets", "request_toolset"])) {
    lines.push("当前工具按工具集分批暴露；若发现缺少完成任务所需能力，先 list_available_toolsets，再用 request_toolset 申请补充，避免盲猜工具名。");
  }

  if (hasAnyTool(visibleToolNames, ["asset_list", "asset_media_view", "asset_send_to_chat"])) {
    lines.push("查已登记图片、视频、音频或文件时先 asset_list；发送用 asset_send_to_chat(asset_ref=...)。");
    if (hasAnyTool(visibleToolNames, ["asset_local_path", "asset_export_to_filesystem"])) {
      lines.push("需要把 asset 复制到本地目录时用 asset_export_to_filesystem。");
    }
    if (visibleToolNames.has("asset_image_transform")) {
      lines.push("需要裁剪、旋转、翻转、拉伸、改分辨率或转换图片格式时用 asset_image_transform，输出仍是新的 asset。");
    }
  }

  if (hasAnyTool(visibleToolNames, ["asset_document_overview", "asset_document_read", "asset_document_search", "asset_document_inspect"])) {
    lines.push("处理已登记文档时用 asset_document_overview 看概览和可读状态，再用 asset_document_search 定位，最后用 asset_document_read 小范围读取；需要总结或跨片段回答时用 asset_document_inspect 调文本精读模型；不要把整份文档一次性塞进上下文。");
  }

  if (hasAnyTool(visibleToolNames, ["list_live_resources", "read_download_resource", "cancel_download_resource"])) {
    lines.push("用户要求从明确 URL 下载文件时用 start_download_resource；后台下载用 list_live_resources(type=download) 查找，read_download_resource 查看状态，pause_download_resource/resume_download_resource 暂停或续传；下载完成后结果会提示可用的 asset_* 后续工具。");
  }

  if (hasAnyTool(visibleToolNames, ["asset_media_inspect", "filesystem_media_inspect"])) {
    lines.push("需要从图片、截图、表格或界面里精确读取细节时，用图片精读工具按问题查看。");
  }

  if (hasAnyTool(visibleToolNames, ["filesystem_media_view", "filesystem_send_to_chat", "filesystem_read", "filesystem_search", "filesystem_delete"])) {
    lines.push("filesystem_* 处理本地文件；本地图片查看用 filesystem_media_view，本地文件发送用 filesystem_send_to_chat。");
    if (visibleToolNames.has("filesystem_copy")) {
      lines.push("复制本地文件用 filesystem_copy；目录发送/复制暂未开放。");
    }
    if (visibleToolNames.has("filesystem_delete")) {
      lines.push("需要删除本地文件或整个目录时用 filesystem_delete；它支持删除文件或递归删除整个目录。");
    }
  }

  if (hasAnyTool(visibleToolNames, ["get_user_profile", "patch_user_profile", "list_user_memories", "upsert_user_memory", "remove_user_memory", "replace_user_memory"])) {
    lines.push("处理用户长期资料时，先看已存 user_profile 和 user_memories；结构化字段写 user_profile，其余长期偏好/边界/习惯/关系背景写 user_memories。用户要求忘记或改掉某条记忆但没给 ID 时，用 query 文本定位；若返回歧义候选，不要猜测写入。");
  }

  if (hasAnyTool(visibleToolNames, ["list_global_rules", "upsert_global_rule", "remove_global_rule"])) {
    lines.push("处理 owner 的长期执行规则时，先看已存 global_rules；只有 owner 明确提出跨任务长期生效的做事要求时，才写入 global_rules。普通用户的要求不要写成全局规则。");
  }

  if (hasAnyTool(visibleToolNames, ["get_persona", "patch_persona", "clear_persona_field"])) {
    if (hasAnyTool(visibleToolNames, ["patch_persona", "clear_persona_field"])) {
      lines.push("当前处于 persona 草稿编辑态；先看 get_persona，再用 patch_persona 或 clear_persona_field 修改当前会话草稿。这里改的是草稿，不是正式持久化数据。");
    } else {
      lines.push("get_persona 只用于查看当前正式 persona；本轮没有 persona 写入口，不要承诺“已经改了 persona”。需要修改时应引导进入对应配置流程。");
    }
  }

  if (hasAnyTool(visibleToolNames, ["get_rp_profile", "patch_rp_profile", "clear_rp_profile_field"])) {
    lines.push("当前处于 RP 全局资料草稿编辑态；先看 get_rp_profile，再用 patch_rp_profile 或 clear_rp_profile_field 修改当前会话草稿。这里改的是草稿，不是正式持久化数据。");
  }

  if (hasAnyTool(visibleToolNames, ["get_scenario_profile", "patch_scenario_profile", "clear_scenario_profile_field"])) {
    lines.push("当前处于当前会话 Scenario 资料草稿编辑态；先看 get_scenario_profile，再用 patch_scenario_profile 或 clear_scenario_profile_field 修改当前会话草稿。这里改的是草稿，不是正式持久化数据。");
  }

  if (hasAnyTool(visibleToolNames, ["list_toolset_rules", "upsert_toolset_rule", "remove_toolset_rule"])) {
    lines.push("只在某个工具集或工作流内部长期生效的规则写 toolset_rules；不要把跨任务通用规则误写成 toolset_rules。");
  }

  if (hasAnyTool(visibleToolNames, ["search_accessible_conversations", "get_conversation_context"])) {
    lines.push("只有当前会话上下文不够时才跨会话，且只读最小必要范围；不要把其他会话信息混成当前会话事实。");
  }

  if (hasAnyTool(visibleToolNames, ["patch_current_chat_identity", "clear_current_chat_identity"])) {
    lines.push("用户明确要求只在当前聊天改变你的名字、身份、背景、性格或语气时，使用当前聊天身份工具；不要修改全局 persona 或模式资料。群聊中只有 owner 可以写。工具成功后，本轮立即按返回的完整身份继续回复。");
  }

  lines.push(...buildScenarioHostToolHintLines(visibleToolNames));

  if (hasAnyTool(visibleToolNames, ["list_session_modes", "switch_session_mode"])) {
    lines.push("只有用户明确要求切换当前会话模式时才用模式工具；先 list_session_modes，再 switch_session_mode。");
  }

  if (visibleToolNames.has("dump_debug_literals")) {
    lines.push("只有 owner 明确要看原始调试材料时，才调用 dump_debug_literals；按 literals 顺序逐条发送，每个 literal 会单独成消息，调用后本轮会直接结束。");
  }

  if (visibleToolNames.has("end_turn_without_reply")) {
    lines.push("只有在最新一条用户消息明显只是收尾、确认收到、无需继续接话时，才调用 end_turn_without_reply；不要用它规避困难问题或拒答。");
  }

  if (visibleToolNames.has("get_current_time")) {
    lines.push("默认先用消息时间戳理解相对时间；只有需要当前精确时刻时才取当前时间。");
  }

  if (hasAnyTool(visibleToolNames, ["search_chat_targets", "delegate_message_to_chat"])) {
    lines.push("需要把消息转到别的会话时，先找目标会话，再委派消息；不要猜 sessionId。");
  }

  if (hasAnyTool(visibleToolNames, [
    "search_friends",
    "search_joined_groups",
    "set_chat_permission",
    "list_pending_friend_requests",
    "list_pending_group_requests",
    "respond_request",
    "create_scheduled_job",
    "list_scheduled_jobs",
    "manage_scheduled_job"
  ])) {
    lines.push("管理类工具只在 owner 明确要求时使用。");
  }

  if (hasAnyTool(visibleToolNames, [
    "create_scheduled_job",
    "list_scheduled_jobs",
    "manage_scheduled_job"
  ])) {
    lines.push("只有在 owner 明确要求未来某时提醒、延后处理或定期执行时，才创建计划任务。");
    lines.push("create_scheduled_job 的 instruction 要写成触发当时能独立执行的完整任务；不要依赖“刚才这轮对话”的隐含上下文。");
  }

  return lines;
}
