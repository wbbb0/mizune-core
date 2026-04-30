function hasAnyTool(visibleToolNames: Set<string>, toolNames: string[]): boolean {
  return toolNames.some((name) => visibleToolNames.has(name));
}

export function buildToolHintLines(visibleToolNamesInput: string[] | undefined): string[] {
  const visibleToolNames = new Set((visibleToolNamesInput ?? []).filter(Boolean));
  if (visibleToolNames.size === 0) {
    return [];
  }

  const lines: string[] = [];

  if (hasAnyTool(visibleToolNames, ["view_message", "view_forward_record", "chat_file_view_media", "local_file_view_media"])) {
    lines.push("需要展开消息、转发或图片引用时再调用查看工具；message_id、forward_id、image_id 必须逐字复制。");
  }

  if (hasAnyTool(visibleToolNames, ["view_current_group_info", "list_current_group_announcements", "list_current_group_members"])) {
    lines.push("当前群工具只能读取本会话所在群；查询群公告或群成员时用 query 缩小范围，并设置合理 limit。");
  }

  if (visibleToolNames.has("generate_image_with_comfyui")) {
    lines.push("generate_image_with_comfyui 是异步工具：调用后不会立刻拿到图片，系统会在完成后把对应的 workspace file_id、file_ref 和 chat_file_path 再交还给你。");
    lines.push("收到 ComfyUI 完成通知后，你要自己判断下一步：先 chat_file_view_media 看图、直接 chat_file_send_to_chat 发图、继续改 prompt 再生成，或结束本轮。");
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
    lines.push(`只有问题依赖最新外部信息或网页状态时再查网页${searchHints.length > 0 ? `；${searchHints.join("；")}` : ""}。`);
    if (hasAnyTool(visibleToolNames, ["inspect_page", "interact_with_page"])) {
      lines.push("网页交互前先 inspect_page；页面跳转、刷新或弹层变化后重新 inspect；有稳定 target_id 时优先用 target_id。");
    }
    if (visibleToolNames.has("capture_screenshot")) {
      lines.push("需要看验证码、局部表单或登录结果时，用 capture_screenshot(target_id) 截局部，必要时再截整页。");
    }
    if (hasAnyTool(visibleToolNames, ["download_asset", "capture_screenshot"])) {
      const fileTools = [
        visibleToolNames.has("download_asset") ? "download_asset" : "",
        visibleToolNames.has("capture_screenshot") ? "capture_screenshot" : ""
      ].filter(Boolean).join("/");
      lines.push(`${fileTools} 返回 workspace file_id/file_ref；后续用 chat_file_* 查看或发送。`);
    }
    lines.push("遇到短信码、邮箱码、TOTP 或二次验证时，在当前会话向用户索取；验证码只用于当前步骤，不写入长期资料。");
  }

  if (hasAnyTool(visibleToolNames, ["terminal_list", "terminal_run", "terminal_start", "terminal_read", "terminal_write", "terminal_key", "terminal_signal", "terminal_stop"])) {
    lines.push("需要继续终端任务时，先 terminal_list 看现有 terminal resource，再复用已有 resource_id；只有不存在合适资源时才新开。");
    if (visibleToolNames.has("terminal_run")) {
      lines.push("短命令用 terminal_run；若 timeout_ms 超时，命令会自动转入后台并返回 resource_id，系统会在完成或可能等待输入时再触发你继续处理。");
    }
    if (visibleToolNames.has("terminal_start")) {
      lines.push("长任务、watch/dev server 或交互程序用 terminal_start；发送文本用 terminal_write，发送 Enter/Tab/Ctrl-C/Ctrl-D/方向键等用 terminal_key，需要 SIGINT/SIGTERM/SIGKILL 时用 terminal_signal。");
      lines.push("后台 terminal 完成触发时，先根据触发里携带的输出判断结果；等待输入触发只是“可能需要输入”，不确定时先问用户。");
    }
    if (visibleToolNames.has("terminal_key")) {
      lines.push("tmux 快捷键用 terminal_key 的语义枚举，例如 tmux_split_right、tmux_split_down、tmux_new_window、tmux_detach；连续快捷键用 keys 数组。普通文本不要放进 keys，改用 terminal_write。");
    }
  }

  if (hasAnyTool(visibleToolNames, ["list_available_toolsets", "request_toolset"])) {
    lines.push("当前工具按工具集分批暴露；若发现缺少完成任务所需能力，先 list_available_toolsets，再用 request_toolset 申请补充，避免盲猜工具名。");
  }

  if (hasAnyTool(visibleToolNames, ["chat_file_list", "chat_file_view_media", "chat_file_send_to_chat"])) {
    lines.push("查已登记图片、视频、音频或文件时先 chat_file_list；发送时优先用 chat_file_send_to_chat(file_ref=...)，file_id 只是主键。");
  }

  if (hasAnyTool(visibleToolNames, ["chat_file_inspect_media", "local_file_inspect_media"])) {
    lines.push("需要从图片、截图、表格或界面里精确读取细节时，用图片精读工具按问题查看。");
  }

  if (hasAnyTool(visibleToolNames, ["local_file_view_media", "local_file_send_to_chat", "local_file_read", "local_file_search", "local_file_delete"])) {
    lines.push("local_file_* 处理模型可访问的本地文件工作区；path 传相对路径时，相对的是配置里的 local files 工作区根目录，不是 shell 当前目录、不是仓库根目录、也不是 chat file 的 chat_file_path。");
    lines.push("本地图片查看用 local_file_view_media，本地路径发送用 local_file_send_to_chat。");
    if (visibleToolNames.has("local_file_delete")) {
      lines.push("需要删除本地文件或整个目录时用 local_file_delete；它支持删除文件或递归删除整个目录。");
    }
  }

  if (hasAnyTool(visibleToolNames, ["get_user_profile", "patch_user_profile", "list_user_memories", "upsert_user_memory", "remove_user_memory"])) {
    lines.push("处理用户长期资料时，先看已存 user_profile 和 user_memories；结构化字段写 user_profile，其余长期偏好/边界/习惯/关系背景写 user_memories。");
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
    lines.push("当前处于 Scenario 全局资料草稿编辑态；先看 get_scenario_profile，再用 patch_scenario_profile 或 clear_scenario_profile_field 修改当前会话草稿。这里改的是草稿，不是正式持久化数据。");
  }

  if (hasAnyTool(visibleToolNames, ["list_toolset_rules", "upsert_toolset_rule", "remove_toolset_rule"])) {
    lines.push("只在某个工具集或工作流内部长期生效的规则写 toolset_rules；不要把跨任务通用规则误写成 toolset_rules。");
  }

  if (hasAnyTool(visibleToolNames, ["search_accessible_conversations", "get_conversation_context"])) {
    lines.push("只有当前会话上下文不够时才跨会话，且只读最小必要范围；不要把其他会话信息混成当前会话事实。");
  }

  if (hasAnyTool(visibleToolNames, ["get_scenario_state", "update_scenario_state", "set_current_location", "manage_objective", "manage_inventory", "append_world_fact"])) {
    lines.push("场景状态工具用于 scenario_host 内部维护；先 get_scenario_state 再按需更新，不要把完整结构化状态原样念给玩家。");
  }

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
