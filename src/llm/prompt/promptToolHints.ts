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
    lines.push("只有问题依赖最新外部信息时再查网页；需要 Google grounding 时用 ground_with_google_search，需要更可控的网页检索时用 search_with_iqs_lite_advanced；拿到 ref_id 后再 open_page；后续优先复用已有 browser resource_id。");
    lines.push("浏览器任务默认会复用当前会话的持久化登录态；需要看验证码、局部表单或登录结果时，优先用 capture_screenshot 并传 target_id（局部截图），必要时再截整页。");
    lines.push("做网页交互前优先先 inspect_page 看当前 elements；有稳定 target_id 时优先用 target_id，页面跳转、刷新、弹层变化后先重新 inspect_page。");
    lines.push("看 elements 时优先关注 label、kind、why_selected、has_image、in_main_content 这些摘要字段；它们比原始 tag/text 更适合判断该点哪里。");
    lines.push("新开 browser 页面或 shell 会话时，若后续还要复用，优先在 open_page 或 shell_run 里填写 description，简短说明这个资源是做什么的。");
    lines.push("interact_with_page 不只是点链接，也可用于输入搜索框、上传文件、提交表单、勾选选项、下拉选择、键盘按键和导航；文本输入用 text，文件上传用 file_paths；目标描述模糊时先用 target 语义定位，若返回多个候选再改用 target_id；遇到 iframe 或元素定位不稳定时，可对 click/hover 改用 coordinate 坐标。");
    lines.push("需要把网页上的图片、视频或其他链接资源存进工作区时，用 download_asset；能直接给 url，也能给已打开页面的 resource_id 加 target_id。");
    lines.push("遇到短信码、邮箱码、TOTP 或二次验证时，应直接在当前会话向用户索取验证码；验证码只用于当前验证步骤，不要写入长期记忆、用户资料或 persona。");
  }

  if (hasAnyTool(visibleToolNames, ["shell_run", "shell_interact", "shell_read", "shell_signal", "list_live_resources"])) {
    lines.push("需要继续操作浏览器或 shell 时，先列出现有 live_resource，再复用已有 resource_id；只有不存在合适资源时才新开。live_resource 不是工作区文件。");
  }

  if (hasAnyTool(visibleToolNames, ["list_available_toolsets", "request_toolset"])) {
    lines.push("当前工具按工具集分批暴露；若发现缺少完成任务所需能力，先 list_available_toolsets，再用 request_toolset 申请补充，避免盲猜工具名。");
  }

  if (hasAnyTool(visibleToolNames, ["chat_file_list", "chat_file_view_media", "chat_file_send_to_chat"])) {
    lines.push("需要找已登记的图片、视频、音频或文件时，先调 chat_file_list；默认不会列出 chat_message 来源，除非你显式传 origin。");
    lines.push("发送已登记文件时优先用 chat_file_send_to_chat(file_ref=...)；file_id 只是稳定主键。");
  }

  if (hasAnyTool(visibleToolNames, ["local_file_view_media", "local_file_send_to_chat", "local_file_read", "local_file_search_items"])) {
    lines.push("local_file_* 处理本地路径；相对路径走本地文件根目录，绝对路径是否允许由 localFileAccess 控制。");
    lines.push("本地图片查看用 local_file_view_media，本地路径发送用 local_file_send_to_chat。");
  }

  if (hasAnyTool(visibleToolNames, ["get_user_profile", "remember_user_profile", "read_memory", "write_memory", "remove_memory"])) {
    lines.push("处理用户长期资料时，先看已存 profile 和 user memories；优先依据用户本人明确自述，避免重复或冲突。结构化字段优先写 profile，其余再写 user memory。");
  }

  if (hasAnyTool(visibleToolNames, ["read_memory", "write_memory", "remove_memory"])) {
    lines.push("处理 owner 的长期执行规则时，先看已存 global memories；只有 owner 明确提出今后都要遵守的做事要求时，才写入 global memory。普通用户的长期做事要求不要写成全局规则。");
  }

  if (hasAnyTool(visibleToolNames, ["read_memory", "write_memory", "remove_memory"])) {
    lines.push("当 owner 明确提出长期生效的人设、口吻、身份设定、角色边界或角色扮演补充时，应视为 persona 修改请求；先用 read_memory(scope=persona) 查看当前内容，再用 write_memory(scope=persona, personaPatch=...) 写入对应字段。若你最终回复里说了“记下了”“以后按这个来”“已经写进 persona”，本轮之前必须已经实际完成写入。");
    lines.push("以下表达通常表示应写 persona：把这个身份设定记下来、以后按这个人设说话、这是角色设定、把这个写进 persona、以后都用这种口吻、别突破这个角色边界。");
  }

  if (hasAnyTool(visibleToolNames, ["search_accessible_conversations", "get_conversation_context"])) {
    lines.push("只有当前会话上下文不够，且确实需要跨会话补充时，才查看可访问会话。");
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
