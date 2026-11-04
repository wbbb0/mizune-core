# 腾讯官方 Bot 接入

## 范围与边界

`qqOfficial` 与 `onebot` 独立配置。修改官方连接凭据或启用状态后需重启进程，运行中的连接持有创建时的配置快照，避免身份与授权漂移。官方连接接收 `C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`，全量群消息不进入会话处理。机器人 @ 判定来自已验证的事件类型，不依赖正文或 mentions。群正文可能已被平台移除 @ 前缀。

规范化入站消息位于 `services/messaging/incomingMessage.ts`；连接器位于 `services/qqOfficial`，统一投递入口为 `DeliveryCoordinator`。官方消息不伪造成 OneBot 事件。会话使用 `qq_official.<AppID>:p:<openid>`、`qq_official.<AppID>:g:<group_openid>`，平台消息引用保留字符串 ID 和连接维度。

## 回复授权

每次官方输入产生固定目标的运行时回复授权，随排队消息保留；不存入 transcript、不借用会话最新消息授权。文字和工具媒体共享序号与预算。官方群仅被动回复，过期或次数耗尽不自动降级主动消息。上传不直接发送。

官方指令回复不启用自动撤回；OneBot 继续在一分钟后自动撤回指令回复。手动 `.retract` 与自动撤回独立。

## 私聊流式

普通正文使用显式不可逆增量回调；开始提交后不再自动切换候选模型或重放协议恢复。结构化输出及实际启用原生搜索的候选需要最终验证和引用后处理，因此验证完成后投递。

原生文本流独立于 Web 草稿，串行提交正文分片并显式结束。插话使旧输出版本失效，只丢弃本地尚未提交的内容，保留已开始的工具计算。已提交请求成功表示平台接受，不表示客户端已经显示；网络超时可能产生结果未知，不能更换序号盲目重发。无法保证清除平台内部待下发正文。

## 会话发送节奏与身份

`pacingPreferences.outbound` 为会话级设置。创建时 OneBot 默认 `humanized`，Web、官方默认 `immediate`。这是出站模拟人工间隔，与输入 debounce、平台频控和流式合并相互独立。旧会话的设置经持久化结构迁移保留。

同一内部用户可明确绑定多个外部身份。身份反查必须指定连接，官方群成员和私聊默认隔离，不凭昵称或相同 ID 自动合并。官方管理者经已认证管理入口绑定，不能通过首条私聊自动取得管理权限。

## 联调要求

默认测试使用假网关和假 HTTP，不读正式实例数据。发布前用专用测试机器人核实账号权限、C2C 回复时效（官方正文与字段说明有差异）、流续片与结束是否计次数、结束流的空正文语义、首片响应丢失、取消后平台 Pending 行为、文件上传编码与支持格式。未完成上述联调不得宣称真实账号收发已验证。

官方参考：[群 @ 事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)、[私聊原生流式](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)。
